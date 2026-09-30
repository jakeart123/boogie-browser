import { describe, expect, it } from 'vitest';
import { describeFilter, presetRange, ratingText } from './chips';
import { hexToRgb } from './colors';

const ctx = {
  folderName: (id: string) => `Folder ${id}`,
  now: new Date(2026, 8, 28, 14, 30).getTime(),
};
const text = (f: Parameters<typeof describeFilter>[0]) =>
  describeFilter(f, ctx).map((c) => c.title);

describe('describeFilter', () => {
  it('makes one chip per active filter, and none for an empty spec', () => {
    expect(describeFilter({}, ctx)).toEqual([]);
    const chips = describeFilter({ keywords: 'fle', rating: [5], hasUrl: false }, ctx);
    expect(chips.map((c) => c.key)).toEqual(['keywords', 'rating', 'hasUrl']);
  });

  it('shows excluded tags struck through and caps long lists', () => {
    const [c] = describeFilter(
      { tags: { mode: 'all', include: ['a', 'b', 'c', 'd'], exclude: ['x'] } },
      ctx,
    );
    expect(c.segs.filter((s) => s.struck).map((s) => s.text)).toEqual(['x']);
    expect(c.title).toBe('All tags: a, b, c, +1 more not x');
  });

  it('names a preset color, falls back to hex, and states coverage', () => {
    const rgb = hexToRgb('#e03131')!;
    expect(text({ color: { rgb, tolerance: 'close', minRatio: 30 } })).toEqual([
      'Color close to red, 30%+ of image',
    ]);
    expect(text({ color: { rgb: [58, 26, 13], tolerance: 'similar' } })).toEqual([
      'Color similar to #3A1A0D',
    ]);
  });

  it('writes ratings as runs', () => {
    expect(ratingText([4, 5])).toBe('4 to 5 stars');
    expect(ratingText([0, 1])).toBe('Unrated, 1 star');
    expect(ratingText([1, 3, 5])).toBe('1, 3, 5 stars');
  });

  it('recognizes date presets and otherwise prints the range', () => {
    expect(text({ importedAt: presetRange('7d', ctx.now) })).toEqual(['Imported: Last 7 days']);
    expect(
      text({
        importedAt: { min: new Date(2026, 0, 1).getTime(), max: new Date(2026, 1, 1).getTime() },
      }),
    ).toEqual(['Imported: 2026/01/01 to 2026/02/01']);
    expect(presetRange('7d', ctx.now).min).toBe(new Date(2026, 8, 22).getTime());
  });

  it('shows byte ranges in MB and open-ended ranges plainly', () => {
    expect(text({ fileSize: { min: 1048576, max: 10 * 1048576 } })).toEqual(['Size: 1 to 10 MB']);
    expect(text({ width: { min: 1000 }, height: { max: 2000 } })).toEqual([
      'Width: 1000+ px',
      'Height: up to 2000 px',
    ]);
  });
});
