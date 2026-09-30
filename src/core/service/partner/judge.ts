// The decisions at the heart of sync safety, as pure functions (tests: rules.test.ts).
//
// The main one: an outside write landed on an item that has a change of ours the partner's Eagle
// may not have shown, and put (part of) that change back to the old copy. That is what their Eagle
// writing an old copy looks like, and also what a deliberate edit of theirs looks like (they
// removed the tag, renamed it, moved the item back): the files can't tell them apart. So it is
// never repaired by itself. It is logged as "may have written an old copy", with "Put my change
// back" (undo of the entry) and "Keep theirs" one click away. (An automatic repair existed until
// round 7; four reviews in a row found it overriding the partner's real edits, so it is gone.)
//
// The other decisions keep that from happening in the first place (re-sending while their Eagle
// runs), and tell their Eagle apart from a Boogie on another computer.
import { isBoogieWrite } from '../../eagle/stamp';
import { staleRevert } from '../../journal/stale';
import { same, type Rec } from '../../journal/util';

/** The numbers behind the rules below. A plain object so a test can change them. */
export const JUDGE_RULES = {
  /** "Their Eagle ran without a break": no quiet spell this long between their writes. Shorter
   *  than "active" (10 min): a false break only costs a re-send, a false "unbroken" skips a cure. */
  runningGapMs: 3 * 60_000,
  /** Their Eagle skips a value less than 500 ms behind its clock but still stores it; a value
   *  of ours at least this far behind our own clock when written can't have been skipped. */
  pastByMs: 1_000,
};

export type Verdict = 'stale' | 'none';

/**
 * Did an outside write put back (part of) a change of ours their Eagle may not have shown? `base`:
 * the item as their Eagle last had it (null: not known). (`seen` no longer changes the verdict:
 * without automatic repair there is only one kind; it stays optional for older callers.)
 */
export function judgeOutsideWrite(w: {
  base: Rec | null;
  ours: Rec;
  theirs: Rec;
  seen?: boolean;
}): Verdict {
  return w.base && staleRevert(w.base, w.ours, w.theirs) ? 'stale' : 'none';
}

/**
 * Did their Eagle run without a break from before `sentAt` (our raise went out) until `until`
 * (their rewrite or save arrived)? `signals`: when their writes happened, our clock, ascending. A
 * break means they may have quit, and a cached start adopts our value without showing it
 * (FINDINGS 1). Quitting itself rewrites mtime.json, so "they wrote something shortly before"
 * alone isn't enough (review5 must-fix 2).
 */
export function ranThrough(
  sentAt: number,
  until: number,
  signals: readonly number[],
  gapMs = JUDGE_RULES.runningGapMs,
): boolean {
  const before = signals.filter((x) => x <= sentAt);
  let last = before[before.length - 1];
  if (last === undefined || sentAt - last >= gapMs) return false;
  for (const x of [...signals.filter((y) => y > sentAt && y < until), until]) {
    if (x - last >= gapMs) return false;
    last = x;
  }
  return true;
}

/** Our value was far enough in the past (ours, and their clock if known) that it can't be skipped. */
export function pastForPartner(
  value: number,
  writtenAt: number,
  partnerOffset: number | null,
): boolean {
  return value <= writtenAt - JUDGE_RULES.pastByMs + Math.min(0, partnerOffset ?? 0);
}

export interface Sent {
  /** When we wrote it (our clock). */
  at: number;
  /** The lastModified (and mtime.json value) we wrote. */
  value: number;
}

/**
 * Their rewrite of mtime.json from memory holds exactly the value we last wrote, sent while their
 * Eagle ran and kept running, and not a value they could have skipped (FINDINGS-3 R3-1): their poll
 * saw it go up and re-read the item into their window. Not proof (a restart inside the gap slips
 * through), so it only ever downgrades an old copy to "unsure".
 */
export function seenByRewrite(
  sent: Sent,
  held: number | undefined,
  rewriteAt: number,
  signals: readonly number[],
  partnerOffset: number | null,
  gapMs = JUDGE_RULES.runningGapMs,
): boolean {
  return (
    held === sent.value &&
    ranThrough(sent.at, rewriteAt, signals, gapMs) &&
    pastForPartner(sent.value, sent.at, partnerOffset)
  );
}

/**
 * Is `stamp` a Boogie's (on another computer)? Either marked and backdated (eagle/stamp.ts
 * isBoogieWrite; `partnerOffset` corrects the age for a partner clock known to be behind, so their
 * marked saves don't look old enough), or exactly one more than a value that Boogie also knew:
 * Boogie writes a value unmarked only when its floor was `prev + 1` (the item's previous
 * lastModified), `entry + 1` (its mtime.json entry) or `root + 1` (the root's time), and an Eagle
 * Date.now() lands on one of those exact values almost never (review6 must-fix 2).
 */
export function isBoogieValue(
  stamp: unknown,
  arrivedAt: number,
  known: readonly (number | null | undefined)[],
  partnerOffset: number | null = null,
): boolean {
  if (typeof stamp !== 'number') return false;
  if (isBoogieWrite(stamp, arrivedAt + Math.min(0, partnerOffset ?? 0))) return true;
  return known.some((k) => typeof k === 'number' && stamp === k + 1);
}

/** Who wrote a record that arrived at `arrivedAt`: another Boogie, or the partner's Eagle. */
export function writerOf(
  rec: Rec | null | undefined,
  arrivedAt: number,
  known: readonly (number | null | undefined)[] = [],
  partnerOffset: number | null = null,
): 'boogie' | 'partner' {
  return isBoogieValue(rec?.lastModified, arrivedAt, known, partnerOffset) ? 'boogie' : 'partner';
}

/** Only lastModified moved: a touch (ours or another Boogie's), or an Eagle save that changed nothing. */
export function onlyStampChanged(before: Rec | null, after: Rec | null): boolean {
  if (!before || !after) return false;
  const { lastModified: _a, ...b } = before;
  const { lastModified: _b, ...a } = after;
  return same(a, b);
}

/**
 * What a partner's rewrite of mtime.json from its memory did with one of our recent raises
 * (FINDINGS 2, FINDINGS-2 R2-5). `now`: the id's value in the file now.
 * - reraise: it put our value back or dropped the id. Their memory holds an older value (or none),
 *   so writing our same value to mtime.json again is enough: their poll sees it go up (or sees a
 *   new id, which background.js refreshLibrary reads as "create", known item or not) and reads the
 *   file (review5 should-fix 3). No need to rewrite the item. Read from Eagle's code; not yet run
 *   against real Eagle (review6 should-fix 8).
 * - bump: it kept our value but the id had no entry before (its map lacked it while the item was
 *   known): maybe adopted without a read, so only a higher value, a touch, makes it look.
 * - kept: their memory holds our value: their poll saw it go up and re-read the item. (A new item
 *   of ours they hadn't read would have been dropped from the same rewrite.)
 * - newer: a higher value, a newer version of theirs is announced (the watcher reports it on arrival).
 */
export function raiseFate(
  ours: { value: number; created: boolean; newEntry: boolean },
  now: number | undefined,
): 'reraise' | 'bump' | 'kept' | 'newer' {
  if (now === undefined || now < ours.value) return 'reraise';
  if (now > ours.value) return 'newer';
  return ours.newEntry && !ours.created ? 'bump' : 'kept';
}

export type TouchChoice = 'touch' | 'notNeeded' | 'changedSince' | 'newerAnnounced' | 'capped';

/**
 * Whether to re-send one item now to the partner's running Eagle (a touch, or a re-raise).
 * - notNeeded: nothing of ours waits for their Eagle (not pending, or seen), and no raise of ours
 *   was undone (`urgent`) while the file is still the version we raised.
 * - changedSince: the file isn't what the index has: an outside write landed, so it is read and
 *   logged first; a touch would re-send it as ours (review4 must-fix 2).
 * - newerAnnounced: mtime.json holds a value above the file's own that isn't ours: their newer
 *   version is on its way (Dropbox delivered mtime.json first). Touching now would put ours above
 *   it and their old copy would then land as a plain edit (review4 must-fix 9).
 * - capped: re-sent too often lately; their Eagle isn't re-reading it, so stop answering every save.
 */
export function touchChoice(t: {
  urgent: boolean;
  pending: { seen: boolean } | undefined;
  indexMatchesFile: boolean;
  fileLastModified: number;
  announced: number | undefined;
  ourRaise: number | undefined;
  recentTouches: number;
  maxTouches: number;
}): TouchChoice {
  const resend = t.urgent && t.fileLastModified === t.ourRaise;
  if (!resend && (!t.pending || t.pending.seen)) return 'notNeeded';
  if (!t.indexMatchesFile) return 'changedSince';
  if (t.announced !== undefined && t.announced > t.fileLastModified && t.announced !== t.ourRaise)
    return 'newerAnnounced';
  if (t.recentTouches >= t.maxTouches) return 'capped';
  return 'touch';
}
