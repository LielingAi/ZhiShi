/**
 * Web Response helper for serving files from disk under Node.js.
 *
 * Replaces Bun's `new Response(Bun.file(path))` idiom. Bun.file returns
 * a lazy-streaming handle that Bun.serve knows how to flush directly;
 * under Node we build an equivalent Web Response from fs.createReadStream
 * via Readable.toWeb, so large files stream without being slurped into
 * memory.
 *
 * Returns null if the file does not exist (caller should 404).
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { Readable } from 'node:stream';

/**
 * Minimal extension → MIME-type map for file types we actually serve
 * (attachments, image previews, audio playback, html/js/css in skills).
 * Covers every ext Bun.file().type could return for our use cases.
 * Falls back to `application/octet-stream` for unknown extensions.
 */
const MIME_BY_EXT: Record<string, string> = {
  // text
  txt: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  // images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  // audio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  // video
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  // archives
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  // docs
  pdf: 'application/pdf',
};

/** Guess a MIME type from path extension, matching Bun.file(p).type behaviour. */
export function sniffMime(path: string): string {
  const ext = extname(path).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export interface FileResponseInit {
  status?: number;
  headers?: HeadersInit;
  /** Explicit Content-Type override (otherwise skipped; clients sniff). */
  contentType?: string;
}

/**
 * Build a Response that streams a file from disk, or return null if missing.
 * Sets Content-Length from the stat result so clients don't need to buffer.
 */
export async function fileResponse(
  absolutePath: string,
  init: FileResponseInit = {},
): Promise<Response | null> {
  let size: number;
  try {
    const st = await stat(absolutePath);
    if (!st.isFile()) return null;
    size = st.size;
  } catch {
    return null;
  }

  const nodeStream = createReadStream(absolutePath);
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;

  const headers = new Headers(init.headers);
  headers.set('Content-Length', String(size));
  if (init.contentType) headers.set('Content-Type', init.contentType);

  return new Response(webStream, {
    status: init.status ?? 200,
    headers,
  });
}

/**
 * Read a byte range from a file and return its contents as a Buffer.
 * For small in-memory operations; large streams should use fileResponse().
 */
export async function readFileBytes(
  absolutePath: string,
  start?: number,
  end?: number,
): Promise<Buffer | null> {
  try {
    await stat(absolutePath);
  } catch {
    return null;
  }
  const chunks: Buffer[] = [];
  const stream = createReadStream(absolutePath, start !== undefined ? { start, end } : undefined);
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}
