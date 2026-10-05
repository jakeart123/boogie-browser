// The shapes the merge functions share. Pure: no fs, no electron.

export type Rec = Record<string, unknown>;

/** What the base versions say about one difference between the library and a conflicted copy. */
export type Verdict =
  | 'copy' // every base says only the copy changed it: take the copy's value
  | 'live' // every base says only the library changed it: keep it
  | 'ask'; // anything else (a clash, bases that disagree, no bases): a person decides

/**
 * One difference between the library's file and a conflicted copy. `apply` takes the copy's value
 * onto a record (a fresh read of the live file) and says whether that changed it.
 */
export interface Diff<T> {
  /** Unique among the diffs a copy has that can be questions (verdict 'ask'). */
  id: string;
  label: string; // "Name", "Tag “Blue”"
  live: string; // what the library has now, as short text ("(none)" when absent)
  copy: string;
  verdict: Verdict;
  /** What kind of thing this is, for the label of a merge ("the name", "2 tags"). */
  topic: string;
  apply(target: T): boolean;
}

/** Differences that are certain: they are taken from the copy without asking. */
export const certain = <T>(diffs: readonly Diff<T>[]): Diff<T>[] =>
  diffs.filter((d) => d.verdict === 'copy');

/** Differences a person has to decide. */
export const questionsOf = <T>(diffs: readonly Diff<T>[]): Diff<T>[] =>
  diffs.filter((d) => d.verdict === 'ask');

/** Apply the certain ones to `target`. */
export function takeCertain<T>(diffs: readonly Diff<T>[], target: T): boolean {
  let changed = false;
  for (const d of certain(diffs)) if (d.apply(target)) changed = true;
  return changed;
}

/** Apply the questions with these ids to `target` (the answer "take the copy's"). */
export function takeAnswers<T>(
  diffs: readonly Diff<T>[],
  target: T,
  ids: ReadonlySet<string>,
): boolean {
  let changed = false;
  for (const d of questionsOf(diffs)) if (ids.has(d.id) && d.apply(target)) changed = true;
  return changed;
}

/** Plain "(none)" for a value that isn't there, and "(empty)" for an empty text. */
export const NONE = '(none)';
export const EMPTY = '(empty)';

/**
 * A value as text for a question. Long enough to carry a whole note (the dialog shows three lines
 * and the rest on hover); `max` is only there so a runaway value can't bloat every status update.
 */
export function shown(v: unknown, max = 2000): string {
  if (v === undefined || v === null) return NONE;
  if (v === '') return EMPTY;
  const s = typeof v === 'string' ? v : (JSON.stringify(v) ?? NONE);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Taking the copy's side of this difference takes something away from the library. */
export const takesAway = (d: Pick<Diff<never>, 'copy'>): boolean =>
  d.copy === NONE || d.copy === EMPTY;

export const quoted = (name: string): string => `“${name}”`;

const ONE: Record<string, string> = {
  name: 'the name',
  notes: 'the notes',
  link: 'the source link',
  rating: 'the rating',
  trash: 'the trash state',
};
const MANY: Record<string, [string, string]> = {
  tag: ['tag', 'tags'],
  folder: ['folder', 'folders'],
  position: ['folder position', 'folder positions'],
  change: ['change', 'changes'],
  starred: ['starred tag', 'starred tags'],
  other: ['other setting', 'other settings'],
  smartFolder: ['smart folder', 'smart folders'],
  tagGroup: ['tag group', 'tag groups'],
  quickAccess: ['quick access entry', 'quick access entries'],
};

const list = (parts: string[]): string =>
  parts.length <= 1
    ? parts.join('')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

function counted(diffs: readonly Diff<never>[]): string {
  const counts = new Map<string, number>();
  for (const d of diffs) counts.set(d.topic, (counts.get(d.topic) ?? 0) + 1);
  return list(
    [...counts].map(([topic, n]) => {
      const one = ONE[topic];
      if (one) return one;
      const [s, p] = MANY[topic] ?? ['change', 'changes'];
      return `${n} ${n === 1 ? s : p}`;
    }),
  );
}

/**
 * "took the name and 2 tags and removed 1 folder": what a merge did, from its diffs' topics. What
 * the copy doesn't have is said as removed, so a label never calls taking a tag away "took 1 tag".
 */
export function summarize(diffs: readonly Diff<never>[]): string {
  const taken = diffs.filter((d) => !takesAway(d));
  const removed = diffs.filter(takesAway);
  return [
    taken.length ? `took ${counted(taken)}` : '',
    removed.length ? `removed ${counted(removed)}` : '',
  ]
    .filter(Boolean)
    .join(' and ');
}
