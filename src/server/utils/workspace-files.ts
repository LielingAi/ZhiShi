import { writeFile } from 'fs/promises';
import { basename, extname, join, relative } from 'path';
import { ensureDir } from './fs-utils';

export interface Base64FileEntry {
  name: string;
  content: string;
}

export interface WrittenFile {
  relativePath: string;
  absolutePath: string;
  finalName: string;
  renamed: boolean;
}

/** Hard cap so a malicious or buggy caller can't pin us in the suffix loop forever. */
const MAX_COLLISION_SUFFIX = 9999;

/**
 * Write base64-encoded files into a target directory.
 *
 * - Sanitizes the filename (strips chars that are invalid on Windows / NTFS).
 * - On filename collision, suffixes `_1`, `_2`, ... before the extension.
 * - Returns relative paths from `agentDir` so callers can build `@reference`
 *   strings without re-doing the relativization.
 *
 * Caller is responsible for ensuring `targetDir` is already validated as
 * being within `agentDir` (use `resolveAgentPath` at the route edge).
 *
 * Concurrency: uses the `wx` write flag (O_CREAT | O_EXCL) so two callers
 * racing for the same name can never silently overwrite each other. On
 * EEXIST we bump the suffix and retry, mirroring the pre-existing
 * `existsSync` loop semantics but without the TOCTOU window. This matters
 * because as of v0.2.3 both the HTTP route (`/api/files/import-base64`) and
 * the sidecar's `enqueueUserMessage` modality fallback share this writer —
 * concurrent IM Bot + Tab UI uploads with the same filename were
 * theoretically possible.
 */
export async function writeBase64FilesToAgentDir(
  files: Base64FileEntry[],
  targetDir: string,
  agentDir: string,
): Promise<WrittenFile[]> {
  await ensureDir(targetDir);

  const results: WrittenFile[] = [];

  for (const file of files) {
    const safeName = file.name.replace(/[<>:"/\\|?*]/g, '_');
    const ext = extname(safeName);
    const base = basename(safeName, ext);
    const buffer = Buffer.from(file.content, 'base64');

    let finalName = safeName;
    let counter = 0;
    let renamed = false;
    let destination = '';

    while (true) {
      destination = join(targetDir, finalName);
      try {
        await writeFile(destination, buffer, { flag: 'wx' });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
        counter++;
        if (counter > MAX_COLLISION_SUFFIX) {
          throw new Error(`Too many filename collisions for ${safeName} in ${targetDir}`);
        }
        finalName = `${base}_${counter}${ext}`;
        renamed = true;
      }
    }

    results.push({
      relativePath: relative(agentDir, destination),
      absolutePath: destination,
      finalName,
      renamed,
    });
  }

  return results;
}
