// The sync-safety decisions as pure functions, one case per situation the Eagle proof runs
// (test/eagle-proof FINDINGS.md, -2, -3) and the reviews (.tmp/review4-core, review5-sync) found.
import { afterEach, describe, expect, it } from 'vitest';
import { CLOCK_RULES, PartnerClock } from './clock';
import {
  isBoogieValue,
  judgeOutsideWrite,
  onlyStampChanged,
  raiseFate,
  ranThrough,
  seenByRewrite,
  touchChoice,
  writerOf,
} from './judge';

const base = {
  id: 'A',
  name: 'Study',
  tags: ['a'],
  folders: ['F1'],
  isDeleted: false,
  star: 2,
  lastModified: 1000,
};
/** Our change their Eagle may not have shown: +mine. */
const ours = { ...base, tags: ['a', 'mine'], lastModified: 2000 };
const judge = (theirs: Record<string, unknown>, o: Record<string, unknown> = ours) =>
  judgeOutsideWrite({ base, ours: o, theirs: { ...theirs, lastModified: 3000 } });

describe('an outside write over a change of ours their Eagle may not have shown', () => {
  it('putting (part of) it back is "may have written an old copy", whatever else it did', () => {
    // An old copy with their rating on top, their Eagle's palettes, a rename of our tag (review5
    // Q1a), a move out of the folder we filed it in (Q1b), a pure revert (R2-1 C4): all the same
    // verdict, since the files can't tell an old copy from their decision. The user decides.
    expect(judge({ ...base, star: 5 })).toBe('stale');
    expect(judge({ ...base, palettes: [{ color: [1, 2, 3] }] })).toBe('stale');
    expect(judge({ ...base, tags: ['a', 'in-progress'] })).toBe('stale');
    const filed = { ...base, folders: ['F1', 'Anatomy'] };
    expect(judge({ ...base, folders: ['F1', 'Figure'] }, filed)).toBe('stale');
    expect(judge(base)).toBe('stale');
    const trashed = { ...base, isDeleted: true, deletedTime: 5 };
    expect(judge({ ...base, deletedTime: 5 }, trashed)).toBe('stale'); // Eagle re-adds deletedTime
  });

  it('a write that kept our change is none of this; noise alone reverts nothing', () => {
    expect(judge({ ...ours, star: 5 })).toBe('none');
    expect(judgeOutsideWrite({ base: null, ours, theirs: base })).toBe('none');
    const pal = [{ color: [1, 2, 3], ratio: 100 }];
    const withPal = { ...ours, palettes: pal };
    const noisy = { ...withPal, palettes: [{ ...pal[0], $$hashKey: 'object:1' }], deletedTime: 7 };
    const b = { ...base, palettes: pal };
    expect(judgeOutsideWrite({ base: b, ours: withPal, theirs: noisy })).toBe('none');
  });

  it('touch-only changes are recognised', () => {
    expect(onlyStampChanged(ours, { ...ours, lastModified: 9 })).toBe(true);
    expect(onlyStampChanged(ours, { ...ours, star: 1, lastModified: 9 })).toBe(false);
  });
});

describe("who wrote it: another Boogie, or the partner's Eagle", () => {
  const now = 1_790_000_100_000;
  it("a marked, backdated stamp is a Boogie's; a fresh marked one is an Eagle batch (review5 should-fix 5)", () => {
    expect(writerOf({ lastModified: 1_790_000_000_373 }, now)).toBe('boogie'); // 100 s old
    expect(writerOf({ lastModified: 1_790_000_098_373 }, now)).toBe('partner'); // 1.6 s old
    expect(writerOf({ lastModified: 1_790_000_000_372 }, now)).toBe('partner');
  });

  it("an unmarked stamp exactly one above a value it knew is a Boogie's (review6 must-fix 2)", () => {
    const prev = 1_790_000_090_111; // the item's lastModified, its mtime.json entry, or a root time
    expect(isBoogieValue(prev + 1, now, [prev])).toBe(true);
    expect(isBoogieValue(prev + 2, now, [prev])).toBe(false); // an Eagle Date.now() lands anywhere
    expect(isBoogieValue(prev + 1, now, [null, undefined])).toBe(false);
  });

  it("their clock behind ours doesn't make their marked saves look old enough (review6 should-fix 9)", () => {
    const t = now - 42_000;
    const theirSave = t - (t % 1000) + 373; // marked, about 42 s "old" on arrival
    expect(isBoogieValue(theirSave, now, [], null)).toBe(true); // clock unknown: taken as a Boogie's
    expect(isBoogieValue(theirSave, now, [], -40_000)).toBe(false); // 40 s behind: it's fresh
  });
});

describe('did their Eagle re-read our version? (seen)', () => {
  const MIN = 60_000;
  const t = 1_790_000_000_000;
  const sent = { at: t, value: t - 60_000 };

  it('only if it ran without a break from before our send until their rewrite (review5 must-fix 2)', () => {
    const working = [t - 30_000, t + MIN, t + 2 * MIN];
    expect(ranThrough(t, t + 3 * MIN, working)).toBe(true);
    // Q2a: their last write was a quit rewrite 1 s before our edit; the next is their cached start.
    expect(ranThrough(t, t + 12 * 60 * MIN, [t - 1_000])).toBe(false);
    // Q2b: nothing from them for a while before our edit.
    expect(ranThrough(t, t + MIN, [t - 5 * MIN])).toBe(false);
  });

  it('their rewrite holding our value counts only when that value was well in the past (FINDINGS-3 R3-1)', () => {
    const signals = [t - 10_000];
    expect(seenByRewrite(sent, sent.value, t + 5_000, signals, null)).toBe(true);
    expect(seenByRewrite(sent, sent.value - 1, t + 5_000, signals, null)).toBe(false); // not ours
    // Our value 1.3 s AHEAD of our clock (climbing root stamps): they stored it but skipped it.
    const ahead = { at: t, value: t + 1_300 };
    expect(seenByRewrite(ahead, ahead.value, t + 5_000, signals, null)).toBe(false);
    // 5 s in our past, but their clock is 30 s behind ours: in their future.
    const recent = { at: t, value: t - 5_000 };
    expect(seenByRewrite(recent, recent.value, t + 5_000, signals, -30_000)).toBe(false);
  });
});

describe("what their Eagle's rewrite of mtime.json from memory did with our raise", () => {
  const known = { value: 5000, created: false, newEntry: false };
  it('put back or dropped: raise our same value again, no item write (FINDINGS 2, review5 should-fix 3)', () => {
    expect(raiseFate(known, 1000)).toBe('reraise');
    expect(raiseFate({ ...known, created: true, newEntry: true }, undefined)).toBe('reraise');
  });
  it('kept: their poll saw it and re-read the item, nothing to send (R2-5, review4 P13)', () => {
    expect(raiseFate(known, 5000)).toBe('kept');
    expect(raiseFate({ ...known, created: true, newEntry: true }, 5000)).toBe('kept');
  });
  it('kept, but the id had no entry before (maybe adopted without a read): a real touch', () => {
    expect(raiseFate({ ...known, newEntry: true }, 5000)).toBe('bump');
  });
  it('higher: their newer version is announced, nothing to send (review4 P3)', () => {
    expect(raiseFate(known, 6000)).toBe('newer');
  });
});

describe('whether to re-send an item now', () => {
  const t = {
    urgent: false,
    pending: { seen: false },
    indexMatchesFile: true,
    fileLastModified: 2000,
    announced: 2000,
    ourRaise: 2000,
    recentTouches: 0,
    maxTouches: 3,
  };
  it('a pending item their Eagle has not picked up is re-sent; a seen or settled one is not', () => {
    expect(touchChoice(t)).toBe('touch');
    expect(touchChoice({ ...t, pending: { seen: true } })).toBe('notNeeded');
    expect(touchChoice({ ...t, pending: undefined })).toBe('notNeeded');
    expect(touchChoice({ ...t, pending: undefined, urgent: true })).toBe('touch'); // undone raise
    // ...but not once their own save replaced our version (that save is judged instead).
    expect(touchChoice({ ...t, pending: undefined, urgent: true, fileLastModified: 2500 })).toBe(
      'notNeeded',
    );
  });
  it('never over a file that changed since the index read it (review4 must-fix 2, P4)', () => {
    expect(touchChoice({ ...t, indexMatchesFile: false })).toBe('changedSince');
  });
  it('waits when mtime.json announces their newer version before its file (review4 must-fix 9, P3)', () => {
    expect(touchChoice({ ...t, announced: 3000 })).toBe('newerAnnounced');
    expect(touchChoice({ ...t, announced: 3000, ourRaise: 3000 })).toBe('touch'); // our own value
  });
  it('stops after 3 in the window: their Eagle keeps reverting it (review4 should-fix 1, P5)', () => {
    expect(touchChoice({ ...t, urgent: true, recentTouches: 3 })).toBe('capped');
  });
});

describe("the partner's clock", () => {
  const rules = { ...CLOCK_RULES };
  afterEach(() => Object.assign(CLOCK_RULES, rules));
  const MIN = 60_000;

  it('behind ours: estimated from their save stamps, warned about, their times put on our clock (R2-2)', () => {
    const c = new PartnerClock();
    const t0 = 1_790_000_000_000;
    // Their clock is 5 minutes behind; deliveries take 2-9 s.
    for (const [i, delay] of [9_000, 2_000, 4_000].entries()) {
      const saved = t0 + i * 2 * MIN; // our time
      c.add(saved - 5 * MIN, saved + delay);
    }
    const now = t0 + 5 * MIN;
    expect(c.offset(now)).toBe(-5 * MIN - 2_000); // the fastest delivery
    expect(c.problem('Sam', now)).toMatch(
      /^Sam's computer clock seems about 5 minutes behind yours/,
    );
    // A save they stamp now (5 minutes behind on their clock) reads as recent, not old news.
    expect(now - c.toOurs(now - 5 * MIN, now)).toBeLessThan(10_000);
  });

  it('ahead of ours: no warning (their stamps are then always in our past from their side)', () => {
    const c = new PartnerClock();
    const t0 = 1_790_000_000_000;
    for (let i = 0; i < 3; i++) c.add(t0 + i * 2 * MIN + 30_000, t0 + i * 2 * MIN + 3_000);
    expect(c.offset(t0 + 5 * MIN)).toBe(27_000);
    expect(c.problem('Sam', t0 + 5 * MIN)).toBeNull();
  });

  it('a morning backlog does not hide their real offset once they work live (review6 c1)', () => {
    const now0 = 1_790_000_000_000;
    const behind = 3 * MIN;
    const c = new PartnerClock();
    for (let i = 0; i < 6; i++) c.add(now0 - 14 * 60 * MIN + i * 10 * MIN - behind, now0 + i * MIN);
    let t = now0 + 60 * MIN;
    for (let i = 0; i < 10; i++, t += 2 * MIN) c.add(t - behind, t + 3_000 + (i % 5) * 1_000);
    expect(c.offset(t)).toBe(-behind - 3_000);
    expect(c.problem('Sam', t)).toMatch(/3 minutes behind/);
  });

  it('a backlog is not their clock, whether it lands at once or over minutes (review5 should-fix 1, Q4)', () => {
    const now = 1_790_000_000_000;
    const burst = new PartnerClock();
    for (let i = 0; i < 10; i++) burst.add(now - 3 * 60 * MIN + i * MIN, now + i * 50);
    expect(burst.offset(now + 1000)).toBeNull();
    expect(burst.toOurs(now - 60 * MIN, now + 1000)).toBe(now - 60 * MIN); // old news stays old
    // Evening saves (18:00-19:00, their clock right) downloaded over 5 minutes next morning.
    const slow = new PartnerClock();
    for (let i = 0; i < 6; i++) slow.add(now - 14 * 60 * MIN + i * 10 * MIN, now + i * MIN);
    expect(slow.offset(now + 5 * MIN)).toBeNull();
    expect(slow.problem('Sam', now + 5 * MIN)).toBeNull();
  });
});
