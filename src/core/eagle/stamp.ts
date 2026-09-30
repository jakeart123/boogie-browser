// How Boogie picks the timestamps it writes (item `lastModified`, root `modificationTime`).
//
// 1. Backdated. A partner's running Eagle skips an item edit whose mtime.json value is less than
//    500 ms behind ITS clock ("prevent triggering itself", background.js watch callback, `edit`
//    branch). A plain `Date.now()` from a machine whose clock runs ahead of the partner's by more than the
//    delivery delay is skipped every time (eagle-proof FINDINGS-2 R2-2). So values start a minute in
//    the past. Why 60 s: clocks synced by NTP or Windows Time are normally within a second or two,
//    and a week of drift on poor hardware stays well under a minute, while a minute changes nothing
//    anyone sees (Eagle shows and sorts by the files' own dates and `modificationTime`; it compares
//    `lastModified` only with mtime.json and with the root's `modificationTime`, see 3). A bigger
//    skew is detected from their writes and shown as a warning (service/partner/clock.ts). The value
//    still goes above the file's own and mtime.json's: Eagle re-reads an item only when it goes up.
// 2. Items stay newer than the root. Eagle's UI treats an item whose only folder it doesn't know as
//    unfiled when the item's `lastModified` is older than the library's `modificationTime` (a folder
//    deleted after the item was saved; app.bundle.js calculateImageBinding), and its next save of
//    the item then writes that. "Create a folder, then move items into it" must keep the items newer
//    than that root, or an item update reaching the partner's Eagle before the new folder loses its folder.
//    So the root is backdated the same way and item values stay above the root's current value.
//    (Not covered: if both of us edit folders within the same minute and Dropbox keeps ours as the
//    winner of a conflicted copy, their Eagle may keep its in-memory root, since backdating can put
//    ours at or below its own time; the conflict dialog is the backstop there.)
// 3. Marked, when it costs nothing. A value Boogie writes normally ends in the same three
//    millisecond digits; Eagle writes `Date.now()`, which ends in them one time in a thousand.
//    That tells a Boogie on another computer (the owner's second machine) apart from the partner's Eagle
//    without adding any key to Eagle's records (service/partner/judge.ts writerOf). Rounding up to
//    the mark adds up to 999 ms, so when the value is already close to now (quick writes of one
//    file pushing `prev + 1`, a root written moments ago) it is written unmarked instead: marking
//    those compounded, walked the root seconds into the future, and Eagle skipped the edit
//    (eagle-proof FINDINGS-3 R3-1). Such a write just isn't recognizable as Boogie's.

/** How far Boogie's timestamps are set back (see above). */
export const SKEW_MARGIN_MS = 60_000;

/** The millisecond digits every Boogie-written timestamp ends in. */
const MARK = 373;

/** A value this far in our future is somebody's broken clock: never build on it. */
const FUTURE_LIMIT_MS = 24 * 60 * 60_000;

/** A marked value must stay at least this far in the past, or the plain value is written. */
const MARK_ONLY_BEFORE_MS = 2_000;

/** The smallest value at or above `min` that carries Boogie's mark. */
export function markStamp(min: number): number {
  const v = Math.ceil(min);
  const rest = (((v - MARK) % 1000) + 1000) % 1000;
  return rest === 0 ? v : v + (1000 - rest);
}

/** Does this timestamp carry Boogie's mark? (One Eagle value in a thousand does too.) */
export function isBoogieStamp(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && ((v % 1000) + 1000) % 1000 === MARK;
}

/** A marked stamp this fresh when seen is an Eagle's: Boogie's are backdated a minute. */
export const BOOGIE_MIN_AGE_MS = 30_000;

/**
 * Was this written by a Boogie (on another computer)? Marked AND at least 30 s old when it
 * arrives. Eagle stamps a save with its Date.now(), which carries the mark one time in a
 * thousand (often a whole batch at once), but then arrives fresh (review5 should-fix 5).
 */
export function isBoogieWrite(v: unknown, arrivedAt: number): boolean {
  return isBoogieStamp(v) && arrivedAt - (v as number) >= BOOGIE_MIN_AGE_MS;
}

/** `floor` marked, unless marking would bring it within 2 s of now (see 3 above). */
function markIfPast(now: number, floor: number): number {
  const marked = markStamp(floor);
  return marked <= now - MARK_ONLY_BEFORE_MS ? marked : Math.ceil(floor);
}

/**
 * An item's new `lastModified`: backdated, above the file's own value (`prev`), above what
 * mtime.json holds for it (`entry`), above the root's `modificationTime` (`root`), and marked
 * when that costs nothing.
 */
export function itemStamp(now: number, prev: number, entry: number, root: number): number {
  const rootFloor = root <= now + FUTURE_LIMIT_MS ? root + 1 : 0;
  return markIfPast(now, Math.max(now - SKEW_MARGIN_MS, prev + 1, entry + 1, rootFloor));
}

/** The root's new `modificationTime`: backdated like items, above its previous value. */
export function rootStamp(now: number, prev: number): number {
  return markIfPast(now, Math.max(now - SKEW_MARGIN_MS, prev + 1));
}
