// Ext tables: what kind of file an ext is, which ones Chromium can show, which ones get
// bigger thumbnails. Sources: research/format-notes/thumbs-palette-import.md 1.2 and 4.2,
// research/tech-notes.md section 3.

import type { ProbeResult } from '../contracts';

export type MediaKind = ProbeResult['kind'];

/** Eagle's fixed sizes for types with no pixels of their own (thumbs-palette-import 1.5). */
export const AUDIO_SIZE = { width: 280, height: 140 };
export const FONT_SIZE = { width: 600, height: 600 };

const set = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

/** Camera raw. Many are TIFF inside, which is why sniff.ts keeps a raw ext instead of calling them tif. */
export const RAW_EXTS = set(
  'cr2 cr3 crw nef nrw arw sr2 srf dng raf orf rw2 pef srw 3fr iiq erf kdc mef mos mrw x3f raw rwl dcr',
);

const IMAGE_EXTS = set(
  `jpg jpeg jpe jfif png gif webp avif heic heif hif bmp tif tiff psd psb psdt svg ico icns jxl tga dds exr hdr kra clip`,
);
const VIDEO_EXTS = set(
  'mp4 m4v mov webm mkv avi wmv flv mpg mpeg mpe 3gp 3g2 ts m2ts mts ogv f4v asf vob rm rmvb mxf divx',
);
const AUDIO_EXTS = set('mp3 wav flac ogg oga opus m4a m4b aac wma aiff aif mid midi ape amr');
const FONT_EXTS = set('ttf otf ttc woff woff2');
const MODEL_EXTS = set('3mf 3ds dae ifc ply stl fbx obj glb gltf blend skp dwg c4d');
const DOC_EXTS = set(
  `pdf ai eps doc docx xls xlsx ppt pptx potx key numbers pages odt ods odp rtf txt md epub xd sketch fig af afpub afphoto
   afdesign indd indt idml graffle xmind mindnode cdr html mhtml`,
);

export function kindOfExt(ext: string): MediaKind {
  const e = ext.toLowerCase();
  if (IMAGE_EXTS.has(e) || RAW_EXTS.has(e)) return 'image';
  if (VIDEO_EXTS.has(e)) return 'video';
  if (AUDIO_EXTS.has(e)) return 'audio';
  if (FONT_EXTS.has(e)) return 'font';
  if (MODEL_EXTS.has(e)) return '3d';
  if (DOC_EXTS.has(e)) return 'doc';
  return 'other';
}

const VIEWABLE = set(
  'jpg jpeg jfif png gif webp avif bmp svg ico mp4 m4v webm mov mp3 wav ogg m4a flac aac',
);

/** Formats Chromium shows directly in <img>/<video>/<audio> (h264, vp9 and av1 for video). */
export function isBrowserViewable(ext: string): boolean {
  return VIEWABLE.has(ext.replace(/^\./, '').toLowerCase());
}

/** Eagle's thumbnail size S (thumbs-palette-import 1.2): 320 unless the type is listed here. */
const S480 = set(
  `pdf 3mf 3ds dae ifc ply stl fbx obj glb xmind mindnode xd ai indd indt idml af afpub afphoto afdesign sketch graffle
   fig eps hdr exr dds doc docx xls xlsx ppt pptx potx key numbers pages cr3`,
);
const S512 = set('ico icns');

/**
 * What Windows Eagle can draw a thumbnail for (its SUPPORT_FORMATS_WIN, thumbs-palette-import
 * 1.2). Anything else is an icon-only (`noPreview`) item on the partner's side, and a "regenerate
 * thumbnail" there strips the thumbnail, size and palette of any item we had drawn one for. So we
 * do what Eagle does: no thumbnail for these either, even where vips could make one (kra, ai,
 * eps, woff2, keynote...). Our viewer still shows them through `preview()`.
 */
const EAGLE_PREVIEWS = set(
  `afx eva vap 360 avif url html mhtml png jpg jfif jxl jpe insp gif tiff tif jpeg psd psdt psb pdf svg bmp icns ico txt
   xd ps webp mp3 wav ogg flac aac m4a ts 3gp mp4 mkv mpg mov m4v webm avi mts wmv flv m2ts f4v potx pptx ppt glb fbx obj
   3ds 3mf dae ifc ply stl hdr exr cdr skp dwg c4d clip blend af afpub afdesign afphoto ttf otf ttc woff tga indd indt
   idml dds heic heif hif xmind doc docx xls xlsx arw cr2 cr3 crw dng raf rw2 orf nef nrw raw 3fr erf srw sr2 pef x3f mrw
   eddx emmx`,
);

export function eagleCanPreview(ext: string): boolean {
  return EAGLE_PREVIEWS.has(ext.toLowerCase());
}

/** Documents vips draws as pictures (their first page). */
export const VECTOR_EXTS = new Set(['pdf', 'ai', 'eps']);

/**
 * Types Boogie can draw a picture of itself (media.preview: vips, the kra's own flattened image,
 * ffmpeg, a font specimen), used for icon-only items so the grid shows more than an icon. That
 * picture lives in our cache, never in the library. Clip Studio files have no readable picture.
 */
export function canRenderLocally(ext: string): boolean {
  const e = ext.toLowerCase();
  if (e === 'clip') return false;
  const kind = kindOfExt(e);
  return kind === 'image' || kind === 'video' || kind === 'font' || VECTOR_EXTS.has(e);
}

export function thumbnailSizeFor(ext: string): number {
  const e = ext.toLowerCase();
  return S480.has(e) ? 480 : S512.has(e) ? 512 : 320;
}

/**
 * A picture Chromium can't show in reasonable time or memory: above 100 MP (a 713 MP, 215 MB
 * JPEG never appeared in 120 s). Its preview is a cached, smaller rendition. Only the pixel count
 * decides: a big file of modest size (a layered PNG export) is fine in Chromium, and its
 * rendition would lose its transparency.
 */
export const HUGE_IMAGE = { pixels: 100e6 } as const;
