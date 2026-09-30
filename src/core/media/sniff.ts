// Work out a file's real type from its first bytes, and name it the way Eagle does
// (thumbs-palette-import 4.2): the content only overrides the file's own extension for seven
// common image types (see `resolveExt`). Probing and decoding still use the full sniff.

import { open } from 'node:fs/promises';
import { extname } from 'node:path';

/** Enough for every signature, and for `<svg` after an XML prolog. */
const HEADER_BYTES = 512;

export async function readHeader(path: string): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEADER_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

const ascii = (h: Uint8Array, off: number, len: number) =>
  Buffer.from(h.subarray(off, off + len)).toString('latin1');
const startsWith = (h: Uint8Array, ...bytes: number[]) => bytes.every((b, i) => h[i] === b);
const u16be = (h: Uint8Array, o: number) => (h[o] << 8) | h[o + 1];
const u32be = (h: Uint8Array, o: number) =>
  ((h[o] << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) >>> 0;
const u32le = (h: Uint8Array, o: number) =>
  ((h[o + 3] << 24) | (h[o + 2] << 16) | (h[o + 1] << 8) | h[o]) >>> 0;

/** The brands of an ISO-BMFF `ftyp` box (major first), or null if this isn't one. */
export function ftypBrands(h: Uint8Array): string[] | null {
  if (h.length < 12 || ascii(h, 4, 4) !== 'ftyp') return null;
  const boxEnd = Math.min(Math.max(u32be(h, 0), 16), h.length);
  const brands = [ascii(h, 8, 4)];
  for (let o = 16; o + 4 <= boxEnd; o += 4) brands.push(ascii(h, o, 4));
  return brands;
}

function ftypExt(brands: string[]): string {
  const has = (...names: string[]) => brands.some((b) => names.includes(b));
  if (has('avif', 'avis')) return 'avif';
  if (has('heic', 'heix', 'hevc', 'hevx', 'heim', 'heis')) return 'heic';
  if (has('mif1', 'msf1', 'heif')) return 'heif';
  if (has('crx ')) return 'cr3';
  const major = brands[0];
  if (major === 'qt  ') return 'mov';
  if (major === 'M4A ' || major === 'M4B ') return 'm4a';
  if (major.startsWith('M4V')) return 'm4v';
  if (major.startsWith('3g')) return '3gp';
  return 'mp4';
}

/**
 * Container-level type from the first bytes, as an Eagle ext name. null = unknown. Some
 * signatures are short (a bare JPEG XL codestream, MPEG audio frames), so treat the answer as a
 * guess unless `resolveExt` lets it win. Pure, for tests.
 */
export function sniffHeader(h: Uint8Array): string | null {
  if (h.length < 4) return null;
  if (startsWith(h, 0xff, 0xd8, 0xff)) return 'jpg';
  if (startsWith(h, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (ascii(h, 0, 4) === 'GIF8') return 'gif';
  if (ascii(h, 0, 4) === 'RIFF' && h.length >= 12) {
    const form = ascii(h, 8, 4);
    if (form === 'WEBP') return 'webp';
    if (form === 'WAVE') return 'wav';
    if (form === 'AVI ') return 'avi';
  }
  if (startsWith(h, 0x49, 0x49, 0x2a, 0x00) || startsWith(h, 0x4d, 0x4d, 0x00, 0x2a)) return 'tif';
  if (startsWith(h, 0x49, 0x49, 0x2b, 0x00) || startsWith(h, 0x4d, 0x4d, 0x00, 0x2b)) return 'tif'; // BigTIFF
  if (ascii(h, 0, 4) === '8BPS') {
    const version = u16be(h, 4);
    return version === 1 ? 'psd' : version === 2 ? 'psb' : null;
  }
  if (ascii(h, 0, 5) === '%PDF-') return 'pdf';
  if (ascii(h, 0, 4) === '%!PS' || startsWith(h, 0xc5, 0xd0, 0xd3, 0xc6)) return 'eps';
  if (ascii(h, 0, 4) === 'icns') return 'icns';
  // ICO: 00 00 01 00, then an image count (little endian) and a first entry whose reserved byte is 0.
  const icoCount = h[4] | (h[5] << 8);
  if (
    startsWith(h, 0x00, 0x00, 0x01, 0x00) &&
    h.length >= 10 &&
    icoCount >= 1 &&
    icoCount <= 64 &&
    h[9] === 0
  )
    return 'ico';
  if (startsWith(h, 0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a))
    return 'jxl';
  if (startsWith(h, 0xff, 0x0a)) return 'jxl'; // bare codestream
  // BMP: "BM" is only two bytes, so also check the reserved field and a known DIB header size.
  if (
    h[0] === 0x42 &&
    h[1] === 0x4d &&
    h.length >= 18 &&
    u32be(h, 6) === 0 &&
    [12, 40, 52, 56, 64, 108, 124].includes(u32le(h, 14))
  )
    return 'bmp';

  const brands = ftypBrands(h);
  if (brands) return ftypExt(brands);

  if (startsWith(h, 0x1a, 0x45, 0xdf, 0xa3)) {
    const body = Buffer.from(h.subarray(0, 64));
    return body.includes('webm') ? 'webm' : 'mkv';
  }
  if (ascii(h, 0, 4) === 'OggS') return 'ogg';
  if (ascii(h, 0, 4) === 'fLaC') return 'flac';
  if (ascii(h, 0, 3) === 'ID3') return 'mp3';
  if (h[0] === 0xff && (h[1] & 0xf6) === 0xf0) return 'aac'; // ADTS
  if (h[0] === 0xff && (h[1] & 0xe0) === 0xe0 && (h[1] & 0x06) !== 0 && (h[1] & 0x18) !== 0x08)
    return 'mp3';

  const magic = ascii(h, 0, 4);
  if (magic === 'OTTO') return 'otf';
  if (magic === 'wOFF') return 'woff';
  if (magic === 'wOF2') return 'woff2';
  if (magic === 'ttcf') return 'ttc';
  if (
    (magic === 'true' || startsWith(h, 0x00, 0x01, 0x00, 0x00)) &&
    u16be(h, 4) >= 4 &&
    u16be(h, 4) <= 64
  )
    return 'ttf';

  if (startsWith(h, 0x50, 0x4b, 0x03, 0x04) || startsWith(h, 0x50, 0x4b, 0x05, 0x06)) return 'zip';

  // SVG is text: allow a BOM, an XML prolog or comments before `<svg` (but not an HTML page
  // that merely contains one).
  const text = Buffer.from(h)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (text.startsWith('<svg')) return 'svg';
  if (/^(<\?xml|<!--|<!doctype svg)/i.test(text) && /<svg[\s>]/.test(text)) return 'svg';
  return null;
}

/** True when the file is an animated WebP (VP8X animation flag) or animated AVIF (`avis`). */
export function headerSaysAnimated(h: Uint8Array): boolean {
  if (ascii(h, 0, 4) === 'RIFF' && ascii(h, 8, 4) === 'WEBP') {
    return ascii(h, 12, 4) === 'VP8X' && h.length > 20 && (h[20] & 0x02) !== 0;
  }
  return ftypBrands(h)?.includes('avis') ?? false;
}

// Eagle lets the content win over the file's own extension for these types only (its getExt,
// thumbs-palette-import 4.2). Everything else keeps its declared ext: a .procreate, .potx or
// .usdz is a zip inside, a .dng or .tif may be anything TIFF-like, a .ps is PostScript, a .psdt
// is a PSD, and Eagle stores them all under their own names.
const CONTENT_WINS = new Set(['jpg', 'png', 'gif', 'webp', 'heic', 'bmp', 'avif']);

/**
 * The ext to store a file under, Eagle's way: the declared ext (lowercased, never renamed:
 * `.jpeg` of unknown content stays `jpeg`, `.tiff` stays `tiff`), unless the content is one of
 * the seven types above. A JPEG named `.jfif` stays `jfif`. A file with no ext at all (our temp
 * downloads) is named by its content.
 */
export function resolveExt(header: Uint8Array, declared: string): string {
  const own = declared.replace(/^\./, '').toLowerCase();
  let found = sniffHeader(header);
  if (!own) return found ?? '';
  if (found === 'heif') found = 'heic'; // Eagle's sniffer calls every HEIF image heic
  if (!found || !CONTENT_WINS.has(found)) return own;
  return found === 'jpg' && own === 'jfif' ? 'jfif' : found;
}

/** Sniff a file: its Eagle ext name and the header bytes we read to get it. */
export async function sniffFile(path: string): Promise<{ ext: string; header: Buffer }> {
  const header = await readHeader(path);
  return { ext: resolveExt(header, extname(path)), header };
}

/** Eagle's ext name for a file, from content (see `resolveExt`). */
export async function sniffExt(path: string): Promise<string> {
  return (await sniffFile(path)).ext;
}
