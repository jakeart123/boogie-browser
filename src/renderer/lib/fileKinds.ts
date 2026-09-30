// What kind of file an extension is: the one table for badges, placeholder icons, hover previews,
// the viewer and the inspector. It follows the core's table (src/core/media/formats.ts kindOfExt),
// split a little finer for display (pdf out of doc, archives out of other), with one deliberate
// difference: `.ts` is not a video here. In real libraries it is TypeScript source far more often
// than an MPEG transport stream, and a video player for source code helps nobody.

export type FileKind =
  'image' | 'video' | 'audio' | 'font' | 'pdf' | 'doc' | '3d' | 'archive' | 'other';

const set = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

// Same lists as the core (images include camera raw).
const IMAGE =
  set(`jpg jpeg jpe jfif png gif webp avif heic heif hif bmp tif tiff psd psb psdt svg ico
  icns jxl tga dds exr hdr kra clip
  cr2 cr3 crw nef nrw arw sr2 srf dng raf orf rw2 pef srw 3fr iiq erf kdc mef mos mrw x3f raw rwl dcr`);
const VIDEO = set(
  'mp4 m4v mov webm mkv avi wmv flv mpg mpeg mpe 3gp 3g2 m2ts mts ogv f4v asf vob rm rmvb mxf divx',
);
const AUDIO = set('mp3 wav flac ogg oga opus m4a m4b aac wma aiff aif mid midi ape amr');
const FONT = set('ttf otf ttc woff woff2');
const MODEL = set('3mf 3ds dae ifc ply stl fbx obj glb gltf blend skp dwg c4d');
const DOC =
  set(`ai eps doc docx xls xlsx ppt pptx potx key numbers pages odt ods odp rtf txt md epub xd
  sketch fig af afpub afphoto afdesign indd indt idml graffle xmind mindnode cdr html mhtml`);
const ARCHIVE = set('zip rar 7z tar gz tgz bz2 xz');

/** Containers Chromium can open in <video>. If the codec inside isn't supported it errors and callers fall back. */
const PLAYABLE = set('mp4 m4v webm mov mkv ogv 3gp');
/** Everyday picture formats that need no badge on a tile; everything else says what it is. */
const PLAIN = set('jpg jpeg jpe jfif png webp avif bmp svg ico tif tiff heic heif');

export function fileKind(ext: string): FileKind {
  const e = ext.replace(/^\./, '').toLowerCase();
  if (e === 'pdf') return 'pdf';
  if (IMAGE.has(e)) return 'image';
  if (VIDEO.has(e)) return 'video';
  if (AUDIO.has(e)) return 'audio';
  if (FONT.has(e)) return 'font';
  if (MODEL.has(e)) return '3d';
  if (DOC.has(e)) return 'doc';
  if (ARCHIVE.has(e)) return 'archive';
  return 'other';
}

/**
 * Documents Boogie draws a picture of itself (the first page, through vips), as the core does
 * (media/formats.ts VECTOR_EXTS, besides PDF, which has its own view).
 */
const DRAWN = set('ai eps');
/** Pictures nothing can draw: Clip Studio files have no readable image in them. */
const UNDRAWABLE = set('clip');

/**
 * What Boogie can draw a picture of itself (the core's canRenderLocally): pictures, videos, fonts,
 * PDFs, Illustrator and EPS. Eagle leaves some of these icon-only (kra, ai, eps, woff2); Boogie
 * still shows them, from its own cache.
 */
export function boogieDraws(ext: string): boolean {
  const e = ext.replace(/^\./, '').toLowerCase();
  if (UNDRAWABLE.has(e)) return false;
  const k = fileKind(e);
  return k === 'image' || k === 'video' || k === 'font' || k === 'pdf' || DRAWN.has(e);
}

/** How the viewer shows a file: a picture, a player, a PDF, a font sample, or a file panel. */
export type ViewKind = 'image' | 'video' | 'audio' | 'pdf' | 'font' | 'other';

export function viewKind(ext: string): ViewKind {
  const e = ext.replace(/^\./, '').toLowerCase();
  if (DRAWN.has(e)) return 'image';
  if (UNDRAWABLE.has(e)) return 'other';
  const k = fileKind(e);
  return k === 'doc' || k === '3d' || k === 'archive' ? 'other' : k;
}

export function canPlayVideo(ext: string): boolean {
  return PLAYABLE.has(ext.toLowerCase());
}

export function wantsBadge(ext: string): boolean {
  return !PLAIN.has(ext.toLowerCase());
}
