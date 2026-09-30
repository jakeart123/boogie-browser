// Pure helpers for the inspector (no stores, no api) so the fiddly rules can be unit tested.
import type { Actor, FolderColor, HistoryEntry, TagGroup, TagInfo } from '../../../shared/types';
import { FOLDER_COLORS } from '../../../shared/types';
import { chainRoot } from '../../lib/history';

/** A value plus how many of the selected items carry it. */
export interface Counted {
  key: string;
  count: number;
}

/**
 * Union of a list-valued field (tags, folder ids) over several items, with how many items carry
 * each value. Most common first; ties keep first-seen order, so one item keeps its stored order.
 */
export function unionCounts(lists: string[][]): Counted[] {
  const map = new Map<string, number>();
  for (const list of lists) for (const key of new Set(list)) map.set(key, (map.get(key) ?? 0) + 1);
  return [...map].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

/**
 * Values carried by every selected item. A value on only some of them is not "already there":
 * typing or suggesting it must still add it to the rest. When `loaded` is fewer than `total`
 * (a huge selection cut short) we can't know what the unseen items carry, so nothing counts.
 */
export function onEveryItem(counts: Counted[], loaded: number, total: number): Set<string> {
  if (loaded < total) return new Set();
  return new Set(counts.filter((c) => c.count === loaded).map((c) => c.key));
}

export interface TagSection {
  group: TagGroup | null;
  tags: Counted[];
}

/**
 * Split tags under their tag-group headers. A tag in several groups shows under the first one.
 * If none of the tags belong to a group the result is one headerless (flat) section.
 */
export function groupTags(
  tags: Counted[],
  groups: TagGroup[],
): { grouped: boolean; sections: TagSection[] } {
  const owner = new Map<string, TagGroup>();
  for (const g of groups) for (const t of g.tags) if (!owner.has(t)) owner.set(t, g);
  if (!tags.some((t) => owner.has(t.key)))
    return { grouped: false, sections: [{ group: null, tags }] };
  const sections: TagSection[] = [];
  for (const g of groups) {
    const own = tags.filter((t) => owner.get(t.key) === g);
    if (own.length) sections.push({ group: g, tags: own });
  }
  const rest = tags.filter((t) => !owner.has(t.key));
  if (rest.length) sections.push({ group: null, tags: rest });
  return { grouped: true, sections };
}

/** The `n` most used library tags that are not in `exclude`. */
export function topTags(
  tags: readonly TagInfo[],
  exclude: ReadonlySet<string>,
  n: number,
): string[] {
  const best: TagInfo[] = [];
  for (const t of tags) {
    if (exclude.has(t.name)) continue;
    if (best.length === n && t.count <= best[n - 1].count) continue;
    let i = best.length;
    while (i > 0 && best[i - 1].count < t.count) i--;
    best.splice(i, 0, t);
    if (best.length > n) best.pop();
  }
  return best.map((t) => t.name);
}

/** Same value on every item? Then show it; otherwise the field says "Multiple values". */
export function commonValue(values: string[]): { mixed: boolean; value: string } {
  const first = values[0] ?? '';
  return values.every((v) => v === first)
    ? { mixed: false, value: first }
    : { mixed: true, value: '' };
}

/** A textarea reports "\r\n" as "\n"; compare notes that way so untouched notes never count as edited. */
export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

/** A textarea hands back "\n" even for a note stored with "\r\n". When such a note is edited, keep its own line ending. */
export function keepLineEndings(next: string, original: string): string {
  const crlfOnly = original.includes('\r\n') && !/(^|[^\r])\n/.test(original);
  return crlfOnly ? next.replace(/\r?\n/g, '\r\n') : next;
}

// ── color swatches ──
export function hex(rgb: readonly number[]): string {
  return (
    '#' +
    rgb
      .map((c) =>
        Math.max(0, Math.min(255, Math.round(c)))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
      .toUpperCase()
  );
}

export function sameRgb(
  a: readonly number[] | undefined,
  b: readonly number[] | undefined,
): boolean {
  return !!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** flex-grow for a swatch: proportional to its share, never so small the row stops filling. */
export function swatchGrow(ratio: number): number {
  return Math.max(ratio, 1);
}

/** Search-by-color filter from a swatch: looser than the swatch's own share so it still finds things. */
export function colorFilter(rgb: [number, number, number], ratio: number) {
  return { rgb, tolerance: 'similar' as const, minRatio: Math.min(ratio, 30) };
}

/** Folder glyph color: the folder's own color, or undefined (the chip uses its muted default). */
export function folderColor(c: FolderColor | null | undefined): string | undefined {
  return c ? FOLDER_COLORS[c] : undefined;
}

// ── formatting ──
export function dateOnly(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── history ──
export function initials(name: string): string {
  const words = name
    .trim()
    .split(/[\s\-_.]+/)
    .filter(Boolean);
  if (!words.length) return '?';
  return (words.length === 1 ? words[0].slice(0, 1) : words[0][0] + words[1][0]).toUpperCase();
}

const startOfDay = (ms: number) => new Date(new Date(ms).setHours(0, 0, 0, 0)).getTime();

export function dayLabel(at: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const d = new Date(at);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function groupByDay(
  entries: readonly HistoryEntry[],
  now = Date.now(),
): { label: string; entries: HistoryEntry[] }[] {
  const out: { label: string; entries: HistoryEntry[] }[] = [];
  let lastDay = NaN;
  for (const e of entries) {
    const day = startOfDay(e.at);
    if (day !== lastDay) out.push({ label: dayLabel(e.at, now), entries: [] });
    lastDay = day;
    out[out.length - 1].entries.push(e);
  }
  return out;
}

export function countToday(entries: readonly HistoryEntry[], now = Date.now()): number {
  const from = startOfDay(now);
  let n = 0;
  for (const e of entries) if (e.at >= from) n++;
  return n;
}

/** Labels are written as sentences ("Tagged 48 items X"); after the actor's name they read better in lower case. */
export function afterActor(label: string): string {
  return /^[A-Z][a-z]/.test(label) ? label[0].toLowerCase() + label.slice(1) : label;
}

/**
 * What follows the actor's name: "tagged 48 items X", or for an undo "undid: Tagged 48 items X" /
 * "redid: …" (named by the action its chain started from, when that is loaded). No quotes around
 * the label, as in the undo toast: labels already quote the names in them.
 */
export function entryText(e: HistoryEntry, list: readonly HistoryEntry[]): string {
  const { root, depth } = chainRoot(e, list);
  if (!depth) return afterActor(e.label);
  return `${depth % 2 ? 'undid' : 'redid'}: ${root.label}`;
}

/** Undoing an undo brings its change back, so that button says Redo. */
export function isRedo(e: HistoryEntry, list: readonly HistoryEntry[]): boolean {
  return chainRoot(e, list).depth % 2 === 1;
}

/**
 * How a History row reads: the name to bold, then the rest. Outside changes carry their own subject
 * in the label ("Sam edited 1 item", "Sam's Eagle may have written an old copy…", "Changed
 * outside Boogie: …"), so the name is never said twice.
 */
export function rowParts(
  e: HistoryEntry,
  list: readonly HistoryEntry[],
): { who: string; rest: string } {
  const name = e.actor.name;
  if (e.actor.kind !== 'external' || chainRoot(e, list).depth)
    return { who: name, rest: ` ${entryText(e, list)}` };
  if (e.label.startsWith(name)) {
    const rest = e.label.slice(name.length);
    return { who: name, rest: /^['’]/.test(rest) ? rest : ` ${rest.trimStart()}` };
  }
  return { who: '', rest: e.label };
}

/** The button on an entry: "Undo", "Redo", or "Undo all 48". */
export function undoLabel(e: HistoryEntry, list: readonly HistoryEntry[]): string {
  const verb = isRedo(e, list) ? 'Redo' : 'Undo';
  return e.itemCount > 1 ? `${verb} all ${e.itemCount.toLocaleString()}` : verb;
}

/**
 * Entries whose effect is reversed right now. `undoneBy` says an entry was undone, but if that
 * undo was itself undone (a redo) the entry is applied again, so it stops counting. An undoer we
 * don't have loaded counts as standing.
 */
export function reversedIds(entries: readonly HistoryEntry[]): Set<string> {
  const byId = new Map(entries.map((e) => [e.groupId, e]));
  const memo = new Map<string, boolean>();
  const reversed = (e: HistoryEntry, depth: number): boolean => {
    if (!e.undoneBy) return false;
    const known = memo.get(e.groupId);
    if (known !== undefined) return known;
    const undoer = byId.get(e.undoneBy);
    const r = !undoer || depth > 50 ? true : !reversed(undoer, depth + 1);
    memo.set(e.groupId, r);
    return r;
  };
  return new Set(entries.filter((e) => reversed(e, 0)).map((e) => e.groupId));
}

/** Who last touched this item, per the history we have loaded (newest first). */
export function lastActor(entries: readonly HistoryEntry[], itemId: string): Actor | null {
  for (const e of entries) if (e.itemIds.includes(itemId)) return e.actor;
  return null;
}
