// FilterSpec -> SQL over the `items` table (alias `i`). Every user value is a bound parameter.
// Empty lists, empty strings and unset ranges mean "no constraint", so a UI can send a half-filled
// spec without special cases. The color filter isn't SQL: it is returned separately (see color.ts).
import type { FilterSpec, RangeFilter } from '../../../shared/types';
import { stringList } from '../project';
import type { ColorQuery } from './color';
import { keywordsToSql, parseKeywords } from './keywords';
import { AUDIO_EXTS, FONT_EXTS, VIDEO_EXTS } from './smartFolders';
import {
  FALSE,
  cleanText,
  frag,
  joinFrags,
  not,
  placeholders,
  timeOrImport,
  type SqlFrag,
} from './sql';

// "image" = pictures, camera RAW, and layered/design sources that make a thumbnail.
const IMAGE_EXTS = [
  'jpg', 'jpeg', 'jfif', 'jpe', 'png', 'gif', 'webp', 'avif', 'jxl', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'hif', 'ico', 'icns', 'svg', 'tga', 'dds', 'hdr', 'exr', 'insp',
  'arw', 'cr2', 'cr3', 'crw', 'dng', 'raf', 'rw2', 'orf', 'nef', 'nrw', 'raw', '3fr', 'erf', 'srw', 'sr2', 'pef', 'x3f', 'mrw',
  'psd', 'psdt', 'psb', 'ai', 'ait', 'eps', 'ps', 'xd', 'clip', 'af', 'afphoto', 'afdesign', 'afpub', 'cdr', 'indd', 'indt', 'idml', 'fig', 'sketch', 'pxd', 'prd', 'skt',
]; // prettier-ignore
// prettier-ignore
const DOC_EXTS = ['pdf', 'txt', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'potx', 'key', 'pages', 'number', 'numbers', 'html', 'mhtml', 'url', 'xmind', 'mindnode', 'graffle', 'eddx', 'emmx'];
const MODEL_EXTS = ['glb', 'obj', 'fbx', '3ds', '3mf', 'dae', 'ifc', 'ply', 'stl', 'blend', 'c4d', 'skp', 'dwg']; // prettier-ignore

/** Type-filter groups (Eagle's `config.js` lists for video/audio/font/3D; the rest is ours). */
export const TYPE_GROUP_EXTS: Record<string, string[]> = {
  image: IMAGE_EXTS,
  images: IMAGE_EXTS,
  video: VIDEO_EXTS,
  videos: VIDEO_EXTS,
  audio: AUDIO_EXTS,
  font: FONT_EXTS,
  fonts: FONT_EXTS,
  doc: DOC_EXTS,
  docs: DOC_EXTS,
  document: DOC_EXTS,
  documents: DOC_EXTS,
  // Eagle's filter bar also groups Office files
  powerpoint: ['ppt', 'pptx', 'potx'],
  word: ['doc', 'docx'],
  excel: ['xls', 'xlsx'],
  '3d': MODEL_EXTS,
  model: MODEL_EXTS,
  models: MODEL_EXTS,
};

// Eagle normalizes .jpeg to jpg and .tiff to tif on import, but older libraries keep both.
const EXT_ALIASES: Record<string, string[]> = {
  jpg: ['jpeg'],
  jpeg: ['jpg'],
  tif: ['tiff'],
  tiff: ['tif'],
};

function expandTypes(values: string[]): string[] {
  const out = new Set<string>();
  for (const raw of values) {
    const v = String(raw).trim().toLowerCase().replace(/^\./, '');
    if (!v) continue;
    if (Object.hasOwn(TYPE_GROUP_EXTS, v)) TYPE_GROUP_EXTS[v].forEach((e) => out.add(e));
    else {
      out.add(v);
      (EXT_ALIASES[v] ?? []).forEach((e) => out.add(e));
    }
  }
  return [...out];
}

const cleanStrings = (v: unknown): string[] => [...new Set(stringList(v))];

function range(col: string, r: RangeFilter | undefined): SqlFrag | null {
  if (!r) return null;
  const parts: SqlFrag[] = [];
  if (typeof r.min === 'number' && Number.isFinite(r.min)) parts.push(frag(`${col} >= ?`, r.min));
  if (typeof r.max === 'number' && Number.isFinite(r.max)) parts.push(frag(`${col} <= ?`, r.max));
  return parts.length ? joinFrags(parts, 'AND') : null;
}

/**
 * Plain, case-insensitive "contains" on the URL, the note or the comments. One literal string: URLs
 * hold commas and spaces, and the HTTP and MCP callers pass them straight through.
 */
function contains(
  column: 'url' | 'annotation' | 'comments',
  text: string | undefined,
): SqlFrag | null {
  const t = typeof text === 'string' ? cleanText(text).trim() : '';
  if (!t) return null;
  // The trigram index folds case for every script; SQLite's lower() only does ASCII.
  return [...t].length >= 3
    ? frag(
        'i.rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)',
        `${column} : "${t.replace(/"/g, '""')}"`,
      )
    : frag(`instr(lower(i.${column}), ?) > 0`, t.toLowerCase());
}

export interface CompiledFilter {
  where: SqlFrag[];
  color: ColorQuery | null;
}

const DAY = 86_400_000;

/**
 * The filter bar's shapes (Eagle's `filterData`, not its smart-folder rule): landscape and portrait
 * are just wider / taller, so they include the panoramic ones, which start at 2.5:1; square is
 * exactly square. Items without a size have no shape (Eagle would call them square).
 */
const SHAPE_SQL: Record<string, string> = {
  landscape: 'i.width > i.height',
  portrait: 'i.height > i.width',
  square: 'i.width = i.height',
  'panoramic-landscape': 'i.width > i.height AND i.width >= 2.5 * i.height',
  'panoramic-portrait': 'i.height > i.width AND i.height >= 2.5 * i.width',
};

/** "Last N days" is rolling, like Eagle's last7day...: newer than now minus N days. */
function within(expr: string, days: number | undefined, now: number): SqlFrag | null {
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) return null;
  return frag(`${expr} > ?`, now - days * DAY);
}

/**
 * Eagle's black-and-white test: the item has a palette and every swatch covering 2% or more is a
 * gray (no two channels 8 or more apart).
 */
const GRAYSCALE = frag(
  `EXISTS (SELECT 1 FROM palette p WHERE p.item_rowid = i.rowid)
   AND NOT EXISTS (SELECT 1 FROM palette p WHERE p.item_rowid = i.rowid AND p.ratio >= 0.02
     AND (abs(p.r - p.g) >= 8 OR abs(p.r - p.b) >= 8 OR abs(p.g - p.b) >= 8))`,
);

/** `now` anchors the rolling "last N days" windows. */
export function compileFilter(
  f: FilterSpec | undefined | null,
  now: number = Date.now(),
): CompiledFilter {
  const where: SqlFrag[] = [];
  const add = (x: SqlFrag | null): void => {
    if (x) where.push(x);
  };
  if (!f) return { where, color: null };

  // keywords (Eagle grammar)
  if (typeof f.keywords === 'string') {
    const ast = parseKeywords(f.keywords);
    if (ast) add(keywordsToSql(ast));
  }

  // tags. "No tags" joins an "any" list the way Eagle's OR mode does (these tags, or none at all);
  // with no list, or with "all"/"exact", it simply means untagged.
  const untagged = frag('i.tag_count = 0');
  const anyTagMode = !f.tags?.mode || f.tags.mode === 'any';
  const tagInclude = cleanStrings(f.tags?.include);
  if (f.noTags && !(anyTagMode && tagInclude.length)) add(untagged);
  if (f.tags) {
    const include = tagInclude;
    const exclude = cleanStrings(f.tags.exclude);
    const anyOf = (list: string[]): SqlFrag =>
      frag(
        `EXISTS (SELECT 1 FROM item_tags t WHERE t.item_rowid = i.rowid AND t.tag IN (${placeholders(list.length)}))`,
        ...list,
      );
    if (include.length) {
      if (anyTagMode) add(f.noTags ? joinFrags([anyOf(include), untagged], 'OR') : anyOf(include));
      else {
        const count = `(SELECT COUNT(*) FROM item_tags t WHERE t.item_rowid = i.rowid AND t.tag IN (${placeholders(include.length)}))`;
        if (f.tags.mode === 'all') add(frag(`(${count} = ?)`, ...include, include.length));
        else
          add(
            frag(`(${count} = ? AND i.tag_count = ?)`, ...include, include.length, include.length),
          ); // exact
      }
    }
    if (exclude.length) add(not(anyOf(exclude)));
  }

  // folders: plain membership (the item lists the folder itself). Subfolders are NOT included;
  // that is what Eagle's filter bar does, and a folder scope already has "show subfolder contents".
  // "NoFolders" is Eagle's pseudo-id for unfiled items; `unfiled` is the same thing, so it joins the
  // "in any of these" list.
  if (f.folders || f.unfiled) {
    const inFolders = (ids: string[]): SqlFrag =>
      frag(
        `EXISTS (SELECT 1 FROM item_folders f WHERE f.item_rowid = i.rowid AND f.folder_id IN (${placeholders(ids.length)}))`,
        ...ids,
      );
    const include = cleanStrings([
      ...(f.folders?.include ?? []),
      ...(f.unfiled ? ['NoFolders'] : []),
    ]);
    const exclude = cleanStrings(f.folders?.exclude);
    if (include.length) {
      const real = include.filter((id) => id !== 'NoFolders');
      const parts: SqlFrag[] = [];
      if (real.length) parts.push(inFolders(real));
      if (include.includes('NoFolders')) parts.push(frag('i.folder_count = 0'));
      add(joinFrags(parts, 'OR'));
    }
    if (exclude.length) {
      const real = exclude.filter((id) => id !== 'NoFolders');
      if (real.length) add(not(inFolders(real)));
      if (exclude.includes('NoFolders')) add(frag('i.folder_count > 0'));
    }
  }

  // shapes (any of them)
  const shapes = cleanStrings(f.shapes).filter((s) => Object.hasOwn(SHAPE_SQL, s));
  if (shapes.length)
    add(
      frag(`(i.width > 0 AND i.height > 0 AND (${shapes.map((s) => SHAPE_SQL[s]).join(' OR ')}))`),
    );
  else if (cleanStrings(f.shapes).length) add(FALSE); // only unknown shapes: nothing has them

  // aspect ratio, tolerance relative to the target ratio (default 5%): |W/H - w/h| <= tol * w/h,
  // multiplied through by H*h so it needs no division and skips items without dimensions.
  if (f.aspect && f.aspect.w > 0 && f.aspect.h > 0) {
    const { w, h } = f.aspect;
    const tol =
      f.aspect.tolerance !== undefined && f.aspect.tolerance >= 0 ? f.aspect.tolerance : 0.05;
    add(
      frag(
        '(i.width > 0 AND i.height > 0 AND ABS(i.width * ? - i.height * ?) <= ? * i.height)',
        h,
        w,
        tol * w,
      ),
    );
  }

  // rating (0 = unrated)
  if (Array.isArray(f.rating) && f.rating.length) {
    const stars = [...new Set(f.rating.filter((n) => Number.isInteger(n) && n >= 0 && n <= 5))];
    add(stars.length ? frag(`i.star IN (${placeholders(stars.length)})`, ...stars) : FALSE);
  }

  // types: extensions or groups
  if (f.types) {
    const include = expandTypes(cleanStrings(f.types.include));
    const exclude = expandTypes(cleanStrings(f.types.exclude));
    if (include.length) add(frag(`i.ext IN (${placeholders(include.length)})`, ...include));
    if (exclude.length) add(frag(`i.ext NOT IN (${placeholders(exclude.length)})`, ...exclude));
  }

  // ranges. "modified" is Eagle's Date Modified: the source file's mtime, else the import time.
  add(range('i.imported_at', f.importedAt));
  add(range(timeOrImport('mtime'), f.modifiedAt));
  add(within('i.imported_at', f.importedWithinDays, now));
  add(within(timeOrImport('mtime'), f.modifiedWithinDays, now));
  add(range('i.width', f.width));
  add(range('i.height', f.height));
  add(range('i.size', f.fileSize));
  add(range('i.duration', f.duration));

  if (f.hasUrl !== undefined) add(frag(f.hasUrl ? `i.url <> ''` : `i.url = ''`));
  if (f.hasNote !== undefined) add(frag(f.hasNote ? `i.annotation <> ''` : `i.annotation = ''`));
  add(contains('url', f.urlContains));
  add(contains('annotation', f.noteContains));
  // Region comments (Eagle's filter bar calls them "annotation"; the item's note is its "note").
  if (f.hasComments !== undefined)
    add(frag(f.hasComments ? `i.comments <> ''` : `i.comments = ''`));
  add(contains('comments', f.commentContains));
  if (f.grayscale) add(GRAYSCALE);

  let color: ColorQuery | null = null;
  if (
    f.color &&
    Array.isArray(f.color.rgb) &&
    f.color.rgb.length === 3 &&
    f.color.rgb.every(Number.isFinite)
  ) {
    color = {
      rgb: f.color.rgb,
      tolerance: f.color.tolerance === 'close' ? 'close' : 'similar',
      minRatio: f.color.minRatio,
    };
  }
  return { where, color };
}
