import { describe, expect, it } from 'vitest';

import {
  BINARY_EXTENSIONS,
  getFileExtension,
  getRichDocKind,
  isImageFile,
  isImageMimeType,
  isPreviewable,
  isRichDocPreviewable,
  RICH_DOC_EXTENSIONS,
} from './fileTypes';

describe('fileTypes — extension + MIME detection', () => {
  it('getFileExtension lowercases, drops the dot, handles multi-dot + extensionless', () => {
    expect(getFileExtension('Report.PDF')).toBe('pdf');
    expect(getFileExtension('archive.tar.gz')).toBe('gz');
    expect(getFileExtension('.env')).toBe('env');
    // No dot → split('.').pop() returns the whole (lowercased) name.
    expect(getFileExtension('Makefile')).toBe('makefile');
  });

  it('isImageFile matches known image extensions case-insensitively', () => {
    expect(isImageFile('photo.PNG')).toBe(true);
    expect(isImageFile('a.b.jpeg')).toBe(true);
    expect(isImageFile('notes.txt')).toBe(false);
    expect(isImageFile('archive.pdf')).toBe(false);
  });

  it('isImageMimeType accepts the allowlist and any image/* subtype', () => {
    expect(isImageMimeType('image/png')).toBe(true);
    expect(isImageMimeType('image/heic')).toBe(true); // image/* prefix branch
    expect(isImageMimeType('application/pdf')).toBe(false);
    expect(isImageMimeType('text/plain')).toBe(false);
  });
});

describe('fileTypes — text previewability (binary-blocklist strategy)', () => {
  it('treats extensionless files and dotfiles as text-previewable', () => {
    expect(isPreviewable('Makefile')).toBe(true);
    expect(isPreviewable('Dockerfile')).toBe(true);
    expect(isPreviewable('.gitignore')).toBe(true);
    expect(isPreviewable('.env.dev')).toBe(true);
  });

  it('rejects known binary extensions', () => {
    expect(isPreviewable('app.exe')).toBe(false);
    expect(isPreviewable('clip.mp4')).toBe(false);
    expect(isPreviewable('font.woff2')).toBe(false);
  });

  it('treats unknown / source extensions as text', () => {
    expect(isPreviewable('main.rs')).toBe(true);
    expect(isPreviewable('.tool-versions')).toBe(true);
  });
});

describe('fileTypes — rich-document routing', () => {
  it('maps each rich-doc extension to its sub-viewer kind', () => {
    expect(getRichDocKind('q3.pdf')).toBe('pdf');
    expect(getRichDocKind('memo.docx')).toBe('docx');
    expect(getRichDocKind('budget.xlsx')).toBe('sheet');
    expect(getRichDocKind('legacy.xls')).toBe('sheet'); // xlsx + xls collapse to sheet
    expect(getRichDocKind('deck.pptx')).toBe('pptx');
    expect(getRichDocKind('notes.txt')).toBeNull();
    // Legacy OLE / csv are deliberately NOT rich-doc previewable.
    expect(getRichDocKind('old.doc')).toBeNull();
    expect(getRichDocKind('data.csv')).toBeNull();
  });

  it('isRichDocPreviewable is consistent with getRichDocKind, case-insensitively', () => {
    for (const ext of RICH_DOC_EXTENSIONS) {
      expect(isRichDocPreviewable(`file.${ext}`)).toBe(true);
      expect(getRichDocKind(`file.${ext}`)).not.toBeNull();
    }
    expect(isRichDocPreviewable('Q3.PDF')).toBe(true);
    expect(getRichDocKind('Slides.PPTX')).toBe('pptx');
    expect(isRichDocPreviewable('notes.txt')).toBe(false);
  });

  // Load-bearing routing invariant: rich-doc extensions MUST also live in the
  // binary blocklist so isPreviewable() rejects them. DirectoryPanel checks
  // isRichDocPreviewable BEFORE isPreviewable; if a rich-doc ext were dropped
  // from BINARY_EXTENSIONS it would wrongly fall through to the text viewer.
  it('every rich-doc extension is also a binary extension (text preview must reject it)', () => {
    for (const ext of RICH_DOC_EXTENSIONS) {
      expect(BINARY_EXTENSIONS.has(ext), `${ext} must be in BINARY_EXTENSIONS`).toBe(true);
      expect(isPreviewable(`file.${ext}`), `${ext} must NOT be text-previewable`).toBe(false);
    }
  });
});
