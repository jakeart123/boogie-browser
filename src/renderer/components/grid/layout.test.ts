import { describe, expect, it } from 'vitest';
import {
  clampAspect,
  computeLayout,
  dropTarget,
  itemsInRect,
  MAX_SPACER_PX,
  movePage,
  moveVertical,
  tallScroll,
  toContent,
  toScrollTop,
  visibleRange,
  type Layout,
} from './layout';

// Small deterministic random source so failures reproduce.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}
function aspects(n: number, seed = 1): number[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => 0.3 + r() * 2.4);
}

const base = { gap: 12, rowGap: 16, padX: 18, padTop: 14, padBottom: 40, captionH: 40 };

describe('justified', () => {
  const W = 1300;
  const L = computeLayout(aspects(2000), { ...base, kind: 'justified', width: W, thumbSize: 190 });

  it('fills the width exactly on every full row, with equal gaps', () => {
    const availW = W - 36;
    for (let r = 0; r < L.rows - 1; r++) {
      const a = L.rowStart[r];
      const b = L.rowStart[r + 1] - 1;
      expect(L.x[a]).toBe(18);
      expect(L.x[b] + L.w[b]).toBe(18 + availW);
      for (let i = a; i < b; i++) expect(L.x[i + 1] - (L.x[i] + L.w[i])).toBe(12);
    }
  });

  it('does not stretch the last row and keeps row heights near the target', () => {
    const last = L.rows - 1;
    expect(L.h[L.rowStart[last]]).toBe(190);
    for (let r = 0; r < L.rows - 1; r++) {
      const h = L.h[L.rowStart[r]];
      expect(h).toBeGreaterThan(190 * 0.55);
      expect(h).toBeLessThan(190 * 1.8);
    }
  });

  it('clamps absurd aspects and still fills rows', () => {
    const wild = [0.01, 50, 0, NaN, 3, 0.1, 9, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const W2 = computeLayout(wild, { ...base, kind: 'justified', width: 800, thumbSize: 150 });
    for (let r = 0; r < W2.rows - 1; r++) {
      const b = W2.rowStart[r + 1] - 1;
      expect(W2.x[b] + W2.w[b]).toBe(18 + 800 - 36);
    }
    expect(clampAspect(0.01)).toBe(0.25);
    expect(clampAspect(50)).toBe(4);
    expect(clampAspect(NaN)).toBe(1);
  });

  it('is empty-safe', () => {
    const E = computeLayout([], { ...base, kind: 'justified', width: 800, thumbSize: 150 });
    expect(E.count).toBe(0);
    expect(visibleRange(E, 0, 1000)).toEqual({ lo: 0, hi: 0 });
  });
});

describe('masonry', () => {
  it('puts every item in the shortest column', () => {
    const L = computeLayout(aspects(3000, 7), {
      ...base,
      kind: 'masonry',
      width: 1200,
      thumbSize: 200,
    });
    expect(L.cols).toBe(Math.floor((1200 - 36) / 200));
    const bottoms = new Array<number>(L.cols).fill(14);
    for (let i = 0; i < L.count; i++) {
      const shortest = bottoms.indexOf(Math.min(...bottoms));
      expect(L.lane[i]).toBe(shortest);
      expect(L.y[i]).toBe(bottoms[shortest]);
      bottoms[shortest] += L.h[i] + L.captionH + 16;
    }
    // y never goes backwards, which the binary search relies on
    for (let i = 1; i < L.count; i++) expect(L.y[i]).toBeGreaterThanOrEqual(L.y[i - 1]);
  });
});

describe('grid and list', () => {
  it('grid cells are square, in whole rows', () => {
    const L = computeLayout(aspects(100), { ...base, kind: 'grid', width: 1000, thumbSize: 190 });
    expect(L.cols).toBe(4);
    for (let i = 0; i < 100; i++) expect(L.w[i]).toBe(L.h[i]);
    expect(L.w[0]).toBeGreaterThanOrEqual(190);
    expect(L.x[4]).toBe(L.x[0]);
    expect(L.y[4]).toBeGreaterThan(L.y[0]);
  });
  it('list rows are a fixed 44 px with no caption', () => {
    const L = computeLayout(aspects(50), {
      ...base,
      kind: 'list',
      width: 900,
      thumbSize: 190,
      rowGap: 0,
    });
    expect(L.h[0]).toBe(44);
    expect(L.y[1] - L.y[0]).toBe(44);
    expect(L.w[0]).toBe(900 - 36);
    expect(L.total).toBe(14 + 50 * 44 + 40);
  });
});

describe('85,000 items', () => {
  const a = aspects(85000, 3);
  for (const kind of ['justified', 'masonry', 'grid', 'list'] as const) {
    it(`${kind} lays out in under 100 ms`, () => {
      computeLayout(a, { ...base, kind, width: 1400, thumbSize: 190 }); // warm the JIT like a real session
      const t0 = performance.now();
      const L = computeLayout(a, { ...base, kind, width: 1400, thumbSize: 190 });
      const ms = performance.now() - t0;
      expect(L.count).toBe(85000);
      expect(ms).toBeLessThan(100);
    });
  }
});

describe('visible range', () => {
  for (const kind of ['justified', 'masonry', 'grid', 'list'] as const) {
    it(`${kind}: never misses a visible tile and stays tight`, () => {
      const L: Layout = computeLayout(aspects(6000, 11), {
        ...base,
        kind,
        width: 1100,
        thumbSize: 180,
      });
      const r = rng(5);
      for (let t = 0; t < 40; t++) {
        const top = r() * L.total;
        const bottom = top + 900;
        const { lo, hi } = visibleRange(L, top, bottom);
        let first = -1;
        let last = -1;
        for (let i = 0; i < L.count; i++) {
          if (L.y[i] < bottom && L.y[i] + L.h[i] + L.captionH > top) {
            if (first < 0) first = i;
            last = i;
          }
        }
        if (first >= 0) {
          expect(lo).toBeLessThanOrEqual(first);
          expect(hi).toBeGreaterThan(last);
        }
        // Nothing far outside the band is included: at most ~ two screens of items.
        for (let i = lo; i < hi; i++) expect(L.y[i] + L.maxTileH).toBeGreaterThanOrEqual(top);
      }
    });
  }
});

describe('spatial helpers', () => {
  it('moveVertical goes to the tile below and back', () => {
    const L = computeLayout(aspects(400, 2), {
      ...base,
      kind: 'justified',
      width: 1200,
      thumbSize: 190,
    });
    const i = 3;
    const down = moveVertical(L, i, 1);
    expect(L.lane[down]).toBe(L.lane[i] + 1);
    expect(moveVertical(L, 0, -1)).toBe(0);
  });
  it('moveVertical in masonry stays in the column', () => {
    const L = computeLayout(aspects(400, 2), {
      ...base,
      kind: 'masonry',
      width: 1200,
      thumbSize: 190,
    });
    const down = moveVertical(L, 2, 1);
    expect(L.lane[down]).toBe(L.lane[2]);
    expect(L.y[down]).toBeGreaterThan(L.y[2]);
  });
  it('movePage moves about one viewport, never past it', () => {
    for (const kind of ['justified', 'masonry', 'list'] as const) {
      const L = computeLayout(aspects(600, 6), { ...base, kind, width: 1200, thumbSize: 190 });
      const down = movePage(L, 0, 1, 900);
      expect(down).toBeGreaterThan(0);
      expect(L.y[down] - L.y[0]).toBeLessThanOrEqual(900);
      expect(L.y[down] - L.y[0]).toBeGreaterThan(900 - L.maxTileH - 16);
      expect(movePage(L, down, -1, 900)).toBeLessThan(down);
    }
  });
  it('itemsInRect agrees with the boxes', () => {
    const L = computeLayout(aspects(300, 4), {
      ...base,
      kind: 'justified',
      width: 1000,
      thumbSize: 160,
    });
    for (const i of [0, 17, 120, 299]) {
      expect(itemsInRect(L, L.x[i] + 2, L.y[i] + 2, L.x[i] + 4, L.y[i] + 4)).toEqual([i]);
    }
  });
  it('dropTarget picks before/after the nearest tile', () => {
    const L = computeLayout(aspects(50, 9), {
      ...base,
      kind: 'justified',
      width: 1000,
      thumbSize: 160,
    });
    const cy = L.y[5] + L.h[5] / 2;
    expect(dropTarget(L, L.x[5] + 2, cy)!.index).toBe(5);
    expect(dropTarget(L, L.x[5] + L.w[5] - 2, cy)!.index).toBe(6);
    expect(dropTarget(L, 10_000, L.y[49] + 1)!.index).toBe(50);
  });
});

describe('layouts taller than Chromium allows', () => {
  it('leaves a layout that fits alone', () => {
    const s = tallScroll(4_000_000, 120, 900);
    expect(s).toEqual({ spacerH: 4_000_000, k: 1, above: 120 });
    expect(toContent(s, 12_345)).toBe(12_345);
    expect(toScrollTop(s, 12_345)).toBe(12_345);
  });

  it('keeps the last of 85k items in one column reachable by scrolling and by End', () => {
    // The Master library case: Waterfall at the biggest zoom in a narrow window, mostly portraits.
    const r = rng(8);
    const tall = Array.from({ length: 85_000 }, () => 0.3 + r() * 1.2);
    const L = computeLayout(tall, { ...base, kind: 'masonry', width: 342, thumbSize: 400 });
    expect(L.cols).toBe(1);
    expect(L.total).toBeGreaterThan(33_554_432);
    const above = 180; // a subfolder strip
    const viewH = 900;
    const s = tallScroll(L.total, above, viewH);
    expect(s.spacerH).toBe(MAX_SPACER_PX);
    const maxScroll = above + s.spacerH - viewH;
    // At the bottom of the scroll range, the view ends where the layout ends.
    const bottomTop = toContent(s, maxScroll) - above;
    expect(bottomTop + viewH).toBeCloseTo(L.total, 3);
    expect(visibleRange(L, bottomTop, bottomTop + viewH).hi).toBe(L.count);
    // Bringing the last tile into view (what End and reveal do) stays inside the scroll range.
    const last = L.count - 1;
    const want = Math.ceil(toScrollTop(s, above + L.y[last] + L.h[last] + L.captionH + 12 - viewH));
    expect(want).toBeLessThanOrEqual(maxScroll);
    const shown = toContent(s, want) - above;
    expect(L.y[last]).toBeGreaterThanOrEqual(shown);
    expect(L.y[last] + L.h[last] + L.captionH).toBeLessThanOrEqual(shown + viewH);
  });

  it('scrolls the content above the spacer one to one and round-trips', () => {
    const s = tallScroll(40_000_000, 200, 800);
    expect(toContent(s, 150)).toBe(150);
    expect(toContent(s, 200)).toBe(200);
    // So a tile on screen never sits above the spacer's top, where it would be clipped.
    expect(toContent(s, 201) - 201).toBeLessThan(1);
    let prev = -1;
    for (const st of [0, 1, 200, 201, 1e6, 2e7, 200 + s.spacerH - 800]) {
      const v = toContent(s, st);
      expect(v).toBeGreaterThan(prev);
      expect(toScrollTop(s, v)).toBeCloseTo(st, 6);
      prev = v;
    }
  });
});
