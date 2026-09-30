import { differenceCiede2000 } from 'culori';
import { describe, expect, it } from 'vitest';
import {
  COLOR_TOLERANCE,
  colorDistance,
  colorMatchRowids,
  deltaE76,
  rgbToLab,
  type Lab,
  type RGB,
} from './color';
import { Fixture } from './testUtil';

// small deterministic PRNG so failures reproduce
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const de00 = differenceCiede2000();
const lab = (c: Lab) => ({ mode: 'lab65' as const, l: c.l, a: c.a, b: c.b });

describe('colorDistance', () => {
  it('is CIEDE2000: 0 for equal, small for close shades, large for different hues, symmetric', () => {
    expect(colorDistance([200, 30, 30], [200, 30, 30])).toBe(0);
    expect(colorDistance([200, 30, 30], [205, 32, 30])).toBeLessThan(3);
    expect(colorDistance([220, 20, 20], [20, 30, 200])).toBeGreaterThan(40);
    expect(colorDistance([10, 200, 90], [250, 200, 10])).toBeCloseTo(
      colorDistance([250, 200, 10], [10, 200, 90]),
      6,
    );
    // Sharma et al. reference pair (Lab 50, 2.6772, -79.7751 vs 50, 0, -82.7485) is 2.0425
    expect(
      de00(lab({ l: 50, a: 2.6772, b: -79.7751 }), lab({ l: 50, a: 0, b: -82.7485 })),
    ).toBeCloseTo(2.0425, 3);
  });
});

describe('colorMatchRowids', () => {
  it('returns exactly the items a brute-force scan finds (random palettes, several targets, both tolerances)', () => {
    const rand = rng(42);
    const fx = new Fixture();
    const pick = (): RGB => {
      // mix of clustered colors (so there are real matches) and uniform noise
      const bases: RGB[] = [
        [220, 30, 30],
        [20, 30, 200],
        [30, 190, 70],
        [240, 240, 235],
        [20, 20, 20],
        [200, 150, 120],
        [128, 128, 128],
      ];
      if (rand() < 0.6) {
        const b = bases[Math.floor(rand() * bases.length)];
        return b.map((c) => Math.max(0, Math.min(255, Math.round(c + (rand() - 0.5) * 70)))) as RGB;
      }
      return [Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256)];
    };
    for (let i = 0; i < 1500; i++) {
      const n = 1 + Math.floor(rand() * 8);
      let left = 100;
      const palettes = Array.from({ length: n }, (_, k) => {
        const ratio = k === n - 1 ? left : Math.round(rand() * left * 0.6 * 100) / 100;
        left -= ratio;
        return { color: pick(), ratio };
      });
      fx.add({ name: `item ${i}`, palettes });
    }
    const brute = (rgb: RGB, T: number, minRatio: number): Set<number> => {
      const t = lab(rgbToLab(rgb));
      const out = new Set<number>();
      const rows = fx.db
        .prepare('SELECT item_rowid, l, a, bb FROM palette WHERE ratio >= ?')
        .all(minRatio) as { item_rowid: number; l: number; a: number; bb: number }[];
      for (const r of rows)
        if (
          de00(t, { mode: 'lab65', l: r.l, a: r.a, b: r.bb }) <= T &&
          deltaE76(rgbToLab(rgb), { l: r.l, a: r.a, b: r.bb }) <= T + 50
        )
          out.add(r.item_rowid);
      return out;
    };
    let compared = 0;
    for (const rgb of [
      [220, 30, 30],
      [20, 30, 200],
      [30, 190, 70],
      [240, 240, 235],
      [20, 20, 20],
      [200, 150, 120],
      [128, 128, 128],
      [255, 120, 0],
    ] as RGB[]) {
      for (const tol of ['similar', 'close'] as const) {
        for (const minRatio of [0, 25]) {
          const got = colorMatchRowids(fx.db, { rgb, tolerance: tol, minRatio });
          const want = brute(rgb, COLOR_TOLERANCE[tol], minRatio);
          expect(
            [...got].sort((a, b) => a - b),
            `${rgb} ${tol} min ${minRatio}`,
          ).toEqual([...want].sort((a, b) => a - b));
          compared += want.size;
        }
      }
    }
    expect(compared).toBeGreaterThan(1000); // plenty of real matches, not just empty = empty

    // Narrowed to a few items, the answer is the full answer restricted to those items.
    const subset = Array.from({ length: 200 }, (_, k) => 1 + k * 7);
    for (const rgb of [
      [220, 30, 30],
      [128, 128, 128],
    ] as RGB[]) {
      const full = colorMatchRowids(fx.db, { rgb, tolerance: 'similar', minRatio: 10 });
      const scoped = colorMatchRowids(fx.db, { rgb, tolerance: 'similar', minRatio: 10 }, subset);
      expect([...scoped].sort((a, b) => a - b)).toEqual(subset.filter((r) => full.has(r)));
      expect(scoped.size).toBeGreaterThan(0);
    }
  });
});
