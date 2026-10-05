// The three-way decision for one field: the library's value, the copy's value, and the value in
// each base version both could have started from. Pure.
import { same } from './normalize';
import type { Verdict } from './types';

/** A value standing for "this folder isn't in that version at all". Equal to nothing real. */
export const MISSING = { $missing: true };

/**
 * `'same'`: nothing to decide. Otherwise one verdict, and only when EVERY base gives the same
 * answer: the base equals the library's value (only the copy changed it) or the copy's (only the
 * library did). A base equal to neither is a clash. With no bases nothing is certain.
 */
export function judge(live: unknown, copy: unknown, bases: readonly unknown[]): Verdict | 'same' {
  if (same(live, copy)) return 'same';
  let verdict: Verdict | null = null;
  for (const base of bases) {
    const one: Verdict = same(base, live) ? 'copy' : same(base, copy) ? 'live' : 'ask';
    if (one === 'ask' || (verdict && verdict !== one)) return 'ask';
    verdict = one;
  }
  return verdict ?? 'ask';
}
