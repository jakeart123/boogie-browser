// Serving files to the boogie:// protocol: which file, and what type it is.
import { open, stat } from 'node:fs/promises';
import type { EagleItemRecord } from '../../shared/types';
import type { EagleLibrary, LibraryIndex, MediaService, UrlBuilder } from '../contracts';
import { HUGE_IMAGE, canRenderLocally, kindOfExt } from '../media/formats';
import { isItemId } from './group';

/** Long edge of Boogie's own thumbnails for types Eagle leaves icon-only (tiles are at most ~400 px). */
const THUMB_EDGE = 480;
/** Long edge of the stand-in for a picture too big for the browser (see isHugeImage). */
const HUGE_EDGE = 8192;

/**
 * Browser-viewable pictures too big for the browser (media/formats HUGE_IMAGE), by the record:
 * their thumbnail and preview are cached vips renditions, like a PSD's. GIFs are left alone (a
 * big GIF is an animation the viewer plays from the original).
 */
export function isHugeImage(rec: { ext?: unknown; width?: unknown; height?: unknown }): boolean {
  const ext = String(rec.ext ?? '').toLowerCase();
  if (ext === 'gif' || ext === 'svg' || kindOfExt(ext) !== 'image') return false;
  return (Number(rec.width) || 0) * (Number(rec.height) || 0) > HUGE_IMAGE.pixels;
}

/**
 * isHugeImage by item id, from the index row (makeUrls asks this for every item it builds URLs
 * for, so no record is parsed). False when the index can't say.
 */
export function hugeImageLookup(index: LibraryIndex): (id: string) => boolean {
  return (id) => {
    try {
      const facts = index.fileFacts?.(id);
      return !!facts && isHugeImage(facts);
    } catch {
      return false; // the index was closed
    }
  };
}

/**
 * Types found by sniffing, by path and record version: every thumbnail request asked the disk
 * for the first bytes of a file whose type never changes while the record doesn't.
 */
const mimeCache = new Map<string, string>();
const MIME_CACHE_MAX = 20_000;

const BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  jxl: 'image/jxl',
  psd: 'image/vnd.adobe.photoshop',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

const ascii = (b: Buffer, from: number, to: number) => b.toString('latin1', from, to);

/** The type from the first bytes, or null when they don't say. Eagle thumbnails named .png are often WebP or JPEG. */
export function sniffMime(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') return 'image/png';
  if (ascii(b, 0, 4) === 'GIF8') return 'image/gif';
  if (ascii(b, 0, 4) === 'RIFF') {
    const kind = ascii(b, 8, 12);
    if (kind === 'WEBP') return 'image/webp';
    if (kind === 'WAVE') return 'audio/wav';
    if (kind === 'AVI ') return 'video/x-msvideo';
  }
  if (ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
    if (brand === 'qt  ') return 'video/quicktime';
    if (brand === 'M4A ') return 'audio/mp4';
    return 'video/mp4';
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)
    return 'video/webm';
  if (ascii(b, 0, 4) === '%PDF') return 'application/pdf';
  if (ascii(b, 0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(b, 0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(b, 0, 3) === 'ID3') return 'audio/mpeg';
  return null;
}

export async function mimeOf(path: string, ext: string): Promise<string> {
  let head = Buffer.alloc(0);
  try {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(32);
      const { bytesRead } = await fh.read(buf, 0, 32, 0);
      head = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    /* unreadable: fall back to the extension */
  }
  return sniffMime(head) ?? BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream';
}

/** What resolveFile needs from an open library (the current one, or a duplicate-scan source). */
export interface FileSource {
  ref: { id: string };
  lib: EagleLibrary;
  index: LibraryIndex;
  urls: UrlBuilder;
}

/**
 * The cache key of Boogie's own rendition of an original: it changes only when the file does.
 * (Not the record's lastModified: every tag edit, or a touch for the partner's Eagle, would
 * render it again and leave the old one behind.)
 */
async function renditionKey(
  libId: string,
  itemId: string,
  original: string,
): Promise<string | null> {
  const st = await stat(original).catch(() => null);
  return st ? `${libId}-${itemId}-${st.size}-${Math.trunc(st.mtimeMs)}` : null;
}

export async function resolveItemFile(
  src: FileSource,
  media: MediaService,
  kind: 'thumb' | 'file' | 'preview',
  itemId: string,
): Promise<{ path: string; mime: string } | null> {
  if (!isItemId(itemId)) return null;
  const rec: EagleItemRecord | null =
    src.index.getRecord(itemId) ?? (await src.lib.readItem(itemId))?.value ?? null;
  if (!rec) return null;

  let path: string | null = null;
  if (kind === 'thumb') {
    if (!rec.noThumbnail) path = await src.lib.locateThumbnail(itemId, rec);
    if (!path) {
      // No Eagle thumbnail: show the original if a browser can draw it (and isn't too big for
      // it), else our own small rendition (cached outside the library; the item stays icon-only
      // for Eagle).
      const original = await src.lib.locateOriginal(itemId, rec);
      if (!original) return null;
      if (media.isBrowserViewable(rec.ext) && !isHugeImage(rec)) path = original;
      else if (canRenderLocally(rec.ext)) {
        const key = await renditionKey(src.ref.id, itemId, original);
        path = key
          ? await media.preview(original, `${key}-t480`, THUMB_EDGE).catch(() => null)
          : null;
      }
    }
  } else {
    const original = await src.lib.locateOriginal(itemId, rec);
    if (!original) return null;
    const huge = kind === 'preview' && isHugeImage(rec);
    if (kind === 'file' || (media.isBrowserViewable(rec.ext) && !huge)) path = original;
    else {
      const key = await renditionKey(src.ref.id, itemId, original);
      path = !key
        ? null
        : huge
          ? await media.preview(original, `${key}-h${HUGE_EDGE}`, HUGE_EDGE)
          : await media.preview(original, key);
    }
  }
  if (!path) return null;
  const cacheKey = `${path}\0${rec.lastModified ?? 0}`;
  let mime = mimeCache.get(cacheKey);
  if (!mime) {
    mime = await mimeOf(path, path.slice(path.lastIndexOf('.') + 1));
    if (mimeCache.size >= MIME_CACHE_MAX) mimeCache.clear();
    mimeCache.set(cacheKey, mime);
  }
  return { path, mime };
}
