/**
 * Image resize pipeline (sharp / libvips).
 *
 * v0.2.1 — replaced pure-JS Jimp + @jimp/wasm-webp with `sharp` (libvips native).
 * Jimp decoded/encoded synchronously on the Node event loop, which blocked the
 * Sidecar's HTTP/SSE/stdio under large images (symptom: "stuck at image cropping").
 * Sharp runs on libvips' off-thread native pool, reads metadata before decode
 * (decompression-bomb guard via `limitInputPixels`), and supports WebP natively
 * (Jimp's wasm-webp loader used `fetch(file://)` which Node's undici refuses,
 * silently breaking WebP post Bun→Node migration). Upstream Claude Code uses
 * sharp too; this module mirrors that decision.
 *
 * sharp is loaded lazily via absolute-path dynamic import (see `getSharp()` below)
 * because esbuild cannot bundle its per-platform native addons; build scripts
 * stage `node_modules/sharp` + `@img/sharp-<triple>` into
 * `src-tauri/resources/sharp-runtime/` and `getBundledSharpEntryPoint()` resolves
 * the runtime path (prod vs dev).
 */

import { createRequire } from 'module';
import type { Sharp, SharpOptions } from 'sharp';
import type { ImagePayload } from '../../shared/types/image';
import { getBundledSharpEntryPoint } from './runtime';

/** Claude API recommends ≤1568px on both sides; larger images are auto-shrunk by the API, wasting bandwidth and TTFT. */
const MAX_DIMENSION = 1568;
/** Aspect-ratio threshold: images with longEdge/shortEdge >= this are treated as "super-long" and sliced. */
const LONG_IMAGE_RATIO = 3;
/** Maximum number of tiles when slicing a super-long image. */
const MAX_TILES = 8;
/**
 * Pre-decode fast-reject ceiling. Anthropic's actual API limit is ~5 MB base64;
 * anything above this we still try to resize (the resize pipeline brings it
 * under the API limit). Only reject above 64 MB to cap worst-case decode time.
 */
const MAX_BASE64_LENGTH = 64 * 1024 * 1024;
/** Post-resize target: stay under Claude API's ~5 MB base64 limit (3.75 MB raw = ~5 MB base64). */
const API_TARGET_RAW_SIZE = 3.75 * 1024 * 1024;
/** JPEG quality ladder used when a resize's encoded output still exceeds API_TARGET_RAW_SIZE. */
const JPEG_FALLBACK_QUALITIES = [80, 60, 40, 20] as const;
/** Decompression-bomb guard: max pixels libvips will decode (sharp default is 268M; we tighten to 30M). */
const PIXEL_LIMIT = 30_000_000;
/** Default per-image wall-clock deadline (ms). Covers worst-case 1000×50000 PNG multi-tile encode. */
const DEFAULT_TIMEOUT_MS = 30_000;

// ─── sharp lazy loader ──────────────────────────────────────────────────────
// sharp is not imported statically: esbuild would bundle the JS and then fail
// at runtime to find `@img/sharp-<triple>/sharp.node` (dynamic require with
// a computed path, preserved as-is but needs the @img tree on-disk). Instead
// we load sharp via createRequire + absolute path on first call and cache it.

// Use sharp's real SharpOptions type surface rather than a locally-truncated
// subset — future option additions (e.g. `animated: true` for GIF support)
// then get type-checked instead of silently skipped.
type SharpFactory = (input: Buffer | Uint8Array, options?: SharpOptions) => Sharp;

let cachedSharp: SharpFactory | null = null;
let sharpLoadError: Error | null = null;

function loadSharp(): SharpFactory {
  if (cachedSharp) return cachedSharp;
  if (sharpLoadError) throw sharpLoadError;
  const entry = getBundledSharpEntryPoint();
  if (!entry) {
    sharpLoadError = new Error(
      'sharp module not found — image processing is unavailable. ' +
      'Expected sharp-runtime/node_modules/sharp (production) or node_modules/sharp (dev).'
    );
    throw sharpLoadError;
  }
  try {
    // createRequire resolves absolute paths; sharp's own relative requires
    // (./libvips) and dynamic require (@img/sharp-<triple>/sharp.node) then
    // resolve from the loaded file's node_modules tree automatically.
    const nodeRequire = createRequire(import.meta.url);
    cachedSharp = nodeRequire(entry) as SharpFactory;
    return cachedSharp;
  } catch (err) {
    sharpLoadError = err instanceof Error ? err : new Error(String(err));
    throw sharpLoadError;
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

/** MCP protocol image content block */
type McpImageContent = { type: 'image'; data: string; mimeType: string };
/** MCP protocol text content block */
type McpTextContent = { type: 'text'; text: string };
/** MCP tool result content block (subset of MCP protocol types) */
type McpContentBlock = McpImageContent | McpTextContent | { type: string; [key: string]: unknown };

/** Output MIME types we can encode with sharp (GIF is decode-only; animated frames are flattened to PNG). */
type EncodableMime = 'image/jpeg' | 'image/png' | 'image/webp';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** GIF→PNG (drops animation). Other unsupported encodes normalize to PNG too. */
function pickOutputMime(inputMime: string): EncodableMime {
  if (inputMime === 'image/jpeg' || inputMime === 'image/jpg') return 'image/jpeg';
  if (inputMime === 'image/webp') return 'image/webp';
  // png / gif / bmp / tiff / heic / avif / svg / unknown → png (lossless, universally API-accepted)
  return 'image/png';
}

/** Encode a sharp pipeline into the target format with sensible defaults. */
async function encodeToBuffer(pipeline: Sharp, mime: EncodableMime, jpegQuality = 92): Promise<Buffer> {
  switch (mime) {
    case 'image/jpeg':
      return pipeline.jpeg({ quality: jpegQuality, mozjpeg: true }).toBuffer();
    case 'image/webp':
      return pipeline.webp({ quality: jpegQuality }).toBuffer();
    case 'image/png':
    default:
      // compressionLevel 8 balances size vs speed (sharp default 6).
      return pipeline.png({ compressionLevel: 8 }).toBuffer();
  }
}

/**
 * Encode with progressive quality fallback if the result exceeds the API target size.
 * Strategy (mirrors upstream claude-code's imageResizer.ts):
 *   1. First pass at default quality (92).
 *   2. If output > API_TARGET_RAW_SIZE and format is JPEG/WebP: retry at 80 → 60 → 40 → 20.
 *   3. If still oversized (rare — means dimensions are already capped), return the smallest attempt.
 *
 * @param buildPipe  Factory that returns a FRESH sharp pipeline each call (pipelines are single-use).
 * @returns The best buffer achieved. Caller decides whether to surface size warning.
 */
async function encodeWithSizeBudget(
  buildPipe: () => Sharp,
  mime: EncodableMime,
): Promise<{ buffer: Buffer; quality: number }> {
  let best = await encodeToBuffer(buildPipe(), mime, 92);
  let bestQuality = 92;
  // PNG has no quality knob → single-pass. GIF shouldn't reach here (pickOutputMime drops it).
  if (mime !== 'image/jpeg' && mime !== 'image/webp') {
    return { buffer: best, quality: bestQuality };
  }
  if (best.length <= API_TARGET_RAW_SIZE) {
    return { buffer: best, quality: bestQuality };
  }
  for (const q of JPEG_FALLBACK_QUALITIES) {
    const attempt = await encodeToBuffer(buildPipe(), mime, q);
    if (attempt.length <= API_TARGET_RAW_SIZE) {
      return { buffer: attempt, quality: q };
    }
    // Keep the smallest we've seen so far.
    if (attempt.length < best.length) {
      best = attempt;
      bestQuality = q;
    }
  }
  return { buffer: best, quality: bestQuality };
}

/**
 * Run an image op with an AbortSignal and wall-clock deadline. The op itself is already off-thread (libvips).
 *
 * Leak-safety: the success path (`op()` resolves first) MUST explicitly remove the abort listener —
 * `{ once: true }` only self-removes when the listener FIRES. Without explicit cleanup, every
 * completed resize during a long SDK turn leaves a listener attached to the turn-level AbortSignal
 * → MaxListenersExceededWarning + unbounded memory on cron / IM sessions.
 */
async function withDeadline<T>(
  op: () => Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (signal?.aborted) throw new Error(`aborted before ${label}`);
  let timer: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        abortHandler = () => reject(new Error(`aborted during ${label}`));
        signal.addEventListener('abort', abortHandler, { once: true });
      })
    : null;
  try {
    const work = op();
    return abortPromise
      ? await Promise.race([work, deadline, abortPromise])
      : await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
  }
}

/** Build a sharp pipeline from base64 data with decompression-bomb guard. */
function buildPipeline(buffer: Buffer): Sharp {
  if (buffer.length === 0) {
    // Upstream claude-code pattern: explicit empty-buffer error. Otherwise sharp throws
    // "Input buffer contains unsupported image format" which is much harder to diagnose.
    throw new Error('图片数据为空（0 字节）');
  }
  const sharp = loadSharp();
  return sharp(buffer, {
    limitInputPixels: PIXEL_LIMIT,
    // failOn='error' tolerates decoder *warnings* (e.g. malformed but recoverable chunks)
    // while still aborting on real decode errors. Sharp's default is 'warning' (strictest)
    // which would reject many in-the-wild screenshots; we trade strictness for robustness.
    failOn: 'error',
  });
}

/**
 * Map sharp / libvips error messages to user-friendly Chinese strings.
 * Upstream claude-code has a 8-category `classifyImageError` used for analytics grouping —
 * ZhiShi only needs UX mapping, so this is intentionally small.
 * Returns the original message unchanged if no pattern matches (surfaces to unified log).
 *
 * Exported for the user-upload broadcast path in agent-session.ts so users see Chinese
 * errors regardless of which code path caught the failure.
 */
export function classifyImageError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/exceeds pixel limit|pixel limit/i.test(raw)) return '图片像素过多（解压后超过 30M 像素），请压缩后重试';
  if (/unsupported image format|Unable to determine image format/i.test(raw)) return '不支持的图片格式';
  if (/corrupt|premature end|truncated/i.test(raw)) return '图片数据损坏或不完整';
  if (/out of memory|Cannot allocate|ENOMEM/i.test(raw)) return '图片处理内存不足';
  if (/timeout/i.test(raw)) return '图片处理超时';
  if (/图片/.test(raw)) return raw; // already Chinese — pass through
  return raw;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
/**
 * Process a user-uploaded image for the Claude API.
 * - Normal images: resize inline → returns 1-element array.
 * - Super-long images (aspect ratio ≥ 3:1 and long edge > MAX_DIMENSION): slice into 1:2 tiles
 *   along the long axis using sharp's native `extract()` (region decode, no full clone).
 *
 * Throws on: oversized base64, decompression bomb, unsupported/corrupt input, abort, timeout.
 * Callers surface the error to the user rather than silently sending an oversized payload.
 */
export async function processImage(
  img: ImagePayload,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ImagePayload[]> {
  return processImageInternal(img, /*allowSlice*/ true, signal, timeoutMs);
}

async function processImageInternal(
  img: ImagePayload,
  allowSlice: boolean,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<ImagePayload[]> {
  // Fast-reject: base64 upper bound BEFORE any decode work.
  if (img.data.length > MAX_BASE64_LENGTH) {
    const sizeMB = (img.data.length / 1024 / 1024).toFixed(1);
    throw new Error(`图片过大（${sizeMB} MB），请压缩后重试`);
  }

  return withDeadline(async () => {
    const buffer = Buffer.from(img.data, 'base64');
    const meta = await buildPipeline(buffer).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (!width || !height) {
      throw new Error(`无法识别图片尺寸（${img.name}）`);
    }

    const outputMime = pickOutputMime(img.mimeType);
    const shortEdge = Math.min(width, height);
    const longEdge = Math.max(width, height);
    const isVertical = height > width;

    // ── Non-super-long path: single resize ────────────────────────────────
    if (!allowSlice || longEdge / shortEdge < LONG_IMAGE_RATIO || longEdge <= MAX_DIMENSION) {
      const needResize = width > MAX_DIMENSION || height > MAX_DIMENSION;
      const needTranscode = outputMime !== img.mimeType; // e.g. gif→png, jpg→jpeg
      if (!needResize && !needTranscode) {
        return [img]; // original already fits and is API-acceptable
      }
      const { buffer: outBuffer, quality } = await encodeWithSizeBudget(
        () => (needResize
          ? buildPipeline(buffer).resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
          : buildPipeline(buffer)),
        outputMime,
      );
      console.log(
        `[image-resize] Resized ${img.name}: ${width}x${height} → ${outputMime} q${quality}, ${outBuffer.length} bytes`
      );
      return [{ name: img.name, mimeType: outputMime, data: outBuffer.toString('base64') }];
    }

    // ── Super-long path: 1:2 tiles via extract() ──────────────────────────
    // Note on region decode: sharp's extract() applies region clipping in the pipeline.
    // For JPEG/WebP/TIFF libvips can shrink-on-load + region-decode (memory-efficient);
    // for PNG the full image must be decoded (PNG is not random-access), but the decoded
    // buffer stays off the JS heap in libvips memory, so we still avoid Jimp's JS-heap
    // amplification from clone(). Worst case for a 29M-pixel PNG tile is ~140MB peak.
    const tileTarget = shortEdge * 2;
    let tileCount = Math.ceil(longEdge / tileTarget);
    tileCount = Math.min(tileCount, MAX_TILES);
    const tileSize = Math.ceil(longEdge / tileCount);
    // 10% overlap, applied only at tile start (for tiles after the first).
    const overlap = Math.round(tileSize * 0.1);

    const tiles: ImagePayload[] = [];
    for (let i = 0; i < tileCount; i++) {
      if (signal?.aborted) throw new Error('aborted during tile encode');
      const start = Math.max(0, i * tileSize - (i > 0 ? overlap : 0));
      const end = Math.min(longEdge, (i + 1) * tileSize);
      const extractRegion = isVertical
        ? { left: 0, top: start, width, height: end - start }
        : { left: start, top: 0, width: end - start, height };

      // Fresh pipeline per tile — sharp pipelines are single-use after toBuffer().
      const { buffer: outBuffer } = await encodeWithSizeBudget(
        () => buildPipeline(buffer)
          .extract(extractRegion)
          .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true }),
        outputMime,
      );

      tiles.push({
        name: `${img.name}_tile_${i + 1}`,
        mimeType: outputMime,
        data: outBuffer.toString('base64'),
      });
    }

    console.log(
      `[image-resize] Sliced ${img.name}: ${width}x${height} → ${tileCount} tiles (${isVertical ? 'vertical' : 'horizontal'})`
    );
    return tiles;
  }, signal, timeoutMs, `processImage(${img.name})`);
}

/**
 * Resize oversized images in MCP tool result content blocks.
 * Returns a shallow-copied tool_response with resized images, or null if unchanged.
 *
 * MCP tool results use the format: { content: [{ type: "image", data: "base64...", mimeType: "image/png" }, ...] }
 *
 * Unlike user uploads: on failure we REPLACE the image block with a text placeholder
 * instead of throwing (the AI still gets a turn, just without the broken screenshot).
 */
export async function resizeToolImageContent(
  toolResponse: unknown,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Record<string, unknown> | null> {
  if (
    typeof toolResponse !== 'object' ||
    toolResponse === null ||
    !Array.isArray((toolResponse as { content?: unknown }).content)
  ) {
    return null;
  }

  const originalContent = (toolResponse as { content: McpContentBlock[] }).content;
  const content = [...originalContent]; // shallow copy — don't mutate SDK input
  let modified = false;

  for (let i = 0; i < content.length; i++) {
    if (signal?.aborted) {
      // Abort mid-scan: leave remaining blocks untouched, return what we have so far.
      break;
    }
    const block = content[i];
    if (block.type !== 'image' || !('data' in block) || typeof block.data !== 'string') {
      continue;
    }

    if (block.data.length > MAX_BASE64_LENGTH) {
      console.warn(
        `[image-resize] Tool image block ${i} too large (${(block.data.length / 1024 / 1024).toFixed(1)} MB base64), replacing with text`
      );
      content[i] = { type: 'text', text: '[Image too large to process — stripped to prevent API error]' } as McpTextContent;
      modified = true;
      continue;
    }

    try {
      // Capture narrowed types into locals — async closure below would otherwise
      // widen `block.data` back to `unknown` (McpContentBlock's index-signature arm).
      const blockData: string = block.data;
      const mimeType = ('mimeType' in block && typeof block.mimeType === 'string') ? block.mimeType : 'image/png';
      const outputMime = pickOutputMime(mimeType);

      const resized: { data: string; mimeType: EncodableMime } | null = await withDeadline(async () => {
        const buffer = Buffer.from(blockData, 'base64');
        const meta = await buildPipeline(buffer).metadata();
        const width = meta.width ?? 0;
        const height = meta.height ?? 0;
        if (!width || !height) throw new Error('unknown dimensions');

        const needResize = width > MAX_DIMENSION || height > MAX_DIMENSION;
        const needTranscode = outputMime !== mimeType;
        if (!needResize && !needTranscode) return null; // signal "unchanged"

        const { buffer: outBuffer, quality } = await encodeWithSizeBudget(
          () => (needResize
            ? buildPipeline(buffer).resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
            : buildPipeline(buffer)),
          outputMime,
        );
        console.log(
          `[image-resize] Tool image resized: ${width}x${height} → ${outputMime} q${quality}, ${outBuffer.length} bytes`
        );
        return { data: outBuffer.toString('base64'), mimeType: outputMime };
      }, signal, timeoutMs, `toolImage[${i}]`);

      if (resized) {
        content[i] = { ...block, data: resized.data, mimeType: resized.mimeType };
        modified = true;
      }
    } catch (err) {
      // Resize failed — strip the oversized/corrupt image to prevent Claude API 400 error.
      // Surface classified Chinese message to the user; raw cause goes to the unified log.
      const friendly = classifyImageError(err);
      const raw = err instanceof Error ? err.message : String(err);
      console.warn(`[image-resize] Failed to resize tool image block ${i}, stripping: ${raw}`);
      content[i] = { type: 'text', text: `[图片处理失败：${friendly}]` } as McpTextContent;
      modified = true;
    }
  }

  return modified ? { ...(toolResponse as object), content } : null;
}


