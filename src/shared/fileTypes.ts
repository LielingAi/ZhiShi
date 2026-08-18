/**
 * Shared file type utilities
 *
 * Used by both frontend and backend for consistent file type detection.
 */

/** Image file extensions that should be treated as image attachments (not copied to zhishi_files) */
export const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
]);

/**
 * Check if a filename represents an image file based on extension
 */
export function isImageFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Get file extension from filename (lowercase, without dot)
 */
export function getFileExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? '';
}

/**
 * Supported image MIME types for clipboard/attachment handling
 */
export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
];

/**
 * Check if a MIME type is a supported image type
 */
export function isImageMimeType(mimeType: string): boolean {
  return ALLOWED_IMAGE_MIME_TYPES.includes(mimeType) || mimeType.startsWith('image/');
}

/**
 * Known binary file extensions that cannot be previewed as text.
 * Strategy: blocklist binary → everything else is assumed text-previewable.
 * This covers far more file types than a text allowlist ever could
 * (.dev.vars, .env.dev, Makefile, LICENSE, .tool-versions, etc.).
 */
export const BINARY_EXTENSIONS = new Set([
  // Images (superset of IMAGE_EXTENSIONS — includes raw/vector formats)
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif',
  'psd', 'ai', 'eps', 'raw', 'cr2', 'nef', 'heic', 'heif', 'avif', 'jxl',
  // Video
  'mp4', 'avi', 'mov', 'mkv', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp',
  // Audio
  'mp3', 'wav', 'aac', 'ogg', 'flac', 'wma', 'm4a', 'opus', 'aiff',
  // Archives / Compressed
  'zip', 'tar', 'gz', 'bz2', 'xz', 'rar', '7z', 'zst', 'lz4', 'lzma', 'cab', 'dmg', 'iso',
  // Executables / Libraries
  'exe', 'dll', 'so', 'dylib', 'bin', 'app', 'msi', 'deb', 'rpm', 'apk', 'ipa',
  // Compiled / Object
  'o', 'obj', 'class', 'pyc', 'pyo', 'wasm', 'elc',
  // Fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // Documents (binary formats)
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf',
  // Databases
  'db', 'sqlite', 'sqlite3', 'mdb',
  // Other binary
  'dat', 'ds_store', 'swp', 'swo',
]);

/**
 * Check if a filename can be previewed as text (code / markdown / plain text).
 *
 * Uses a binary-blocklist strategy: any file that is NOT a known binary format
 * and NOT an image is considered previewable. This naturally covers dotfiles
 * (.env, .gitignore), multi-dot names (.dev.vars, .env.dev), and extensionless
 * files (Makefile, LICENSE, Dockerfile).
 */
export function isPreviewable(filename: string): boolean {
  // Extensionless files (Makefile, Dockerfile, LICENSE, etc.) are text
  const ext = getFileExtension(filename);
  if (!ext || ext === filename.toLowerCase()) return true;
  return !BINARY_EXTENSIONS.has(ext);
}

/**
 * Rich document formats that get a dedicated binary previewer (pdf.js /
 * docx-preview / SheetJS / pptx-renderer) — read-only, rendered in the
 * renderer from bytes fetched via `cmd_workspace_download_file` (base64).
 *
 * Deliberately SEPARATE from `BINARY_EXTENSIONS`: these extensions remain
 * "not text-previewable" (they stay in the binary blocklist), so the text
 * preview channel still rejects them. The routing in DirectoryPanel checks
 * `isRichDocPreviewable` BEFORE `isPreviewable`, diverting these to the rich
 * viewer. Keeping this list TS-only avoids the TS↔Rust dual-sync burden that
 * `BINARY_EXTENSIONS` carries — the download command does not gate on
 * extension, so no Rust counterpart is needed.
 *
 * Out of scope (kept on "open with default app"): legacy binary `.doc` / `.ppt`
 * (OLE, no pure-frontend parser) and `.csv` (already text-previewable).
 */
export const RICH_DOC_EXTENSIONS = new Set([
  'pdf',
  'docx',
  'xlsx',
  'xls',
  'pptx',
]);

/** Discriminator for which rich-doc sub-viewer renders a file.
 *  `xlsx` and `xls` collapse to `'sheet'` (SheetJS reads both). */
export type RichDocKind = 'pdf' | 'docx' | 'sheet' | 'pptx';

/** Whether a filename should open in the dedicated rich-document previewer. */
export function isRichDocPreviewable(filename: string): boolean {
  return RICH_DOC_EXTENSIONS.has(getFileExtension(filename));
}

/** Map a filename to its rich-doc sub-viewer kind, or `null` if unsupported. */
export function getRichDocKind(filename: string): RichDocKind | null {
  switch (getFileExtension(filename)) {
    case 'pdf':
      return 'pdf';
    case 'docx':
      return 'docx';
    case 'xlsx':
    case 'xls':
      return 'sheet';
    case 'pptx':
      return 'pptx';
    default:
      return null;
  }
}

