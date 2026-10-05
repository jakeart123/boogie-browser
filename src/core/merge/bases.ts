// Which earlier versions of a file a conflicted copy is judged against. Pure.
import type { Rec } from './types';
import { canon, strip } from './normalize';

/** How far past the copy's own time a recorded version may still be its base (clock and sync slack). */
export const SLACK_MS = 2 * 60_000;

/** The latest time a version may have been recorded at to count as a base for a copy made at `copyTime`. */
export const basesUntil = (copyTime: number): number => copyTime + SLACK_MS;

/**
 * The versions (newest first, as the journal gives them) that are bases for a copy made at
 * `copyTime`, parsed. Never one recorded after the copy was made: a later edit of the library's
 * would make the library's values look like the base and the old copy's like fresh changes.
 * No usable time, or no versions: no bases, and then nothing is certain.
 */
export function pickBases(
  versions: readonly { at: number; text: string }[],
  copyTime: number | null,
): Rec[] {
  if (copyTime === null || !Number.isFinite(copyTime)) return [];
  const until = basesUntil(copyTime);
  const seen = new Set<string>();
  const out: Rec[] = [];
  for (const v of versions) {
    if (v.at > until) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(v.text);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    // The same content apart from the fields that change on every save is one base.
    const key = canon(strip(parsed));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed as Rec);
  }
  return out;
}
