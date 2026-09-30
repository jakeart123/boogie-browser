// Eagle's saved filters (saved-filters.json) <-> Boogie's FilterSpec. Pure.
//
// An entry's `rule` is a snapshot of Eagle's filter bar, applied with a SHALLOW merge over its
// defaults ({...defaultRules, ...rule}), so every section we write goes in whole. Editing a filter
// here rewrites only the sections whose Boogie fields changed: every other section stays byte for
// byte, including what Boogie can't apply (camera, fonts, BPM, search by image, AI search, web-video
// types, separate months, "today") and keys from a newer Eagle. research/format-notes/
// smartfolders-filters.md "saved-filters.json" and Eagle's filterData (app.bundle.js) are the
// reference.
import type { FilterSpec, RangeFilter, Shape } from '../../../shared/types';
import { stringList } from '../project';

export type EagleRule = Record<string, unknown>;
type Obj = Record<string, unknown>;

const DAY = 86_400_000;
/** Eagle needs both ends of a date range; this stands in for "no end". */
const FAR_FUTURE = 32_503_680_000_000; // year 3000

const ROLLING: [flag: string, days: number][] = [
  ['last7day', 7],
  ['last30day', 30],
  ['last90day', 90],
  ['last365day', 365],
];

const SHAPE_FLAGS: [flag: string, shape: Shape][] = [
  ['portrait', 'portrait'],
  ['landscape', 'landscape'],
  ['square', 'square'],
  ['panoramicPortrait', 'panoramic-portrait'],
  ['panoramicLandscape', 'panoramic-landscape'],
];
const ASPECT_FLAGS: [flag: string, w: number, h: number][] = [
  ['43', 4, 3],
  ['34', 3, 4],
  ['169', 16, 9],
  ['916', 9, 16],
];

/** Eagle's type groups that Boogie can't tell apart (it would need the item's `medium`). */
const WEB_VIDEO_TYPES = new Set(['youtube', 'vimeo', 'bilibili']);

// ───────────────────────── small readers (the file is untrusted) ─────────────────────────

const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};

const truthyKeys = (v: unknown): string[] =>
  Object.entries(obj(v))
    .filter(([, x]) => !!x)
    .map(([k]) => k);

/** jQuery's isNumeric, which Eagle uses: a finite number or a numeric string. */
function numeric(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function range(min: number | null, max: number | null): RangeFilter | undefined {
  if (min === null && max === null) return undefined;
  return { ...(min !== null ? { min } : {}), ...(max !== null ? { max } : {}) };
}

const hasRange = (r?: RangeFilter): r is RangeFilter =>
  !!r && (r.min !== undefined || r.max !== undefined);

// ───────────────────────── dates ─────────────────────────

type Interval = [number, number];

const localMidnight = (now: number, daysBack = 0): number => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysBack);
  return d.getTime();
};

/**
 * Sorted intervals -> one span, and whether it has a gap (then the filter can't be one range).
 * Eagle's "today" and "yesterday" both leave out the midnight millisecond between them, so a 1 ms
 * hole is not a gap.
 */
function hull(list: Interval[]): { span: Interval; gap: boolean } | null {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a[0] - b[0]);
  let gap = false;
  let [lo, hi] = sorted[0];
  for (const [a, b] of sorted.slice(1)) {
    if (a > hi + 2) gap = true;
    hi = Math.max(hi, b);
    lo = Math.min(lo, a);
  }
  return { span: [lo, hi], gap };
}

/**
 * One date section (`import` or `mtime`). The flags are ORed with each other; the selected months
 * are a separate AND filter. `rangeFrom` is where the custom range lives: Eagle reads
 * `import.range` even for `mtime` (a bug we have to follow).
 */
function readDates(
  section: Obj,
  rangeFrom: unknown,
  now: number,
  what: string,
  unsupported: string[],
): { within?: number; range?: RangeFilter } {
  const out: { within?: number; range?: RangeFilter } = {};
  const intervals: Interval[] = [];
  const rolling = ROLLING.filter(([flag]) => section[flag]).map(([, days]) => days);
  const today = localMidnight(now);
  if (section.today) intervals.push([today + 1, FAR_FUTURE]);
  if (section.yesterday) intervals.push([localMidnight(now, 1) + 1, today - 1]);
  const r = Array.isArray(rangeFrom) ? rangeFrom : null;
  const custom = section.usingRange && r && numeric(r[0]) && numeric(r[1]);
  if (custom) intervals.push([numeric(r[0])!, numeric(r[1])! + DAY]);

  if (rolling.length) {
    // Today and yesterday are inside every rolling window; a custom range may not be.
    out.within = Math.max(...rolling);
    if (custom) unsupported.push(`${what}: a date range together with "last days"`);
  } else {
    const h = hull(intervals);
    if (h) {
      // Boogie writes 1 and FAR_FUTURE for an open end (Eagle wants both ends).
      out.range = range(
        h.span[0] <= 1 ? null : h.span[0],
        h.span[1] >= FAR_FUTURE ? null : h.span[1],
      );
      if (h.gap) unsupported.push(`${what}: several separate dates`);
    }
  }

  // Selected months ("YYYY/MM"), ANDed with the rest.
  const months: Interval[] = [];
  for (const key of truthyKeys(section.selectedMonths)) {
    const m = /^(\d{4})\/(\d{2})$/.exec(key);
    if (!m) continue;
    const start = new Date(Number(m[1]), Number(m[2]) - 1, 1).getTime();
    const end = new Date(Number(m[1]), Number(m[2]), 1).getTime() - 1;
    months.push([start, end]);
  }
  const mh = hull(months);
  if (mh) {
    if (mh.gap) unsupported.push(`${what}: months that aren't next to each other`);
    const lo = Math.max(out.range?.min ?? -Infinity, mh.span[0]);
    const hi = Math.min(out.range?.max ?? Infinity, mh.span[1]);
    out.range = range(lo, hi);
  }
  return out;
}

// ───────────────────────── Eagle rule -> FilterSpec ─────────────────────────

/** What Boogie can apply of an Eagle saved filter, plus plain-English names for what it can't. */
export function eagleRuleToFilter(
  rawRule: unknown,
  now: number,
): { filter: FilterSpec; unsupported: string[] } {
  const rule = obj(rawRule);
  const filter: FilterSpec = {};
  const unsupported: string[] = [];

  if (typeof rule.keyword === 'string' && rule.keyword.trim()) filter.keywords = rule.keyword;

  // types: extensions or Eagle's group names (video, audio, font, powerpoint, word, excel, url...)
  const type = obj(rule.type);
  const types = (list: string[]) => {
    const web = list.filter((t) => WEB_VIDEO_TYPES.has(t));
    if (web.length) unsupported.push(`Type: ${web.join(', ')} links`);
    return list.filter((t) => !WEB_VIDEO_TYPES.has(t));
  };
  const typeIn = types(truthyKeys(type.includes));
  const typeOut = types(truthyKeys(type.excludes));
  if (typeIn.length || typeOut.length) filter.types = { include: typeIn, exclude: typeOut };

  // tags (Eagle doesn't save its any/all toggle; "any" is its default). With the default toggle
  // Eagle keeps an item that has an included tag OR lacks the excluded ones; Boogie wants both.
  const tag = obj(rule.tag);
  const tagIn = stringList(tag.includes);
  const tagOut = stringList(tag.excludes);
  if (tagIn.length || tagOut.length) filter.tags = { mode: 'any', include: tagIn, exclude: tagOut };
  if (tagIn.length && tagOut.length) unsupported.push(EITHER.tags);
  if (tag.no) filter.noTags = true;

  // folders: a map of id -> folder object; only `.id` counts. "NoFolders" = unfiled.
  const folder = obj(rule.folder);
  const folderIds = (v: unknown) =>
    Object.entries(obj(v))
      .filter(([, f]) => !!f)
      .map(([key, f]) => {
        const id = obj(f).id;
        return typeof id === 'string' && id ? id : key;
      });
  const fIn = folderIds(folder.includes);
  const fOut = folderIds(folder.excludes);
  if (fIn.includes('NoFolders')) filter.unfiled = true;
  const realIn = fIn.filter((id) => id !== 'NoFolders');
  if (realIn.length || fOut.length) filter.folders = { include: realIn, exclude: fOut };
  if (fIn.length && fOut.length) unsupported.push(EITHER.folders);

  // dates
  const imp = obj(rule.import);
  const mt = obj(rule.mtime);
  const imported = readDates(imp, imp.range, now, 'Date imported', unsupported);
  // mtime.range only exists in files Boogie wrote; Eagle itself reads import.range for both.
  const modified = readDates(mt, mt.range ?? imp.range, now, 'Date modified', unsupported);
  if (imported.within) filter.importedWithinDays = imported.within;
  if (imported.range) filter.importedAt = imported.range;
  if (modified.within) filter.modifiedWithinDays = modified.within;
  if (modified.range) filter.modifiedAt = modified.range;

  // rating: "0" is unrated
  const stars = truthyKeys(rule.rating)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 5);
  if (stars.length) filter.rating = [...new Set(stars)].sort();

  // color: an [r, g, b] array (a hex string is tolerated); accuracy is Eagle's CIEDE2000 limit
  const color = obj(rule.color);
  const rgb = rgbOf(color.value);
  if (rgb) filter.color = { rgb, tolerance: toleranceOf(numeric(color.accuracy) ?? 20) };
  if (color.gray) filter.grayscale = true;

  // shape: the flags are ORed. Boogie ANDs shapes with one aspect ratio, so shapes and ratios
  // together (or several ratios) can't be said exactly.
  const shape = obj(rule.shape);
  const shapes = SHAPE_FLAGS.filter(([flag]) => shape[flag]).map(([, s]) => s);
  if (shapes.length) filter.shapes = shapes;
  const aspects: { w: number; h: number }[] = ASPECT_FLAGS.filter(([flag]) => shape[flag]).map(
    ([, w, h]) => ({ w, h }),
  );
  const cw = numeric(shape.width);
  const ch = numeric(shape.height);
  if (shape.custom && cw && ch && cw > 0 && ch > 0) aspects.push({ w: cw, h: ch });
  if (aspects.length) {
    if (shapes.length || aspects.length > 1)
      unsupported.push('Shape: several shapes and aspect ratios together');
    if (!shapes.length) filter.aspect = { ...aspects[0], tolerance: 0 }; // Eagle compares exactly
  }

  // sizes. Eagle rounds down after applying the unit (parseInt).
  const res = obj(rule.resolution);
  const int = (v: unknown) => (numeric(v) === null ? null : Math.trunc(numeric(v)!));
  const width = range(int(res.minW), int(res.maxW));
  const height = range(int(res.minH), int(res.maxH));
  if (width) filter.width = width;
  if (height) filter.height = height;
  const file = obj(rule.file);
  const fileUnit = file.unit === 'mb' ? MB : 1024;
  const scaled = (v: unknown, unit: number) =>
    numeric(v) === null ? null : Math.trunc(numeric(v)! * unit);
  const fileSize = range(scaled(file.min, fileUnit), scaled(file.max, fileUnit));
  if (fileSize) filter.fileSize = fileSize;
  const dur = obj(rule.duration);
  const durUnit = dur.unit === 'h' ? 3600 : dur.unit === 'm' ? 60 : 1;
  const duration = range(scaled(dur.min, durUnit), scaled(dur.max, durUnit));
  if (duration) filter.duration = duration;

  // text fields: `note` is the item's note, `annotation` its region comments (flipped names)
  const text = (
    v: unknown,
    label: string,
    set: (has: boolean | undefined, contains: string | undefined) => void,
  ) => {
    const o = obj(v);
    if (o.has) {
      const kw = typeof o.keywords === 'string' ? o.keywords : '';
      // Eagle splits the keywords on commas and wants every one; Boogie matches one phrase.
      const parts = kw.split(',').filter((k) => k.length);
      if (parts.length > 1) unsupported.push(`${label} containing all of: ${parts.join(', ')}`);
      set(true, parts[0]);
    } else if (o.no) set(false, undefined);
  };
  text(rule.note, 'Note', (has, c) => {
    filter.hasNote = has;
    if (c) filter.noteContains = c;
  });
  text(rule.url, 'Link', (has, c) => {
    filter.hasUrl = has;
    if (c) filter.urlContains = c;
  });
  text(rule.annotation, 'Comments', (has, c) => {
    filter.hasComments = has;
    if (c) filter.commentContains = c;
  });

  // Eagle-only parts
  const font = obj(rule.font);
  if (font.activated || font.deactivated) unsupported.push('Font installed or not');
  if (truthyKeys(rule.camera).length) unsupported.push('Camera');
  const bpm = obj(rule.bpm);
  if (numeric(bpm.min) !== null || numeric(bpm.max) !== null) unsupported.push('BPM');
  const image = obj(rule.image);
  if (image.itemId || image.base64) unsupported.push('Search by image');
  if (obj(rule.semantic).value) unsupported.push('AI search');

  return { filter, unsupported };
}

const EITHER = {
  tags: 'Tags: Eagle shows items with an included tag OR without the excluded ones',
  folders: 'Folders: Eagle shows items in an included folder OR outside the excluded ones',
};

const MB = 1_048_576;
const toleranceOf = (accuracy: number) => (accuracy <= 10 ? 'close' : 'similar');

function rgbOf(v: unknown): [number, number, number] | null {
  if (Array.isArray(v) && v.length >= 3) {
    const c = v.slice(0, 3).map(Number);
    return c.every((x) => Number.isFinite(x))
      ? (c.map((x) => Math.round(x)) as [number, number, number])
      : null;
  }
  if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v))
    return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)) as [number, number, number];
  return null;
}

// ───────────────────────── FilterSpec -> Eagle rule ─────────────────────────

// Eagle's default sections, with its `undefined` slots kept so a key we set lands where Eagle's own
// filter bar would put it (JSON drops the slots that stay empty).
const DATE_FLAGS = {
  today: false,
  yesterday: false,
  last7day: false,
  last30day: false,
  last90day: false,
  last365day: false,
  usingRange: false,
};
const SHAPE_DEFAULT_FLAGS = {
  portrait: false,
  landscape: false,
  square: false,
  panoramicPortrait: false,
  panoramicLandscape: false,
  '43': false,
  '34': false,
  '169': false,
  '916': false,
  custom: false,
};

const DEFAULTS = {
  type: () => ({ includes: {}, excludes: {} }),
  tag: () => ({ no: false, includes: [], excludes: [] }),
  folder: () => ({ includes: {}, excludes: {} }),
  font: () => ({ activated: false, deactivated: false }),
  camera: () => ({}),
  // Eagle's mtime has no `range` slot; Boogie keeps its own there too (see linkRanges).
  import: () => ({
    ...DATE_FLAGS,
    range: undefined,
    type: 'undefined',
    model: undefined,
    selectedMonths: {},
  }),
  mtime: () => ({
    ...DATE_FLAGS,
    range: undefined,
    type: 'undefined',
    model: undefined,
    selectedMonths: {},
  }),
  rating: () => ({ '1': false, '2': false, '3': false, '4': false, '5': false, '0': false }),
  color: () => ({ gray: false, value: undefined, accuracy: 20 }),
  shape: () => ({ ...SHAPE_DEFAULT_FLAGS, width: 4, height: 3 }),
  resolution: () => ({ minW: undefined, maxW: undefined, minH: undefined, maxH: undefined }),
  file: () => ({ min: undefined, max: undefined, unit: 'kb' }),
  duration: () => ({ min: undefined, max: undefined, unit: 's' }),
  bpm: () => ({ min: undefined, max: undefined }),
  annotation: () => ({ has: false, no: false, keywords: undefined }),
  note: () => ({ has: false, no: false, keywords: undefined }),
  url: () => ({ has: false, no: false, keywords: undefined }),
  image: () => ({ itemId: undefined, base64: undefined }),
  semantic: () => ({ value: undefined }),
};

/** Eagle's filter bar with nothing set, every section complete. */
export function defaultEagleRule(): EagleRule {
  return Object.fromEntries(Object.entries(DEFAULTS).map(([k, make]) => [k, make()]));
}

/** A rewritten section: Eagle's key order, the old section's other keys kept, then our values. */
const section = (defaults: Obj, old: Obj, values: Obj): Obj =>
  Object.assign({ ...defaults, ...old }, values);

/** Eagle's custom range is two local-midnight dates, inclusive of the whole end day. */
function writeRange(r: RangeFilter): [number, number] {
  return [
    typeof r.min === 'number' ? r.min : 1,
    typeof r.max === 'number' ? r.max - DAY : FAR_FUTURE,
  ];
}

/** "Last N days" only comes in four sizes in Eagle: the smallest one that covers N. */
function rollingFlag(days: number): [flag: string, days: number] {
  return ROLLING.find(([, d]) => d >= days) ?? ROLLING[ROLLING.length - 1];
}

type FolderNamer = (id: string) => string | undefined;

function writeDates(
  make: () => Obj,
  old: Obj,
  within: number | undefined,
  at: RangeFilter | undefined,
): Obj {
  const values: Obj = { ...DATE_FLAGS, type: 'undefined', model: undefined, selectedMonths: {} };
  values.range = undefined;
  // Eagle ORs the flags of one section, so "last N days" and a range can't both be said (Boogie
  // ANDs them): the rolling window wins, it's what a saved filter is usually for.
  if (within) values[rollingFlag(within)[0]] = true;
  else if (hasRange(at))
    Object.assign(values, { usingRange: true, type: 'range', range: writeRange(at) });
  return section(make(), old, values);
}

function writeText(make: () => Obj, old: Obj, has: boolean | undefined, contains?: string): Obj {
  const c = contains?.trim() ? contains : undefined;
  const values =
    c !== undefined
      ? { has: true, no: false, keywords: c }
      : { has: has === true, no: has === false, keywords: undefined };
  return section(make(), old, values);
}

/** Section key -> how a FilterSpec is written into it (`old` = the section being replaced). */
const WRITERS: Record<string, (f: FilterSpec, old: Obj, folderName: FolderNamer) => unknown> = {
  keyword: (f) => (f.keywords?.trim() ? f.keywords : undefined),
  type: (f, old) => {
    // Keeps the old order, and the web-video groups Boogie can't apply.
    const map = (was: unknown, list: string[] = []) => {
      const before = truthyKeys(was);
      const keep = before.filter((t) => list.includes(t) || WEB_VIDEO_TYPES.has(t));
      const keys = [...new Set([...keep, ...list])];
      return Object.fromEntries(keys.map((t) => [t, true]));
    };
    return section(DEFAULTS.type(), old, {
      includes: map(old.includes, f.types?.include),
      excludes: map(old.excludes, f.types?.exclude),
    });
  },
  tag: (f, old) =>
    section(DEFAULTS.tag(), old, {
      no: !!f.noTags,
      includes: [...(f.tags?.include ?? [])],
      excludes: [...(f.tags?.exclude ?? [])],
    }),
  folder: (f, old, folderName) => {
    // Eagle keeps whole folder objects here and reads only `.id`: ours are {id, name}.
    const map = (was: unknown, ids: string[]) =>
      Object.fromEntries(
        [...new Set(ids)].map((id) => [
          id,
          obj(was)[id] ?? { id, name: id === 'NoFolders' ? 'Unfiled' : (folderName(id) ?? '') },
        ]),
      );
    const fIn = [...(f.folders?.include ?? []), ...(f.unfiled ? ['NoFolders'] : [])];
    return section(DEFAULTS.folder(), old, {
      includes: map(old.includes, fIn),
      excludes: map(old.excludes, f.folders?.exclude ?? []),
    });
  },
  import: (f, old) => writeDates(DEFAULTS.import, old, f.importedWithinDays, f.importedAt),
  mtime: (f, old) => writeDates(DEFAULTS.mtime, old, f.modifiedWithinDays, f.modifiedAt),
  rating: (f, old) =>
    section(
      DEFAULTS.rating(),
      old,
      Object.fromEntries(
        ['1', '2', '3', '4', '5', '0'].map((k) => [k, !!f.rating?.includes(Number(k))]),
      ),
    ),
  color: (f, old) => {
    // An accuracy that already means the same tolerance stays as Eagle had it (15 is "similar").
    const was = numeric(old.accuracy);
    const accuracy = !f.color
      ? (old.accuracy ?? 20)
      : was !== null && toleranceOf(was) === f.color.tolerance
        ? old.accuracy
        : f.color.tolerance === 'close'
          ? 10
          : 20;
    return section(DEFAULTS.color(), old, {
      gray: !!f.grayscale,
      value: f.color ? [...f.color.rgb] : undefined,
      accuracy,
    });
  },
  shape: (f, old) => {
    const values: Obj = { ...SHAPE_DEFAULT_FLAGS };
    for (const [flag, s] of SHAPE_FLAGS) if (f.shapes?.includes(s)) values[flag] = true;
    if (f.aspect && f.aspect.w > 0 && f.aspect.h > 0) {
      const { w, h } = f.aspect;
      const preset = ASPECT_FLAGS.find(([, pw, ph]) => w * ph === h * pw);
      if (preset) values[preset[0]] = true;
      else Object.assign(values, { custom: true, width: w, height: h });
    }
    return section(DEFAULTS.shape(), old, values);
  },
  resolution: (f, old) =>
    section(DEFAULTS.resolution(), old, {
      minW: f.width?.min,
      maxW: f.width?.max,
      minH: f.height?.min,
      maxH: f.height?.max,
    }),
  file: (f, old) => {
    if (!f.fileSize) return section(DEFAULTS.file(), old, { min: undefined, max: undefined });
    const { min, max } = f.fileSize;
    const ends = [min, max].filter((v): v is number => v !== undefined);
    const mb = ends.length > 0 && ends.every((v) => v % MB === 0);
    const unit = mb ? MB : 1024;
    return section(DEFAULTS.file(), old, {
      min: min !== undefined ? min / unit : undefined,
      max: max !== undefined ? max / unit : undefined,
      unit: mb ? 'mb' : 'kb',
    });
  },
  duration: (f, old) =>
    section(DEFAULTS.duration(), old, {
      min: f.duration?.min,
      max: f.duration?.max,
      ...(f.duration ? { unit: 's' } : {}),
    }),
  note: (f, old) => writeText(DEFAULTS.note, old, f.hasNote, f.noteContains),
  url: (f, old) => writeText(DEFAULTS.url, old, f.hasUrl, f.urlContains),
  annotation: (f, old) => writeText(DEFAULTS.annotation, old, f.hasComments, f.commentContains),
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The sections of `base` whose Boogie fields `f` changes: written from both and compared, so
 * whatever Eagle can't hold anyway (tag mode, an empty list) doesn't count as a change. "Today"
 * reads as a date that moves at midnight, so a filter the UI read yesterday still matches.
 */
function changedSections(
  f: FilterSpec,
  base: EagleRule | undefined,
  folderName: FolderNamer,
  now: number,
): string[] {
  const olds = base
    ? [eagleRuleToFilter(base, now).filter, eagleRuleToFilter(base, now - DAY).filter]
    : [{}];
  return Object.entries(WRITERS)
    .filter(([, write]) => {
      const mine = write(f, {}, folderName);
      return olds.every((o) => !same(write(o, {}, folderName), mine));
    })
    .map(([key]) => key);
}

/**
 * Eagle reads the Date modified range from `import.range` (its bug), so that slot must hold it
 * while Date imported isn't a range itself. `oldImportRange`: the one before this edit, which an
 * Eagle-written modified range lives in.
 */
function linkRanges(rule: EagleRule, oldImportRange: unknown): void {
  const imp = obj(rule.import);
  const mt = obj(rule.mtime);
  if (!mt.usingRange || imp.usingRange) return;
  const r = mt.range ?? oldImportRange;
  if (r !== undefined && !same(imp.range, r))
    rule.import = section(DEFAULTS.import(), imp, { range: r });
}

/**
 * The rule Eagle's filter bar would have saved for this filter. `folderName` names the folder
 * objects Eagle keeps (it only reads `.id`). `base` is the entry's current rule when editing one:
 * only the sections whose Boogie fields changed are rewritten, the rest are kept as they are.
 * `now` is when the UI read the filter (it decides what "today" was).
 */
export function filterToEagleRule(
  f: FilterSpec,
  folderName: FolderNamer,
  base?: EagleRule,
  now = Date.now(),
): EagleRule {
  const b = base === undefined ? undefined : obj(base);
  const rule: EagleRule = b ? structuredClone(b) : defaultEagleRule();
  const changed = changedSections(f, b, folderName, now);
  for (const key of changed) {
    const value = WRITERS[key]!(f, obj(rule[key]), folderName);
    if (value === undefined) delete rule[key];
    else rule[key] = value;
  }
  if (changed.includes('import') || changed.includes('mtime'))
    linkRanges(rule, obj(b?.import).range);
  return rule;
}

/**
 * What of this filter Eagle can't hold, or will apply differently, in plain English (for a
 * warning when it is saved).
 */
export function eagleCaveats(f: FilterSpec): string[] {
  const out: string[] = [];
  const tagIn = f.tags?.include?.length ?? 0;
  if (f.tags?.mode === 'exact' && tagIn)
    out.push("Eagle can't match exactly these tags; it shows items with any of them.");
  else if (f.tags?.mode === 'all' && tagIn > 1)
    out.push('Eagle shows items with any of these tags, not all of them.');
  if (tagIn && f.tags?.exclude?.length) out.push(`${EITHER.tags}.`);
  const folderIn = (f.folders?.include?.length ?? 0) + (f.unfiled ? 1 : 0);
  if (folderIn && f.folders?.exclude?.length) out.push(`${EITHER.folders}.`);
  const dates: [string, number | undefined, RangeFilter | undefined][] = [
    ['Date imported', f.importedWithinDays, f.importedAt],
    ['Date modified', f.modifiedWithinDays, f.modifiedAt],
  ];
  for (const [what, within, at] of dates) {
    if (!within) continue;
    const [, days] = rollingFlag(within);
    if (days !== within)
      out.push(`${what}: Eagle only has the last 7, 30, 90 or 365 days, so it uses ${days}.`);
    if (hasRange(at))
      out.push(`${what}: Eagle can't combine a date range with the last days; it keeps the days.`);
  }
  const [imp, mod] = [f.importedAt, f.modifiedAt];
  if (
    !f.importedWithinDays &&
    !f.modifiedWithinDays &&
    hasRange(imp) &&
    hasRange(mod) &&
    !same(writeRange(imp), writeRange(mod))
  )
    out.push('Eagle keeps one date range for both dates, so it uses the imported range for both.');
  if (f.shapes?.length && f.aspect)
    out.push('Eagle shows items with one of these shapes OR the aspect ratio.');
  return out;
}
