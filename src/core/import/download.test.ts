import { describe, expect, it } from 'vitest';
import {
  dropFileExt,
  filenameFromContentDisposition,
  filenameFromUrl,
  parseDataUrl,
} from './download';
import { clipboardName, stripKnownExt } from './util';

describe('file names from the web', () => {
  it('reads Content-Disposition in its common shapes', () => {
    const name = filenameFromContentDisposition;
    expect(name('attachment; filename="a b.jpg"')).toBe('a b.jpg');
    expect(name('attachment; filename=plain.png')).toBe('plain.png');
    expect(name(`attachment; filename="fallback.png"; filename*=UTF-8''r%C3%A9sum%C3%A9.png`)).toBe(
      'résumé.png',
    );
    expect(name('attachment; filename="../../etc/passwd"')).toBe('passwd'); // never a folder part
    expect(name('inline')).toBeNull();
    expect(name(null)).toBeNull();
    // UTF-8 bytes that arrived decoded as latin-1 are put back.
    expect(name('attachment; filename="' + Buffer.from('café.jpg').toString('latin1') + '"')).toBe(
      'café.jpg',
    );
  });

  it('takes the last URL segment, decoded, and drops a real extension only', () => {
    expect(filenameFromUrl('https://x.example/a/pic%201.jpg?w=2')).toBe('pic 1.jpg');
    expect(filenameFromUrl('https://x.example/')).toBeNull();
    expect(dropFileExt('pic 1.jpg')).toBe('pic 1');
    expect(dropFileExt('Version 2.longextension')).toBe('Version 2.longextension');
    expect(dropFileExt('.hidden')).toBe('.hidden');
    expect(dropFileExt('Clipboard - 2026-09-28 16.10.00')).toBe('Clipboard - 2026-09-28 16.10.00');
  });

  it('parses data: URLs, base64 or not', () => {
    expect(parseDataUrl('data:image/png;base64,aGk=')).toEqual({
      mime: 'image/png',
      bytes: Buffer.from('hi'),
    });
    expect(parseDataUrl('data:image/svg+xml;utf8,%3Csvg%3E')?.bytes.toString()).toBe('<svg>');
    expect(parseDataUrl('not a data url')).toBeNull();
  });
});

describe('names we choose', () => {
  it('drops the detected extension (or an alias) from a caller-chosen name, nothing else', () => {
    expect(stripKnownExt('Photo.jpeg', 'jpg')).toBe('Photo');
    expect(stripKnownExt('Photo 1.5', 'jpg')).toBe('Photo 1.5');
    expect(stripKnownExt('scan.TIFF', 'tif')).toBe('scan');
    expect(stripKnownExt('a.png', 'jpg')).toBe('a.png');
  });

  it('names a pasted image the way Eagle does', () => {
    expect(clipboardName(new Date(2026, 8, 28, 16, 5, 9))).toBe('Clipboard - 2026-09-28 16.05.09');
  });
});
