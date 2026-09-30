// Boogie's timestamps against Eagle's own rules (research/eagle-app/app/js/background.js, read for
// behavior only): its watch callback skips an item edit whose mtime.json value is less than 500 ms
// behind its clock, and its UI unfiles an item whose only folder it doesn't know when the item is
// older than the library's modificationTime.
import { describe, expect, it } from 'vitest';
import { SKEW_MARGIN_MS, isBoogieStamp, itemStamp, markStamp, rootStamp } from './stamp';

/** Does a running Eagle skip our edit as its own? (`eagleNow`: its clock when its poll runs.) */
const eagleSkips = (value: number, eagleNow: number) => eagleNow - value < 500;

describe('item stamps and a partner Eagle with a different clock (FINDINGS-2 R2-2)', () => {
  const now = 1_790_000_000_000;
  const delivery = 3_000; // Dropbox plus their 4 s poll

  it('our clock 6 s ahead of theirs (the proof run): a plain Date.now() is skipped, our stamp is not', () => {
    const theirNowAtRead = now + delivery - 6_000;
    expect(eagleSkips(now, theirNowAtRead)).toBe(true);
    expect(eagleSkips(itemStamp(now, 0, 0, 0), theirNowAtRead)).toBe(false);
  });

  it('up to about a minute ahead is covered; beyond that the clock warning takes over', () => {
    expect(eagleSkips(itemStamp(now, 0, 0, 0), now + delivery - 55_000)).toBe(false);
    expect(eagleSkips(itemStamp(now, 0, 0, 0), now + delivery - 5 * 60_000)).toBe(true);
  });

  it('still above the file, mtime.json and the root, so their Eagle sees the value go up', () => {
    // Near or past now these are written plain: marking would only push them further ahead.
    expect(itemStamp(now, now + 10_000, 0, 0)).toBe(now + 10_001);
    expect(itemStamp(now, 0, now + 20_000, 0)).toBe(now + 20_001);
    expect(itemStamp(now, 0, 0, now - 1_000)).toBe(now - 999); // a root written just now
    expect(itemStamp(now, 0, 0, now + 2 * 86_400_000)).toBe(markStamp(now - SKEW_MARGIN_MS)); // broken clock
  });

  it('quick writes never climb into the future (FINDINGS-3 R3-1, review5 Q7)', () => {
    // 100 root writes in 30 s, then an item filed into the last folder.
    let root = now - 3_600_000;
    for (let i = 0; i < 100; i++) root = rootStamp(now + i * 300, root);
    const later = now + 30_000;
    expect(later - root).toBeGreaterThanOrEqual(1_000);
    const item = itemStamp(later, 0, 0, root);
    expect(item).toBeGreaterThan(root);
    expect(eagleSkips(item, later + delivery)).toBe(false);
    // Even 1000 writes within one second stay in the past.
    let fast = now - 3_600_000;
    for (let i = 0; i < 1000; i++) fast = rootStamp(now + i, fast);
    expect(now + 1000 - fast).toBeGreaterThanOrEqual(500);
  });

  it("an item written after a root write stays newer than it (Eagle's unknown-folder rule)", () => {
    const root = rootStamp(now, 0);
    expect(itemStamp(now + 2_000, 0, 0, root)).toBeGreaterThan(root);
    // Even when the root was pushed up by an earlier save of theirs (prev + 1).
    const pushed = rootStamp(now, now + 5_000);
    expect(itemStamp(now + 1_000, 0, 0, pushed)).toBeGreaterThan(pushed);
  });

  it('a stamp well in the past is marked, and marking costs under a second', () => {
    expect(isBoogieStamp(itemStamp(now, 0, 0, 0))).toBe(true);
    for (const v of [now, now + 373, now + 374, now + 999]) {
      const m = markStamp(v);
      expect(isBoogieStamp(m)).toBe(true);
      expect(m - v).toBeGreaterThanOrEqual(0);
      expect(m - v).toBeLessThan(1000);
    }
    expect(isBoogieStamp(now + 1)).toBe(false);
  });
});
