import { describe, expect, it } from 'vitest';
import { FIT_VIEW, canPan, clampView, fitScale, panBy, zoomAround, type Ctx } from './stageMath';

const ctxFor = (box: { w: number; h: number }, img: { w: number; h: number }, rot = 0): Ctx => ({
  box,
  img,
  rot,
  fit: fitScale(box, img, rot),
});

describe('fitScale', () => {
  it('shrinks a big picture to the box and never enlarges a small one', () => {
    expect(fitScale({ w: 1000, h: 500 }, { w: 4000, h: 1000 }, 0)).toBeCloseTo(0.25);
    expect(fitScale({ w: 1000, h: 500 }, { w: 100, h: 50 }, 0)).toBe(1);
  });
  it('swaps the picture sides for a quarter turn', () => {
    // 400x100 fits 1000x500 by width; turned 90 degrees it is 100x400 and fits by height
    expect(fitScale({ w: 1000, h: 500 }, { w: 4000, h: 1000 }, 90)).toBeCloseTo(0.125);
  });
});

describe('zoomAround', () => {
  it('keeps the picture point under the cursor fixed', () => {
    const c = ctxFor({ w: 1000, h: 800 }, { w: 4000, h: 3000 });
    // screen offset of a picture point = center offset + (point in fit px) * z. Use the cursor spot.
    const cursor = { x: 200, y: -120 };
    const point = (v: { z: number; px: number; py: number }) => {
      const fw = 4000 * c.fit;
      const fh = 3000 * c.fit;
      return { x: (cursor.x - v.px * fw) / v.z, y: (cursor.y - v.py * fh) / v.z };
    };
    const v1 = zoomAround(FIT_VIEW, 3, cursor.x, cursor.y, c);
    const v2 = zoomAround(v1, 6, cursor.x, cursor.y, c);
    expect(point(v2).x).toBeCloseTo(point(v1).x, 6);
    expect(point(v2).y).toBeCloseTo(point(v1).y, 6);
  });
  it('snaps to fit when a step crosses it, but not on a jump', () => {
    const c = ctxFor({ w: 1000, h: 800 }, { w: 4000, h: 3000 });
    const zoomed = zoomAround(FIT_VIEW, 1.3, 0, 0, c);
    expect(zoomAround(zoomed, 0.9, 0, 0, c, true).z).toBe(1);
    expect(zoomAround({ z: 0.5, px: 0, py: 0 }, 3, 0, 0, c, false).z).toBe(3);
  });
  it('stops at 3200 percent of real size', () => {
    const c = ctxFor({ w: 1000, h: 800 }, { w: 4000, h: 3000 });
    expect(zoomAround(FIT_VIEW, 1e9, 0, 0, c).z * c.fit).toBeCloseTo(32);
  });
});

describe('clampView and panBy', () => {
  it('keeps a picture that is smaller than the stage centered', () => {
    const c = ctxFor({ w: 1000, h: 800 }, { w: 500, h: 400 });
    const v = panBy(FIT_VIEW, 300, -200, c);
    expect([v.z, Math.abs(v.px), Math.abs(v.py)]).toEqual([1, 0, 0]);
    expect(canPan(FIT_VIEW, c)).toBe(false);
  });
  it('lets a zoomed picture pan only until its edge meets the stage edge', () => {
    const c = ctxFor({ w: 1000, h: 800 }, { w: 4000, h: 3000 }); // fit = 0.25 -> 1000x750
    const v = clampView({ z: 2, px: 5, py: 0 }, c); // 2000 wide: 500 px of slack each side
    expect(v.px * 1000).toBeCloseTo(500);
    expect(canPan(v, c)).toBe(true);
  });
});
