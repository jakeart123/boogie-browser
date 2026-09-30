// The smart folder rule model: which properties exist, which methods each allows, the defaults
// Eagle's editor uses, and the checks that stop a rule from silently matching nothing.
// Source of truth: research/format-notes/smartfolders-filters.md ("Property reference").
// A rule made in Eagle that this editor doesn't fully understand (a property it has no control
// for, a method it doesn't offer, a value it would flag) is kept exactly as it was and shown as
// such, never refused: the partner's smart folders must survive being renamed here.
import type { SmartCondition, SmartRule } from '../../../shared/types';
import { quoted } from '../../lib/format';

export type Kind =
  'string' | 'numeric' | 'date' | 'tags' | 'folders' | 'type' | 'rating' | 'shape' | 'color';

export interface Property {
  id: string;
  label: string;
  kind: Kind;
}

export const PROPERTIES: Property[] = [
  { id: 'name', label: 'Name', kind: 'string' },
  { id: 'folderName', label: 'Folder name', kind: 'string' },
  { id: 'url', label: 'Website link', kind: 'string' },
  { id: 'annotation', label: 'Note', kind: 'string' },
  { id: 'comments', label: 'Comments', kind: 'string' },
  { id: 'tags', label: 'Tags', kind: 'tags' },
  { id: 'folders', label: 'Folders', kind: 'folders' },
  { id: 'rating', label: 'Rating', kind: 'rating' },
  { id: 'type', label: 'Type', kind: 'type' },
  { id: 'shape', label: 'Shape', kind: 'shape' },
  { id: 'color', label: 'Color', kind: 'color' },
  { id: 'width', label: 'Width', kind: 'numeric' },
  { id: 'height', label: 'Height', kind: 'numeric' },
  { id: 'fileSize', label: 'File size', kind: 'numeric' },
  { id: 'duration', label: 'Video duration', kind: 'numeric' },
  { id: 'createTime', label: 'Date added', kind: 'date' },
  { id: 'mtime', label: 'Date modified', kind: 'date' },
  { id: 'btime', label: 'Date created', kind: 'date' },
];

const BY_ID = new Map(PROPERTIES.map((p) => [p.id, p]));
export const propertyOf = (id: string): Property | undefined => BY_ID.get(id);

export interface Method {
  id: string;
  label: string;
}

const STRING_METHODS: Method[] = [
  { id: 'contain', label: 'contains' },
  { id: 'uncontain', label: 'doesn’t contain' },
  { id: 'equal', label: 'is' },
  { id: 'startWith', label: 'starts with' },
  { id: 'endWith', label: 'ends with' },
  { id: 'empty', label: 'is empty' },
  { id: 'not-empty', label: 'is not empty' },
  { id: 'regex', label: 'matches the pattern' },
];
const NUMERIC_METHODS: Method[] = [
  { id: '>', label: 'is more than' },
  { id: '>=', label: 'is at least' },
  { id: '=', label: 'is exactly' },
  { id: '<', label: 'is less than' },
  { id: '<=', label: 'is at most' },
  { id: 'between', label: 'is between' },
];
const DATE_METHODS: Method[] = [
  { id: 'before', label: 'is on or before' },
  { id: 'after', label: 'is on or after' },
  { id: 'on', label: 'is on' },
  { id: 'between', label: 'is between' },
  { id: 'within', label: 'is within the last' },
];
const SET_METHODS = (empty: string, notEmpty: string): Method[] => [
  { id: 'union', label: 'has any of' },
  { id: 'intersection', label: 'has all of' },
  { id: 'equal', label: 'has exactly' },
  { id: 'identity', label: 'has none of' },
  { id: 'empty', label: empty },
  { id: 'not-empty', label: notEmpty },
];
const IS_METHODS: Method[] = [
  { id: 'equal', label: 'is' },
  { id: 'unequal', label: 'is not' },
];
/** Eagle's rating `contain` is a substring test on the star count: "345" means 3, 4 or 5 stars. */
const RATING_METHODS: Method[] = [...IS_METHODS, { id: 'contain', label: 'is one of' }];

export function methodsFor(property: string): Method[] {
  switch (propertyOf(property)?.kind) {
    case 'string':
      return property === 'comments'
        ? STRING_METHODS.filter((m) => m.id !== 'uncontain')
        : STRING_METHODS;
    case 'numeric':
      return NUMERIC_METHODS;
    case 'date':
      return DATE_METHODS;
    case 'tags':
      return SET_METHODS('has no tags', 'has tags');
    case 'folders':
      return SET_METHODS('is in no folder', 'is in a folder');
    case 'rating':
      return RATING_METHODS;
    case 'type':
    case 'shape':
      return IS_METHODS;
    case 'color':
      return [
        { id: 'similar', label: 'is similar to' },
        { id: 'accuracy', label: 'is almost the same as' },
        { id: 'grayscale', label: 'is grayscale' },
      ];
    default:
      return [];
  }
}

export const FILE_SIZE_UNITS = [
  { id: 'kb', label: 'KB' },
  { id: 'mb', label: 'MB' },
];
export const DURATION_UNITS = [
  { id: 's', label: 'seconds' },
  { id: 'm', label: 'minutes' },
  { id: 'h', label: 'hours' },
];
export const SHAPES = [
  { id: 'landscape', label: 'Landscape' },
  { id: 'portrait', label: 'Portrait' },
  { id: 'square', label: 'Square' },
  { id: 'panoramic-landscape', label: 'Wide panorama' },
  { id: 'panoramic-portrait', label: 'Tall panorama' },
  { id: 'custom', label: 'Aspect ratio' },
];
export const RATINGS = [
  { id: '5', label: '5 stars' },
  { id: '4', label: '4 stars' },
  { id: '3', label: '3 stars' },
  { id: '2', label: '2 stars' },
  { id: '1', label: '1 star' },
  { id: 'none', label: 'Not rated' },
];
/** Groups Eagle understands plus the file types people reach for. Any other extension can be typed. */
export const TYPE_SUGGESTIONS = [
  'video',
  'audio',
  'font',
  'jpg',
  'png',
  'gif',
  'webp',
  'svg',
  'psd',
  'ai',
  'pdf',
  'tif',
  'bmp',
  'avif',
  'mp4',
  'mov',
  'webm',
];

export const MAX_RULES = 30;
export const MAX_GROUPS = 30;

// ───────────── defaults ─────────────

/** What Eagle's editor puts in when you pick a property. */
export function defaultRule(property: string): SmartRule {
  switch (propertyOf(property)?.kind) {
    case 'numeric':
      if (property === 'fileSize') return { property, method: '>', value: [1, 0], unit: 'mb' };
      if (property === 'duration') return { property, method: '<=', value: [30, 0], unit: 's' };
      return { property, method: '>', value: [480, 0] };
    case 'date':
      return { property, method: 'before', value: [] };
    case 'tags':
    case 'folders':
      return { property, method: 'intersection', value: [] };
    case 'type':
      return { property, method: 'equal', value: 'png' };
    case 'rating':
      return { property, method: 'equal', value: '5' };
    case 'shape':
      return { property, method: 'equal', value: 'landscape' };
    case 'color':
      return { property, method: 'similar', value: '#0087EF' };
    default:
      return { property, method: 'contain', value: '' };
  }
}

const nums = (v: unknown): (number | null)[] =>
  Array.isArray(v) ? v.map((x) => (typeof x === 'number' && Number.isFinite(x) ? x : null)) : [];

/** Keep the value shape right when the method changes (dates and ranges take different numbers). */
export function changeMethod(rule: SmartRule, method: string): SmartRule {
  const kind = propertyOf(rule.property)?.kind;
  const next: SmartRule = { ...rule, method };
  if (kind === 'string' && (method === 'empty' || method === 'not-empty')) next.value = '';
  else if (kind === 'rating' && (method === 'contain') !== (rule.method === 'contain')) {
    // "is 4" <-> "is one of 4", and "is one of 345" -> "is 3"
    const v = typeof rule.value === 'string' ? rule.value : '';
    next.value =
      method === 'contain' ? (/^[1-5]$/.test(v) ? v : '5') : (/[1-5]/.exec(v)?.[0] ?? '5');
  } else if (kind === 'numeric') {
    const [a] = nums(rule.value);
    next.value = method === 'between' ? [a ?? 0, a ?? 0] : [a ?? 0, 0];
  } else if (kind === 'date') {
    const [a, b] = nums(rule.value);
    if (method === 'within') next.value = [a !== null && a > 0 && a < 100_000 ? a : 30];
    else if (method === 'between') next.value = [a ?? null, b ?? a ?? null];
    else next.value = [a !== null && a > 100_000 ? a : null];
  } else if (
    (kind === 'tags' || kind === 'folders') &&
    (method === 'empty' || method === 'not-empty')
  )
    next.value = [];
  return next;
}

/** Pick a shape. A custom ratio needs its two sides (Eagle's default is 4:3). */
export function withShape(rule: SmartRule, value: string): SmartRule {
  const next: SmartRule = { ...rule, value };
  if (value === 'custom') {
    const ok = (n: unknown) => typeof n === 'number' && n > 0;
    if (!ok(next.width) || !ok(next.height)) Object.assign(next, { width: 4, height: 3 });
  }
  return next;
}

// ───────────── checks ─────────────

/** A plain-English reason a rule would never match (or break the folder), or null when it's fine. */
export function ruleProblem(rule: SmartRule): string | null {
  const prop = propertyOf(rule.property);
  if (!prop) return null; // a property this editor doesn't know: leave Eagle's rule alone
  const v = rule.value;
  switch (prop.kind) {
    case 'string': {
      if (rule.method === 'empty' || rule.method === 'not-empty') return null;
      if (typeof v !== 'string' || !v.trim()) return 'Type what to look for.';
      if (rule.method === 'regex' || rule.method === 'startWith' || rule.method === 'endWith') {
        try {
          new RegExp(v, 'i');
        } catch {
          return rule.method === 'regex'
            ? 'That pattern isn’t valid.'
            : 'Symbols like ( or [ can’t be used here.';
        }
      }
      return null;
    }
    case 'numeric': {
      const [a, b] = nums(v);
      if (a == null) return 'Enter a number.';
      if (rule.method === 'between') {
        if (b == null) return 'Enter both numbers.';
        if (a > b) return 'The first number must be the smaller one.';
      }
      return null;
    }
    case 'date': {
      const [a, b] = nums(v);
      if (rule.method === 'within') return a != null && a > 0 ? null : 'Enter a number of days.';
      if (a == null) return 'Pick a date.';
      if (rule.method === 'between') {
        if (b == null) return 'Pick both dates.';
        if (a > b) return 'The first date must come first.';
      }
      return null;
    }
    case 'tags':
    case 'folders':
      if (rule.method === 'empty' || rule.method === 'not-empty') return null;
      return Array.isArray(v) && v.length
        ? null
        : prop.kind === 'tags'
          ? 'Add at least one tag.'
          : 'Pick at least one folder.';
    case 'type':
      return typeof v === 'string' && v.trim() ? null : 'Choose a type.';
    case 'rating':
      if (rule.method === 'contain')
        return typeof v === 'string' && /^[1-5]+$/.test(v) ? null : 'Pick at least one rating.';
      return typeof v === 'string' && RATINGS.some((r) => r.id === v) ? null : 'Choose a rating.';
    case 'shape': {
      if (typeof v !== 'string' || !SHAPES.some((s) => s.id === v)) return 'Choose a shape.';
      const { width, height } = rule;
      if (v !== 'custom') return null;
      return typeof width === 'number' && width > 0 && typeof height === 'number' && height > 0
        ? null
        : 'Enter both sides of the ratio.';
    }
    case 'color':
      if (rule.method === 'grayscale') return null;
      return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? null : 'Pick a color.';
  }
}

/** Can this editor show and edit the rule with its own controls? */
export function understood(rule: SmartRule): boolean {
  const prop = propertyOf(rule.property);
  if (!prop || !methodsFor(rule.property).some((m) => m.id === rule.method)) return false;
  // Eagle matches "none" inside rating `contain` text as "every item" (a bug); keep such text as is.
  if (prop.kind === 'rating' && rule.method === 'contain')
    return typeof rule.value === 'string' && /^[1-5]*$/.test(rule.value);
  return true;
}

/** A rule in words, for rules shown as they are ("Rating is one of none"). */
export function describeRule(rule: SmartRule): string {
  const prop = propertyOf(rule.property)?.label ?? rule.property;
  const method = methodsFor(rule.property).find((m) => m.id === rule.method)?.label ?? rule.method;
  const v = rule.value;
  const value = Array.isArray(v)
    ? v.filter((x) => x !== null && x !== '').join(', ')
    : typeof v === 'string'
      ? quoted(v)
      : v == null
        ? ''
        : String(v);
  return [prop, method, value].filter(Boolean).join(' ');
}

// ───────────── the editable model ─────────────

export interface UiRule {
  k: number;
  rule: SmartRule;
  /** Loaded from the file and not fully understood (or not valid by our checks): written back
   *  untouched, and never blocks saving. Understood ones can be switched to editing. */
  kept?: boolean;
  /** The rule as loaded (JSON). While the rule still equals it, it's written back as it was. */
  from?: string;
}
export interface UiGroup {
  k: number;
  match: 'AND' | 'OR';
  boolean: 'TRUE' | 'FALSE';
  rules: UiRule[];
  /** Keys on the condition that this editor doesn't touch; written back as they were. */
  extra: Record<string, unknown>;
}

let seq = 1;
export const nextKey = () => seq++;

/**
 * A plain deep copy. The editor's groups live in `$state`, so they are proxies, and neither
 * structuredClone nor Electron's IPC accepts a proxy. Rules are JSON, so JSON is a safe way through.
 */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const NOISE = new Set(['$$hashKey', 'import']); // Eagle's editor leaks these into saved rules

export function toModel(conditions: SmartCondition[]): UiGroup[] {
  return conditions.map((c) => {
    const { rules, match, boolean, ...extra } = c as SmartCondition & Record<string, unknown>;
    for (const n of NOISE) delete extra[n];
    return {
      k: nextKey(),
      match: match === 'OR' ? 'OR' : 'AND',
      boolean: boolean === 'FALSE' ? 'FALSE' : 'TRUE',
      rules: (rules ?? []).map((r) => ({
        k: nextKey(),
        rule: plain(r),
        kept: !understood(r) || ruleProblem(r) !== null,
        from: JSON.stringify(r),
      })),
      extra: plain(extra),
    };
  });
}

function cleanRule(r: SmartRule): SmartRule {
  const out: SmartRule = { ...r };
  for (const n of NOISE) delete (out as Record<string, unknown>)[n];
  const prop = propertyOf(r.property);
  if (prop?.kind === 'numeric') {
    const [a, b] = nums(r.value);
    out.value = [a ?? 0, r.method === 'between' ? (b ?? 0) : 0];
    if (r.property !== 'fileSize' && r.property !== 'duration') delete out.unit;
  }
  return out;
}

/**
 * Rules you didn't touch go back exactly as they came (a rename must not rewrite the partner's rules);
 * rules you edited are written the way Eagle's own editor writes them.
 */
export function toConditions(groups: UiGroup[]): SmartCondition[] {
  const untouched = (r: UiRule) =>
    r.kept || (r.from !== undefined && JSON.stringify(r.rule) === r.from);
  return plain(
    groups.map((g) => ({
      rules: g.rules.map((r) => (untouched(r) ? r.rule : cleanRule(r.rule))),
      match: g.match,
      boolean: g.boolean,
      ...g.extra,
    })),
  );
}

/** The first thing wrong in the whole folder, worded for the person, or null. */
export function firstProblem(groups: UiGroup[]): string | null {
  for (const [gi, g] of groups.entries()) {
    for (const [ri, r] of g.rules.entries()) {
      const p = r.kept ? null : ruleProblem(r.rule);
      if (p) return `${groups.length > 1 ? `Group ${gi + 1}, ` : ''}rule ${ri + 1}: ${p}`;
    }
  }
  return null;
}

// ───────────── dates ─────────────

/** The date picker stores local midnight of the chosen day (see the notes: date rules). */
export function inputToDate(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

export function dateToInput(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
