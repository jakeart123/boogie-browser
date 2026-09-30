// Turns a FilterSpec into the chips shown in the filter bar. Pure, so it can be tested without a DOM.
import type { FilterSpec, RangeFilter, Shape } from '../../../shared/types';
import { colorName } from './colors';
import { quoted } from '../../lib/format';

export type PopoverKind =
  | 'tags'
  | 'folders'
  | 'color'
  | 'shape'
  | 'rating'
  | 'type'
  | 'date'
  | 'size'
  | 'dimensions'
  | 'duration'
  | 'urlnote'
  | 'saved'; // the saved filters list (toolbar funnel, Alt+F)

export type DateField = 'importedAt' | 'modifiedAt';

export interface ChipSeg {
  text: string;
  /** Excluded values are drawn struck through. */
  struck?: boolean;
}

export interface Chip {
  /** The FilterSpec key the chip's x clears. */
  key: keyof FilterSpec;
  /** Which editor a click opens. Keywords go to the command bar instead. */
  edit: PopoverKind | 'keywords';
  field?: DateField;
  /** lucide icon name */
  icon: string;
  segs: ChipSeg[];
  /** CSS color for the little dot (color chips). */
  swatch?: string;
  title: string;
}

export interface ChipContext {
  folderName: (id: string) => string;
  now?: number;
}

export const SHAPE_LABELS: Record<Shape, string> = {
  square: 'Square',
  portrait: 'Portrait',
  'panoramic-portrait': 'Tall panorama',
  landscape: 'Landscape',
  'panoramic-landscape': 'Wide panorama',
};

export const TYPE_GROUPS: { id: string; label: string }[] = [
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Videos' },
  { id: 'audio', label: 'Audio' },
  { id: 'doc', label: 'Documents' },
  { id: 'font', label: 'Fonts' },
  { id: '3d', label: '3D' },
];

// ── dates ──

/** Click includes (again: off), right-click or Shift excludes (again: off); never both at once. */
export function toggleIncluded(
  include: readonly string[],
  exclude: readonly string[],
  id: string,
  excluding: boolean,
): { include: string[]; exclude: string[] } {
  const flip = (list: readonly string[]) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  return excluding
    ? { include: include.filter((x) => x !== id), exclude: flip(exclude) }
    : { include: flip(include), exclude: exclude.filter((x) => x !== id) };
}

export interface DatePreset {
  id: 'today' | '7d' | '30d' | 'year';
  label: string;
}

export const DATE_PRESETS: DatePreset[] = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'year', label: 'This year' },
];

export function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function endOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
}

/** "Last 7 days" counts today plus the six days before it, from local midnight. */
export function presetRange(id: DatePreset['id'], now: number): RangeFilter {
  const days = { today: 1, '7d': 7, '30d': 30 } as const;
  if (id === 'year') return { min: new Date(new Date(now).getFullYear(), 0, 1).getTime() };
  const d = new Date(now);
  return { min: new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days[id] - 1)).getTime() };
}

export function matchPreset(r: RangeFilter, now: number): DatePreset | undefined {
  if (r.max !== undefined || r.min === undefined) return undefined;
  return DATE_PRESETS.find((p) => presetRange(p.id, now).min === r.min);
}

const p2 = (n: number) => String(n).padStart(2, '0');
export function dayText(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())}`;
}

// ── small formatters ──

function num(n: number): string {
  return String(+n.toFixed(2));
}

function rangeText(r: RangeFilter, unit: string, scale = 1): string {
  const min = r.min === undefined ? undefined : num(r.min / scale);
  const max = r.max === undefined ? undefined : num(r.max / scale);
  if (min !== undefined && max !== undefined) return `${min} to ${max} ${unit}`;
  if (min !== undefined) return `${min}+ ${unit}`;
  return `up to ${max} ${unit}`;
}

const hasRange = (r?: RangeFilter): r is RangeFilter =>
  !!r && (r.min !== undefined || r.max !== undefined);

/** "4 to 5 stars", "5 stars", "Unrated, 4 to 5 stars". */
export function ratingText(values: number[]): string {
  const stars = [...new Set(values.filter((v) => v > 0))].sort((a, b) => a - b);
  const parts: string[] = [];
  if (values.includes(0)) parts.push('Unrated');
  const runs: string[] = [];
  for (let i = 0; i < stars.length;) {
    let j = i;
    while (j + 1 < stars.length && stars[j + 1] === stars[j] + 1) j++;
    runs.push(j > i ? `${stars[i]} to ${stars[j]}` : String(stars[i]));
    i = j + 1;
  }
  if (runs.length)
    parts.push(`${runs.join(', ')} ${stars.length === 1 && stars[0] === 1 ? 'star' : 'stars'}`);
  return parts.join(', ');
}

function listSegs(prefix: string, include: string[], exclude: string[], max = 3): ChipSeg[] {
  const segs: ChipSeg[] = [{ text: prefix }];
  const shown = include.slice(0, max);
  shown.forEach((t, i) =>
    segs.push({ text: t + (i < shown.length - 1 || exclude.length ? ',' : '') }),
  );
  if (include.length > max) segs.push({ text: `+${include.length - max} more` });
  exclude.slice(0, max).forEach((t) => segs.push({ text: t, struck: true }));
  if (exclude.length > max) segs.push({ text: `+${exclude.length - max} more` });
  return segs;
}

const plain = (segs: ChipSeg[]) => segs.map((s) => (s.struck ? `not ${s.text}` : s.text)).join(' ');

function chip(c: Omit<Chip, 'title'>): Chip {
  return { ...c, title: plain(c.segs) };
}

/** One chip per active filter, in a fixed order. */
export function describeFilter(f: FilterSpec, ctx: ChipContext): Chip[] {
  const now = ctx.now ?? Date.now();
  const out: Chip[] = [];

  if (f.keywords)
    out.push(
      chip({
        key: 'keywords',
        edit: 'keywords',
        icon: 'search',
        segs: [{ text: quoted(f.keywords) }],
      }),
    );

  if (f.tags && (f.tags.include.length || f.tags.exclude.length)) {
    const prefix = { any: 'Tags:', all: 'All tags:', exact: 'Only tags:' }[f.tags.mode];
    out.push(
      chip({
        key: 'tags',
        edit: 'tags',
        icon: 'tag',
        segs: listSegs(prefix, f.tags.include, f.tags.exclude),
      }),
    );
  }

  if (f.folders && (f.folders.include.length || f.folders.exclude.length)) {
    out.push(
      chip({
        key: 'folders',
        edit: 'folders',
        icon: 'folder',
        segs: listSegs(
          'In:',
          f.folders.include.map(ctx.folderName),
          f.folders.exclude.map(ctx.folderName),
        ),
      }),
    );
  }

  if (f.color) {
    const name = colorName(f.color.rgb);
    const close = f.color.tolerance === 'close';
    const cover = f.color.minRatio ? `, ${num(f.color.minRatio)}%+ of image` : '';
    out.push(
      chip({
        key: 'color',
        edit: 'color',
        icon: 'pipette',
        swatch: `rgb(${f.color.rgb.join(',')})`,
        segs: [{ text: `Color ${close ? 'close to' : 'similar to'} ${name}${cover}` }],
      }),
    );
  }

  if (f.shapes?.length) {
    out.push(
      chip({
        key: 'shapes',
        edit: 'shape',
        icon: 'shapes',
        segs: [{ text: 'Shape: ' + f.shapes.map((s) => SHAPE_LABELS[s]).join(', ') }],
      }),
    );
  }
  if (f.aspect) {
    out.push(
      chip({
        key: 'aspect',
        edit: 'shape',
        icon: 'ratio',
        segs: [{ text: `Aspect ${num(f.aspect.w)}:${num(f.aspect.h)}` }],
      }),
    );
  }

  if (f.rating?.length)
    out.push(
      chip({
        key: 'rating',
        edit: 'rating',
        icon: 'star',
        segs: [{ text: 'Rating: ' + ratingText(f.rating) }],
      }),
    );

  if (f.types && (f.types.include.length || f.types.exclude.length)) {
    const name = (t: string) => TYPE_GROUPS.find((g) => g.id === t)?.label ?? t.toUpperCase();
    out.push(
      chip({
        key: 'types',
        edit: 'type',
        icon: 'file-type',
        segs: listSegs('Type:', f.types.include.map(name), f.types.exclude.map(name)),
      }),
    );
  }

  for (const [key, label] of [
    ['importedAt', 'Imported'],
    ['modifiedAt', 'Modified'],
  ] as const) {
    const r = f[key];
    if (!hasRange(r)) continue;
    const preset = matchPreset(r, now);
    const text = preset
      ? preset.label
      : r.min !== undefined && r.max !== undefined
        ? `${dayText(r.min)} to ${dayText(r.max)}`
        : r.min !== undefined
          ? `after ${dayText(r.min)}`
          : `before ${dayText(r.max!)}`;
    out.push(
      chip({
        key,
        edit: 'date',
        field: key,
        icon: 'calendar',
        segs: [{ text: `${label}: ${text}` }],
      }),
    );
  }

  if (hasRange(f.width))
    out.push(
      chip({
        key: 'width',
        edit: 'dimensions',
        icon: 'ruler',
        segs: [{ text: 'Width: ' + rangeText(f.width, 'px') }],
      }),
    );
  if (hasRange(f.height))
    out.push(
      chip({
        key: 'height',
        edit: 'dimensions',
        icon: 'ruler',
        segs: [{ text: 'Height: ' + rangeText(f.height, 'px') }],
      }),
    );
  if (hasRange(f.fileSize))
    out.push(
      chip({
        key: 'fileSize',
        edit: 'size',
        icon: 'hard-drive',
        segs: [{ text: 'Size: ' + rangeText(f.fileSize, 'MB', 1024 * 1024) }],
      }),
    );
  if (hasRange(f.duration))
    out.push(
      chip({
        key: 'duration',
        edit: 'duration',
        icon: 'clock',
        segs: [{ text: 'Duration: ' + rangeText(f.duration, 's') }],
      }),
    );

  if (f.hasUrl !== undefined)
    out.push(
      chip({
        key: 'hasUrl',
        edit: 'urlnote',
        icon: 'link',
        segs: [{ text: f.hasUrl ? 'Has source URL' : 'No source URL' }],
      }),
    );
  if (f.urlContains)
    out.push(
      chip({
        key: 'urlContains',
        edit: 'urlnote',
        icon: 'link',
        segs: [{ text: `URL contains ${quoted(f.urlContains)}` }],
      }),
    );
  if (f.hasNote !== undefined)
    out.push(
      chip({
        key: 'hasNote',
        edit: 'urlnote',
        icon: 'sticky-note',
        segs: [{ text: f.hasNote ? 'Has note' : 'No note' }],
      }),
    );
  if (f.noteContains)
    out.push(
      chip({
        key: 'noteContains',
        edit: 'urlnote',
        icon: 'sticky-note',
        segs: [{ text: `Note contains ${quoted(f.noteContains)}` }],
      }),
    );

  // Parts that only saved filters (made in Eagle, or here) set: shown so they can be removed.
  const flag = (key: keyof FilterSpec, edit: PopoverKind, icon: string, text: string) =>
    out.push(chip({ key, edit, icon, segs: [{ text }] }));
  if (f.noTags) flag('noTags', 'tags', 'tag', 'No tags');
  if (f.unfiled) flag('unfiled', 'folders', 'folder', 'In no folder');
  if (f.grayscale) flag('grayscale', 'color', 'pipette', 'Grayscale');
  if (f.hasComments !== undefined)
    flag('hasComments', 'urlnote', 'sticky-note', f.hasComments ? 'Has comments' : 'No comments');
  if (f.commentContains)
    flag(
      'commentContains',
      'urlnote',
      'sticky-note',
      `Comment contains ${quoted(f.commentContains)}`,
    );
  if (f.importedWithinDays)
    flag('importedWithinDays', 'date', 'calendar', `Imported: last ${f.importedWithinDays} days`);
  if (f.modifiedWithinDays)
    flag('modifiedWithinDays', 'date', 'calendar', `Modified: last ${f.modifiedWithinDays} days`);

  return out;
}
