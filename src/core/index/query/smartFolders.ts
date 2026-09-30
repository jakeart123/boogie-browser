// Smart folders: Eagle's rule language (research/format-notes/smartfolders-filters.md).
//
// Two implementations of the same rules:
//  - `evaluateSmartFolder` runs the rules on one parsed item record. It is the reference, and
//    copies Eagle's quirks on purpose so counts match Eagle's (see the notes at each rule).
//  - `compileSmartFolder` turns the easy rule families into SQL over the index columns so a folder
//    over 85k items does not need 85k JSON parses. Anything it can't express exactly (regex, comments,
//    camera metadata, color, folderName, folders, ...) is left to the reference evaluator, which the
//    engine then runs over the SQL prefilter's survivors. smartFolders.test.ts checks that both
//    agree on the same rules and items.
import { differenceCiede2000 } from 'culori';
import type {
  EagleItemRecord,
  EagleSmartFolderRecord,
  SmartCondition,
  SmartRule,
} from '../../../shared/types';
import { FALSE, TRUE, frag, joinFrags, not, placeholders, type SqlFrag } from './sql';

const DAY = 86_400_000;

// Type groups from Eagle's own config (facts about which extensions belong together).
// prettier-ignore
export const VIDEO_EXTS = ['ts', '3gp', '360', 'afx', 'vap', 'eva', 'mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'wmv', 'mpg', 'mts', 'flv', 'm2ts', 'f4v'];
export const AUDIO_EXTS = ['mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a'];
export const FONT_EXTS = ['ttf', 'otf', 'ttc', 'woff', 'woff2'];
const TYPE_GROUPS: Record<string, string[]> = {
  video: VIDEO_EXTS,
  videos: VIDEO_EXTS,
  audio: AUDIO_EXTS,
  font: FONT_EXTS,
  powerpoint: ['ppt', 'pptx', 'potx'],
  presentation: ['ppt', 'key', 'pptx'],
  excel: ['xls', 'xlsx'],
  word: ['doc', 'docx'],
};
const BOOKMARK_MEDIA = ['youtube', 'vimeo', 'bilibili'];

export interface EvalContext {
  /** Folder id to folder name (for `folderName` rules). */
  folderName?: (id: string) => string | undefined;
  /** The clock for `within` rules. Default Date.now(). */
  now?: number;
}

// ─────────────────────────── tree helpers ───────────────────────────

/**
 * Tolerant read of root `smartFolders`: missing `children`/`conditions` become [], and old
 * top-level records (before Eagle 1.9.2: `set` + `rules`) become one condition, like Eagle does
 * on load. Unknown keys are ignored here and never written back by this module.
 */
export function normalizeSmartFolders(list: unknown, topLevel = true): EagleSmartFolderRecord[] {
  if (!Array.isArray(list)) return [];
  const out: EagleSmartFolderRecord[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || typeof (raw as { id?: unknown }).id !== 'string')
      continue;
    const node = raw as EagleSmartFolderRecord & { set?: unknown; rules?: unknown };
    let conditions: SmartCondition[] = Array.isArray(node.conditions) ? node.conditions : [];
    if (topLevel && !Array.isArray(node.conditions) && Array.isArray(node.rules)) {
      conditions = [
        { rules: node.rules as SmartRule[], match: node.set === 'intersection' ? 'AND' : 'OR' },
      ];
    }
    out.push({ ...node, conditions, children: normalizeSmartFolders(node.children, false) });
  }
  return out;
}

export interface SmartFolderEntry {
  node: EagleSmartFolderRecord;
  ancestors: EagleSmartFolderRecord[];
  /** "Parent / Child" */
  path: string;
}

/** Every smart folder in tree order, with its ancestors and display path. */
export function flattenSmartFolders(tree: EagleSmartFolderRecord[]): SmartFolderEntry[] {
  const out: SmartFolderEntry[] = [];
  const walk = (
    nodes: EagleSmartFolderRecord[],
    ancestors: EagleSmartFolderRecord[],
    prefix: string,
  ): void => {
    for (const node of nodes) {
      const path = prefix ? `${prefix} / ${node.name}` : String(node.name ?? '');
      out.push({ node, ancestors, path });
      walk(node.children ?? [], [...ancestors, node], path);
    }
  };
  walk(tree, [], '');
  return out;
}

export function findSmartFolder(
  tree: EagleSmartFolderRecord[],
  id: string,
): SmartFolderEntry | null {
  return flattenSmartFolders(tree).find((e) => e.node.id === id) ?? null;
}

// ─────────────────────────── the reference evaluator ───────────────────────────

/**
 * Does the item belong in this smart folder? It must pass the folder's conditions and every
 * ancestor's (a child only narrows its parent). A folder with no conditions is a group: it holds
 * whatever its children hold. Trashed items never match. A rule Eagle can't evaluate (unknown
 * property, a startWith value that is not a valid regex) makes the folder empty, like Eagle.
 */
export function evaluateSmartFolder(
  folder: EagleSmartFolderRecord,
  ancestors: EagleSmartFolderRecord[],
  rec: EagleItemRecord,
  ctx: EvalContext = {},
): boolean {
  if (rec.isDeleted) return false;
  if ((folder.conditions ?? []).length === 0) {
    // Opened directly, a group shows the union of its children. Each child is judged on its own
    // conditions plus its ancestors' (Eagle's existInSmartFilter), so a group nested inside a group
    // has no conditions and passes everything its ancestors pass. That is Eagle's behavior; we copy it.
    const chain = [...ancestors, folder];
    return (folder.children ?? []).some((child) => passes(child, chain, rec, ctx));
  }
  return passes(folder, ancestors, rec, ctx);
}

/** Eagle's existInSmartFilter: this folder's conditions, then every ancestor's. A throwing rule = not in the folder. */
function passes(
  node: EagleSmartFolderRecord,
  ancestors: EagleSmartFolderRecord[],
  rec: EagleItemRecord,
  ctx: EvalContext,
): boolean {
  try {
    return (
      matchesConditions(node.conditions ?? [], rec, ctx) &&
      ancestors.every((a) => matchesConditions(a.conditions ?? [], rec, ctx))
    );
  } catch {
    return false; // Eagle's catch around existInSmartFilter: one bad rule = not in the folder
  }
}

/** All conditions of one folder, joined by AND. */
export function matchesConditions(
  conditions: SmartCondition[],
  rec: EagleItemRecord,
  ctx: EvalContext = {},
): boolean {
  return conditions.every((c) => conditionMatches(c, rec, ctx));
}

function conditionMatches(c: SmartCondition, rec: EagleItemRecord, ctx: EvalContext): boolean {
  const rules = Array.isArray(c.rules) ? c.rules : [];
  let ok: boolean;
  if (rules.length === 0) ok = true;
  else if (c.match === 'OR') ok = rules.some((r) => ruleMatches(r, rec, ctx));
  else if (c.match === 'AND') ok = rules.every((r) => ruleMatches(r, rec, ctx));
  else ok = rules.map((r) => ruleMatches(r, rec, ctx)).every(Boolean); // missing or odd: AND, but Eagle never exits early
  return ok !== (c.boolean === 'FALSE'); // XOR: FALSE negates the whole condition
}

type Rec = Record<string, unknown>;

function ruleMatches(rule: SmartRule, rec: EagleItemRecord, ctx: EvalContext): boolean {
  const r = rec as Rec;
  switch (rule.property) {
    case 'name':
      return stringRule(str(r.name), rule);
    case 'url':
      return stringRule(str(r.url), rule);
    case 'annotation':
      return stringRule(str(r.annotation), rule);
    case 'folderName': {
      // Any folder's name passing is enough; an item in no folder never matches, not even `empty`.
      const names = (Array.isArray(r.folders) ? r.folders : [])
        .map((id) => ctx.folderName?.(String(id)))
        .filter((n): n is string => typeof n === 'string');
      return names.some((n) => stringRule(n, rule));
    }
    case 'comments':
      return commentsRule(r.comments, rule);
    case 'camera': {
      const camera = rawMeta(r, 'camera');
      return typeof camera === 'string' && camera !== '' ? stringRule(camera, rule) : false; // missing or empty camera: never, even `empty`
    }
    case 'width':
      return numericRule(numOrNaN(r.width), rule, pf);
    case 'height':
      return numericRule(numOrNaN(r.height), rule, pf);
    case 'fileSize':
      return numericRule(numOrNaN(r.size) / (rule.unit === 'kb' ? 1024 : 1048576), rule, pf);
    case 'duration': {
      const d = Number(r.duration);
      if (!d) return false; // no or zero duration never matches
      return numericRule(d / (rule.unit === 'h' ? 3600 : rule.unit === 'm' ? 60 : 1), rule, pf);
    }
    case 'bpm':
      return r.bpm ? numericRule(Number(r.bpm), rule, pf) : false;
    case 'iso':
      return numericRule(parseInt(String(rawMeta(r, 'isoSpeed')), 10), rule, pi);
    case 'aperture':
      return numericRule(nthNumber(rawMeta(r, 'aperture'), 0), rule, pf);
    case 'focalLength':
      return numericRule(nthNumber(rawMeta(r, 'focalLength'), 0), rule, pf);
    case 'shutter':
      return numericRule(nthNumber(rawMeta(r, 'shutter'), 1), rule, pf); // "1/200": the 200
    case 'createTime':
      return dateRule(Number(r.modificationTime), rule, ctx, pf);
    case 'mtime':
      return dateRule(Number(r.mtime) || Number(r.modificationTime), rule, ctx, pf);
    case 'btime':
      return dateRule(Number(r.btime) || Number(r.modificationTime), rule, ctx, pf);
    case 'timestamp':
      return dateRule(parseInt(String(rawMeta(r, 'timestamp')), 10), rule, ctx, pi);
    case 'tags':
      return setRule(r.tags, rule, true);
    case 'folders':
      return setRule(r.folders, rule, false);
    case 'type':
      return typeRule(r, rule);
    case 'rating':
      return ratingRule(Number(r.star) || 0, rule);
    case 'shape':
      return shapeRule(r, rule);
    case 'color':
      return smartColorRule(r.palettes, rule);
    case 'fontActivated':
      return false; // depends on the OS's installed fonts; there is no Linux definition yet
    default:
      throw new RuleError(`unknown property ${String(rule.property)}`); // Eagle: TypeError, item not in folder
  }
}

class RuleError extends Error {}

const pf = (v: unknown): number => parseFloat(String(v));
const pi = (v: unknown): number => parseInt(String(v), 10);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const numOrNaN = (v: unknown): number => (typeof v === 'number' ? v : NaN);
const rawMeta = (r: Rec, key: string): unknown =>
  r.rawMetas && typeof r.rawMetas === 'object' ? (r.rawMetas as Rec)[key] : undefined;

/** The n-th number in text like "f/2.8" or "1/200"; NaN if absent. */
function nthNumber(text: unknown, n: number): number {
  if (typeof text !== 'string' && typeof text !== 'number') return NaN;
  const m = String(text).match(/\d+(?:\.\d+)?/g);
  return m && m[n] !== undefined ? parseFloat(m[n]) : NaN;
}

/**
 * name, url, note, folder names, camera. Both sides lowercased. An empty value never matches
 * (except with `empty` / `not-empty`). startWith / endWith use the value as a raw, unescaped regex
 * (Eagle does; an invalid one throws and empties the folder). `regex` lowercases the pattern too
 * (so `\D` becomes `\d`) and an invalid pattern just doesn't match.
 */
function stringRule(text: string, rule: SmartRule): boolean {
  const method = rule.method;
  if (method === 'empty') return text === '';
  if (method === 'not-empty') return text !== '';
  const t = text.toLowerCase();
  const v = String(rule.value ?? '').toLowerCase();
  if (v === '') return false;
  switch (method) {
    case 'equal':
      return t === v;
    case 'contain':
      return t.includes(v);
    case 'uncontain':
      return !t.includes(v);
    case 'startWith':
      return new RegExp('^' + v, 'i').test(t);
    case 'endWith':
      return new RegExp(v + '$', 'i').test(t);
    case 'regex':
      try {
        return new RegExp(v).test(t);
      } catch {
        return false;
      }
    default:
      return false; // a method that doesn't belong to this family (Eagle's editor can save these)
  }
}

/** Region comments joined with no separator, NOT lowercased. */
function commentsRule(comments: unknown, rule: SmartRule): boolean {
  const list = Array.isArray(comments) ? (comments as { annotation?: unknown }[]) : null;
  const method = rule.method;
  if (method === 'empty') return !list || list.length === 0;
  if (method === 'not-empty') return !!list && list.length > 0;
  if (!list) return false; // no comments array fails every other method, `uncontain` included
  const text = list.map((c) => str(c?.annotation)).join('');
  const v = String(rule.value ?? ''); // no empty-value guard here: `contain ""` matches anything with comments
  switch (method) {
    case 'equal':
      return text === v;
    case 'contain':
      return text.includes(v);
    case 'uncontain':
      return !text.includes(v);
    case 'startWith':
      return new RegExp('^' + v, 'i').test(text);
    case 'endWith':
      return new RegExp(v + '$', 'i').test(text);
    case 'regex':
      try {
        return new RegExp(v).test(text);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/** `value` is [n1, n2]; the UI fills n2 only for `between`. NaN (missing data or value) never matches. */
function numericRule(x: number, rule: SmartRule, parse: (v: unknown) => number): boolean {
  const arr = Array.isArray(rule.value) ? rule.value : [rule.value];
  const v0 = parse(arr[0]);
  switch (rule.method) {
    case '>':
      return x > v0;
    case '>=':
      return x >= v0;
    case '<':
      return x < v0;
    case '<=':
      return x <= v0;
    case '=':
      return x === v0;
    case 'between':
      return v0 <= x && x <= parse(arr[1]);
    default:
      return false;
  }
}

const sameLocalDay = (a: number, b: number): boolean =>
  new Date(a).toDateString() === new Date(b).toDateString();

/**
 * Values are epoch ms of a local midnight. `before` and `after` include the chosen day, `between`
 * includes both end days, `within` is a rolling window of N x 24h. A half-filled rule
 * ([] or "") never matches.
 */
function dateRule(
  t: number,
  rule: SmartRule,
  ctx: EvalContext,
  parse: (v: unknown) => number,
): boolean {
  if (!Number.isFinite(t)) return false;
  const arr = Array.isArray(rule.value) ? rule.value : [];
  const d0 = parse(arr[0]);
  switch (rule.method) {
    case 'on':
      return sameLocalDay(t, d0);
    case 'before':
      return t <= d0 + DAY;
    case 'after':
      return t >= d0;
    case 'between':
      return d0 <= t && t <= parse(arr[1]) + DAY;
    case 'within':
      return t + d0 * DAY >= (ctx.now ?? Date.now());
    default:
      return false;
  }
}

/**
 * tags and folders: exact, case-sensitive; folders look at direct membership only (subfolders are
 * not included). `identity` is misleading: it means the item has NONE of the values. A record
 * without the list at all fails every method, `empty` included.
 */
function setRule(list: unknown, rule: SmartRule, isTags: boolean): boolean {
  if (!Array.isArray(list)) return false;
  const vals = Array.isArray(rule.value) ? (rule.value as unknown[]) : [];
  switch (rule.method) {
    case 'union':
      return vals.some((v) => list.includes(v));
    case 'intersection':
      if (isTags && vals.length === 0) return false; // for folders an empty list matches everything
      return vals.every((v) => list.includes(v));
    case 'equal':
      if (isTags && vals.length === 0) return false; // Eagle's equal is "intersection and same length"
      return vals.every((v) => list.includes(v)) && list.length === vals.length;
    case 'identity':
      return !vals.some((v) => list.includes(v));
    case 'empty':
      return list.length === 0;
    case 'not-empty':
      return list.length > 0;
    default:
      return false;
  }
}

function typeRule(r: Rec, rule: SmartRule): boolean {
  const method = rule.method;
  if (method !== 'equal' && method !== 'unequal') return false;
  const value = String(rule.value ?? '');
  const ext = str(r.ext);
  if (ext === value) return method === 'equal';
  let inGroup: boolean;
  if (Object.hasOwn(TYPE_GROUPS, value)) inGroup = TYPE_GROUPS[value].includes(ext);
  else if (value === 'url') inGroup = ext === 'url' && !r.medium;
  else if (BOOKMARK_MEDIA.includes(value)) inGroup = ext === 'url' && r.medium === value;
  else inGroup = false; // any other value is a plain extension and ext !== value already
  return method === 'equal' ? inGroup : !inGroup;
}

/**
 * "none" = unrated, "1".."5" = that star count. Eagle reads the value with parseInt and treats
 * anything that is not a positive number (none, 0, junk) as "unrated", so `equal` on junk finds
 * the unrated items.
 */
const ratingTarget = (v: string): number => parseInt(v, 10) || 0;

function ratingRule(star: number, rule: SmartRule): boolean {
  const v = String(rule.value ?? '');
  switch (rule.method) {
    case 'equal':
      return star === ratingTarget(v);
    case 'unequal':
      return star !== ratingTarget(v);
    case 'contain':
      // Free-text substring test: "345" matches 3, 4 and 5 stars, and any "none" matches everything
      // (an Eagle bug we copy). An unrated item only ever matches through "none".
      return v.includes('none') || (star !== 0 && v.includes(String(star)));
    default:
      return false;
  }
}

/**
 * Exclusive shapes. Panoramic starts at 2.5:1. Eagle compares the raw fields, so an item with no
 * width and no height at all counts as "square" (undefined === undefined); with only one of them
 * it has no shape. Copied, so counts match Eagle's.
 */
function shapeRule(r: Rec, rule: SmartRule): boolean {
  const w = r.width as number;
  const h = r.height as number;
  if (rule.value === 'custom') {
    if (!rule.width || !rule.height) return false; // false for `unequal` too, like Eagle
    const eq = Number(rule.width) / Number(rule.height) === w / h;
    return rule.method === 'equal' ? eq : rule.method === 'unequal' ? !eq : false;
  }
  if (rule.method !== 'equal' && rule.method !== 'unequal') return false;
  let shape: string | undefined;
  if (w > h) shape = w / h >= 2.5 ? 'panoramic-landscape' : 'landscape';
  else if (w < h) shape = h / w >= 2.5 ? 'panoramic-portrait' : 'portrait';
  else if (w === h) shape = 'square';
  return rule.method === 'equal' ? shape === rule.value : shape !== rule.value;
}

const de00 = differenceCiede2000();

/**
 * sRGB to CIELAB (D65) with every component rounded to a whole number. Eagle feeds whole-number
 * Lab values to its color distance, and that rounding moves borderline swatches across the
 * threshold, so the smart folder color rule has to do the same to give Eagle's counts.
 */
function eagleLab(c: number[]): { l: number; a: number; b: number } {
  const lin = (v: number): number => {
    const x = v / 255;
    return x > 0.04045 ? ((x + 0.055) / 1.055) ** 2.4 : x / 12.92;
  };
  const [r, g, b] = c.map(lin);
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
  const y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
  const z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return {
    l: Math.round(116 * y - 16),
    a: Math.round(500 * (x - y)),
    b: Math.round(200 * (y - z)),
  };
}

/**
 * Eagle's smart-folder color rule (NOT the filter bar's): the first palette color must cover 33%+
 * and be near the target, then the first or second color must be an exact match, or (ratio > 33)
 * within CIEDE2000 < T and CIE76 < T + 50. T = 20 for `similar`, 10 for `accuracy`.
 * `value` is parsed by slicing "#RRGGBB", so shorthand gives a wrong color, as in Eagle.
 */
function smartColorRule(palettes: unknown, rule: SmartRule): boolean {
  if (!Array.isArray(palettes) || palettes.length === 0) return false;
  const pal = palettes as { color?: number[]; ratio?: number }[];
  if (rule.method === 'grayscale') {
    return pal
      .filter((p) => Number(p.ratio) >= 0.02)
      .every((p) => p.color && Math.max(...p.color) - Math.min(...p.color) < 8);
  }
  const T = rule.method === 'accuracy' ? 10 : 20;
  const v = String(rule.value ?? '');
  const target = [
    parseInt(v.slice(1, 3), 16),
    parseInt(v.slice(3, 5), 16),
    parseInt(v.slice(5, 7), 16),
  ];
  const p0 = pal[0];
  if (!p0.color || !(Number(p0.ratio) >= 33)) return false;
  if (p0.color.some((c, i) => Math.abs(c - target[i]) > 96)) return false;
  const exact = (p?: { color?: number[] }): boolean =>
    !!p?.color && p.color.every((c, i) => c === target[i]);
  if (pal[1] && (exact(p0) || exact(pal[1]))) return true; // Eagle only runs this check when both exist
  const t = eagleLab(target);
  const tLab = { mode: 'lab65' as const, ...t };
  for (const p of [p0, pal[1]]) {
    if (!p?.color || !(Number(p.ratio) > 33)) continue;
    const c = eagleLab(p.color);
    if (
      de00(tLab, { mode: 'lab65', ...c }) < T &&
      Math.hypot(t.l - c.l, t.a - c.a, t.b - c.b) < T + 50
    )
      return true;
  }
  return false;
}

// ─────────────────────────── SQL compiler ───────────────────────────

const ASCII = /^[\x00-\x7f]*$/;
const ONE_OR_ZERO = (expr: string, ...params: unknown[]): SqlFrag =>
  frag(`COALESCE((${expr}), 0)`, ...params);

const STRING_COLUMNS: Record<string, string> = {
  name: 'i.name',
  url: 'i.url',
  annotation: 'i.annotation',
};

function compileString(col: string, rule: SmartRule): SqlFrag | null {
  if (rule.method === 'empty') return frag(`(${col} = '')`);
  if (rule.method === 'not-empty') return frag(`(${col} <> '')`);
  const v = String(rule.value ?? '');
  if (v === '') return FALSE;
  if (!ASCII.test(v)) return null; // SQLite lower() only folds ASCII
  const lv = v.toLowerCase();
  switch (rule.method) {
    case 'equal':
      return frag(`(lower(${col}) = ?)`, lv);
    case 'contain':
      return frag(`(instr(lower(${col}), ?) > 0)`, lv);
    case 'uncontain':
      return frag(`(instr(lower(${col}), ?) = 0)`, lv);
    case 'startWith':
    case 'endWith':
    case 'regex':
      return null; // regex semantics stay in JS
    default:
      return FALSE;
  }
}

function compileNumeric(value: string, guard: string | null, rule: SmartRule): SqlFrag | null {
  const arr = Array.isArray(rule.value) ? rule.value : [rule.value];
  const v0 = parseFloat(arr[0] as string);
  const g = guard ? `${guard} AND ` : '';
  switch (rule.method) {
    case '>':
    case '>=':
    case '<':
    case '<=':
      return Number.isNaN(v0) ? FALSE : ONE_OR_ZERO(`${g}${value} ${rule.method} ?`, v0);
    case '=':
      return Number.isNaN(v0) ? FALSE : ONE_OR_ZERO(`${g}${value} = ?`, v0);
    case 'between': {
      const v1 = parseFloat(arr[1] as string);
      return Number.isNaN(v0) || Number.isNaN(v1)
        ? FALSE
        : ONE_OR_ZERO(`${g}${value} >= ? AND ${value} <= ?`, v0, v1);
    }
    default:
      return FALSE;
  }
}

function compileDate(t: string, rule: SmartRule, now: number): SqlFrag | null {
  const arr = Array.isArray(rule.value) ? rule.value : [];
  const d0 = parseFloat(arr[0] as string);
  switch (rule.method) {
    case 'on': {
      if (Number.isNaN(new Date(d0).getTime())) return FALSE;
      const d = new Date(d0);
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
      return frag(`(${t} >= ? AND ${t} < ?)`, start, end);
    }
    case 'before':
      return Number.isNaN(d0) ? FALSE : frag(`(${t} <= ?)`, d0 + DAY);
    case 'after':
      return Number.isNaN(d0) ? FALSE : frag(`(${t} >= ?)`, d0);
    case 'between': {
      const d1 = parseFloat(arr[1] as string);
      return Number.isNaN(d0) || Number.isNaN(d1)
        ? FALSE
        : frag(`(${t} >= ? AND ${t} <= ?)`, d0, d1 + DAY);
    }
    case 'within':
      return Number.isNaN(d0) ? FALSE : frag(`(${t} + ? >= ?)`, d0 * DAY, now);
    default:
      return FALSE;
  }
}

function compileTags(rule: SmartRule): SqlFrag | null {
  if (rule.method === 'empty') return frag('(i.tag_count = 0)');
  if (rule.method === 'not-empty') return frag('(i.tag_count > 0)');
  if (!Array.isArray(rule.value) || !rule.value.every((v) => typeof v === 'string')) return null;
  const vals = rule.value as string[];
  const distinct = [...new Set(vals)];
  const has = (): SqlFrag =>
    frag(
      `EXISTS (SELECT 1 FROM item_tags t WHERE t.item_rowid = i.rowid AND t.tag IN (${placeholders(vals.length)}))`,
      ...vals,
    );
  const countIn = `(SELECT COUNT(*) FROM item_tags t WHERE t.item_rowid = i.rowid AND t.tag IN (${placeholders(vals.length)}))`;
  switch (rule.method) {
    case 'union':
      return vals.length === 0 ? FALSE : has();
    case 'intersection':
      return vals.length === 0 ? FALSE : frag(`(${countIn} = ?)`, ...vals, distinct.length);
    case 'equal':
      if (distinct.length !== vals.length) return null; // Eagle's length quirk with repeated values: leave to JS
      return vals.length === 0
        ? FALSE
        : frag(`(${countIn} = ? AND i.tag_count = ?)`, ...vals, vals.length, vals.length);
    case 'identity':
      return vals.length === 0 ? TRUE : not(has());
    default:
      return FALSE;
  }
}

function compileType(rule: SmartRule): SqlFrag | null {
  if (rule.method !== 'equal' && rule.method !== 'unequal') return FALSE;
  if (typeof rule.value !== 'string') return null;
  const value = rule.value;
  if (value === 'url' || BOOKMARK_MEDIA.includes(value)) return null; // needs `medium`, which is not a column
  const exts = Object.hasOwn(TYPE_GROUPS, value) ? TYPE_GROUPS[value] : [];
  const eq = frag(
    `(i.ext = ?${exts.length ? ` OR i.ext IN (${placeholders(exts.length)})` : ''})`,
    value,
    ...exts,
  );
  return rule.method === 'equal' ? eq : not(eq);
}

function compileRating(rule: SmartRule): SqlFrag | null {
  const v = String(rule.value ?? '');
  switch (rule.method) {
    case 'equal':
      return frag('(i.star = ?)', ratingTarget(v));
    case 'unequal':
      return frag('(i.star <> ?)', ratingTarget(v));
    case 'contain':
      return v.includes('none')
        ? TRUE
        : frag('(i.star <> 0 AND instr(?, CAST(i.star AS TEXT)) > 0)', v);
    default:
      return FALSE;
  }
}

// Eagle's shape test on the raw fields (see shapeRule). Ratios are compared by multiplying through, which
// gives the same answer as Eagle's division for whole-number sizes and also covers a zero side.
const SHAPE_SQL: Record<string, string> = {
  square: '(i.width IS NULL AND i.height IS NULL) OR i.width = i.height',
  landscape: 'i.width > i.height AND i.width < 2.5 * i.height',
  'panoramic-landscape': 'i.width > i.height AND i.width >= 2.5 * i.height',
  portrait: 'i.height > i.width AND i.height < 2.5 * i.width',
  'panoramic-portrait': 'i.height > i.width AND i.height >= 2.5 * i.width',
};

function compileShape(rule: SmartRule): SqlFrag | null {
  const v = String(rule.value ?? '');
  if (v === 'custom') return null;
  if (rule.method !== 'equal' && rule.method !== 'unequal') return FALSE;
  const cond = Object.hasOwn(SHAPE_SQL, v) ? SHAPE_SQL[v] : null;
  const eq = cond ? frag(`COALESCE((${cond}), 0)`) : FALSE;
  return rule.method === 'equal' ? eq : not(eq);
}

/** null = not expressible exactly in SQL; the JS evaluator decides. */
function compileRule(rule: SmartRule, now: number): SqlFrag | null {
  switch (rule.property) {
    case 'name':
    case 'url':
    case 'annotation':
      return compileString(STRING_COLUMNS[rule.property], rule);
    case 'width':
      return compileNumeric('i.width', null, rule);
    case 'height':
      return compileNumeric('i.height', null, rule);
    case 'fileSize':
      return compileNumeric(
        `(i.size / ${rule.unit === 'kb' ? '1024.0' : '1048576.0'})`,
        null,
        rule,
      );
    case 'duration':
      return compileNumeric(
        `(i.duration / ${rule.unit === 'h' ? '3600.0' : rule.unit === 'm' ? '60.0' : '1.0'})`,
        'i.duration IS NOT NULL AND i.duration <> 0',
        rule,
      );
    case 'createTime':
      return compileDate('i.imported_at', rule, now);
    case 'mtime':
      return compileDate('(CASE WHEN i.mtime <> 0 THEN i.mtime ELSE i.imported_at END)', rule, now);
    case 'btime':
      return compileDate('(CASE WHEN i.btime <> 0 THEN i.btime ELSE i.imported_at END)', rule, now);
    case 'tags':
      return compileTags(rule);
    case 'type':
      return compileType(rule);
    case 'rating':
      return compileRating(rule);
    case 'shape':
      return compileShape(rule);
    default:
      return null;
  }
}

function compileCondition(c: SmartCondition, now: number): SqlFrag | null {
  const rules = Array.isArray(c.rules) ? c.rules : [];
  const parts: SqlFrag[] = [];
  for (const rule of rules) {
    const f = compileRule(rule, now);
    if (!f) return null;
    parts.push(f);
  }
  const body = parts.length === 0 ? TRUE : joinFrags(parts, c.match === 'OR' ? 'OR' : 'AND');
  return c.boolean === 'FALSE' ? not(body) : body;
}

export interface CompiledSmartFolder extends SqlFrag {
  /** true: the SQL alone is the whole answer. false: it is a superset; run the evaluator on the rows it returns. */
  exact: boolean;
}

/**
 * SQL over `items` (alias `i`) for one smart folder including its ancestors' conditions. It does
 * NOT filter trashed items; the caller adds `i.is_deleted = 0`.
 */
export function compileSmartFolder(
  folder: EagleSmartFolderRecord,
  ancestors: EagleSmartFolderRecord[],
  now: number = Date.now(),
): CompiledSmartFolder {
  if ((folder.conditions ?? []).length === 0) {
    const kids = folder.children ?? [];
    if (kids.length === 0) return { ...FALSE, exact: true };
    const chain = [...ancestors, folder];
    const parts = kids.map((k) => compilePassing(k, chain, now));
    return { ...joinFrags(parts, 'OR'), exact: parts.every((p) => p.exact) };
  }
  return compilePassing(folder, ancestors, now);
}

/** The folder's own conditions plus every ancestor's (mirrors `passes`; no group handling). */
function compilePassing(
  node: EagleSmartFolderRecord,
  ancestors: EagleSmartFolderRecord[],
  now: number,
): CompiledSmartFolder {
  const all = [...ancestors.flatMap((a) => a.conditions ?? []), ...(node.conditions ?? [])];
  const compiled = all.map((c) => compileCondition(c, now));
  const usable = compiled.filter((f): f is SqlFrag => f !== null);
  return { ...joinFrags(usable, 'AND'), exact: usable.length === all.length };
}
