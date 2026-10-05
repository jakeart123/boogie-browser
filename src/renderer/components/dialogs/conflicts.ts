// Small pure helpers for the conflicted copies dialog (kept out of the component so they can be tested).
import type { ConflictFile, ConflictQuestion } from '../../../shared/types';

/** The file's own name: an item copy's path starts with `images/<id>.info/`, which says nothing to a person. */
export const copyName = (path: string): string => path.split('/').pop() ?? path;

/**
 * Why a copy with no questions is still listed, in one short line. A copy Boogie can compare is
 * either tidied, merged or given questions, so the ones without are waiting, or a kind it leaves alone.
 */
export function whyListed(f: ConflictFile, readOnly: boolean): string {
  if (f.kind === 'thumbnail')
    return 'The item’s own thumbnail is missing, so Boogie keeps this one until there is a new one.';
  if (f.kind === 'other')
    return 'Boogie leaves this kind of file alone. Reveal it to look at it yourself.';
  if (readOnly) return 'Boogie can’t settle copies while this library is read-only.';
  return 'Boogie is still checking this one. Dropbox may still be syncing it.';
}

/** A question whose copy value is "(none)": taking the copy's value takes something away from the library. */
export const removes = (q: ConflictQuestion): boolean => q.copy === '(none)';

/** A few removals sit among the other questions. From this many they are one collapsed block. */
export const GROUP_REMOVALS_FROM = 4;

/** The questions as shown: the ones that change or add something, and the removals set apart (or none set apart when there are few). */
export function splitQuestions(qs: readonly ConflictQuestion[]): {
  main: ConflictQuestion[];
  removals: ConflictQuestion[];
} {
  const out = qs.filter(removes);
  return out.length >= GROUP_REMOVALS_FROM
    ? { main: qs.filter((q) => !removes(q)), removals: out }
    : { main: [...qs], removals: [] };
}

/** The Settle button says what will happen. */
export const settleLabel = (taken: number): string =>
  taken > 0 ? `Take ${taken.toLocaleString()} from the copy` : 'Keep the library as it is';

/** A reminder under the picks when some of them take something away. Null when none do. */
export function removalNote(removing: number): string | null {
  if (removing <= 0) return null;
  return removing === 1
    ? 'One of your picks removes something from the library.'
    : `${removing.toLocaleString()} of your picks remove something from the library.`;
}

/** The toast after settling: what was taken from the copy. */
export function settledText(taken: number): string {
  return taken > 0
    ? `Settled the copy and took ${taken === 1 ? '1 change' : `${taken.toLocaleString()} changes`} from it`
    : 'Settled the copy and kept the library as it is';
}

/** "(none)" and "(empty)" are the core's words for a missing value: shown quieter than a real one. */
export const isBlank = (v: string): boolean => v === '(none)' || v === '(empty)';
