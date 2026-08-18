import { closeSync, existsSync, openSync, readSync } from 'fs';

const DEFAULT_BUFFER_SIZE = 64 * 1024;

function isAsciiWhitespace(byte: number): boolean {
  return byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20;
}

export function countNonEmptyJsonlLines(
  filePath: string,
  bufferSize = DEFAULT_BUFFER_SIZE,
): number {
  if (!existsSync(filePath)) return 0;

  let fd: number | undefined;
  try {
    fd = openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(Math.max(1, bufferSize));
    let count = 0;
    let lineHasContent = false;

    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;

      for (let i = 0; i < bytesRead; i++) {
        const byte = buffer[i];
        if (byte === 0x0a) {
          if (lineHasContent) count++;
          lineHasContent = false;
        } else if (!isAsciiWhitespace(byte)) {
          lineHasContent = true;
        }
      }
    }

    if (lineHasContent) count++;
    return count;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}
