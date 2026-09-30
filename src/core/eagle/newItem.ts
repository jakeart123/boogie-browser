// The record for a brand-new item, with keys in the order Eagle writes them
// (format-spec 5.2, live-behavior 1). Pure: no I/O.
import type { EagleItemRecord } from '../../shared/types';
import type { NewItemInit } from '../contracts';
import { normalizeTags } from './edits';

const MAX_URL = 2000;

export const wholeSecond = (ms: number) => Math.floor(Number(ms) / 1000) * 1000;

/** Extensions whose dimensions Eagle writes as `width, height` (everything else is `height, width`). */
const WIDTH_FIRST = new Set(
  'webp ico pdf heic heif mp4 m4v mov webm mkv avi wmv flv mpg mpeg ogv 3gp mp3 wav flac aac m4a ogg wma opus cr2 cr3 nef arw dng raf orf rw2 pef srw'.split(
    ' ',
  ),
);
/** Eagle's palette analyzer needs a size, and skips images taller than this many times their width. */
const MAX_PALETTE_ASPECT = 30_000_000 / 480 ** 2;
/** SVG flags Eagle's svg generator writes before the size (thumbs-palette-import §3). */
const SVG_FLAGS = ['removeThumbnail', 'forceThumbnail'];

/** Keys `createItem` sets itself, so `init.extra` may not override them. */
const OWN_KEYS = new Set([
  'id',
  'name',
  'size',
  'btime',
  'mtime',
  'ext',
  'tags',
  'folders',
  'isDeleted',
  'url',
  'annotation',
  'modificationTime',
  'star',
  'height',
  'width',
  'duration',
  'noThumbnail',
  'noPreview',
  'processingPalette',
  'lastModified',
  'palettes',
]);

/**
 * `id, name, size, btime, mtime, ext, tags, folders, isDeleted, url, annotation, modificationTime,
 * [star], height, width, [extra...], [duration], [noThumbnail], [noPreview], [processingPalette],
 * lastModified, [palettes]`. Video and other width-first types get `width, height` with
 * `noThumbnail` before them (a webp: `noThumbnail, width, height`, eagle-proof D "Import webp",
 * library-survey §4); an SVG gets its flags and `noThumbnail` before the size, like Eagle's svg
 * generator.
 */
export function buildItemRecord(
  id: string,
  name: string,
  ext: string,
  init: NewItemInit,
  now = Date.now(),
): EagleItemRecord {
  const rec: Record<string, unknown> = {
    id,
    name,
    size: Math.trunc(init.size),
    btime: wholeSecond(init.btime),
    mtime: wholeSecond(init.mtime),
    ext,
    tags: normalizeTags(init.tags ?? []),
    folders: [...new Set(init.folders ?? [])],
    isDeleted: false,
    url: String(init.url ?? '').slice(0, MAX_URL),
    annotation: String(init.annotation ?? ''),
    modificationTime: Number.isFinite(init.modificationTime) ? init.modificationTime : now,
  };
  const star = Math.trunc(Number(init.star));
  if (star >= 1 && star <= 5) rec.star = star;
  const svg = ext === 'svg';
  const widthFirst = WIDTH_FIRST.has(ext);
  const flagsFirst = svg || widthFirst;
  if (svg) for (const k of SVG_FLAGS) if (init.extra?.[k] !== undefined) rec[k] = init.extra[k];
  if (init.noThumbnail && flagsFirst) rec.noThumbnail = true;
  const dims: [string, number | undefined][] = widthFirst
    ? [
        ['width', init.width],
        ['height', init.height],
      ]
    : [
        ['height', init.height],
        ['width', init.width],
      ];
  for (const [k, v] of dims)
    if (typeof v === 'number' && Number.isFinite(v)) rec[k] = Math.trunc(v);
  for (const [k, v] of Object.entries(init.extra ?? {}))
    if (!OWN_KEYS.has(k) && !(k in rec) && v !== undefined) rec[k] = v;
  if (typeof init.duration === 'number' && Number.isFinite(init.duration))
    rec.duration = init.duration;
  if (init.noThumbnail && !flagsFirst) rec.noThumbnail = true;
  if (init.noPreview) rec.noPreview = true;
  const hasPalette = Array.isArray(init.palettes) && init.palettes.length > 0;
  // No palette yet: Eagle computes it when it next opens the library (a Windows-side rewrite, but
  // it works). Only where Eagle's analyzer can: it needs a size (no txt, audio without a waveform,
  // icon-only items) and skips very tall images. Anywhere else the flag would just make Eagle
  // rewrite the item once to drop it.
  const { width: w, height: h } = rec as { width?: number; height?: number };
  const analyzable = !!w && !!h && w > 0 && h > 0 && h / w <= MAX_PALETTE_ASPECT;
  if (!hasPalette && !init.noPreview && analyzable) rec.processingPalette = true;
  rec.lastModified = now;
  if (hasPalette) rec.palettes = init.palettes;
  return rec as EagleItemRecord;
}
