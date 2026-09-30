import { describe, expect, it } from 'vitest';
import { animMime, frameMs, wrapFrame } from './anim.svelte';
import { frameFileName, indexAfterRemoval } from './actions';
import { clock, estimateFps, nextSpeed, stepTarget } from './media';

describe('media helpers', () => {
  it('formats time', () => {
    expect(clock(83)).toBe('1:23');
    expect(clock(3725)).toBe('1:02:05');
    expect(clock(3.04, true)).toBe('0:03.04');
    expect(clock(NaN)).toBe('0:00');
  });
  it('steps through the speed presets and stops at the ends', () => {
    expect(nextSpeed(1, 1)).toBe(1.25);
    expect(nextSpeed(1, -1)).toBe(0.75);
    expect(nextSpeed(4, 1)).toBe(4);
    expect(nextSpeed(0.25, -1)).toBe(0.25);
  });
  it('steps frames to the middle of the target frame and stays inside the clip', () => {
    // 24 fps: frame 72 starts at exactly 3 s; one step forward is the middle of frame 73
    expect(stepTarget(3, 24, 1, 12)).toBeCloseTo(73.5 / 24, 6);
    expect(stepTarget(3.001, 24, -1, 12)).toBeCloseTo(71.5 / 24, 6);
    expect(stepTarget(0, 24, -1, 12)).toBeCloseTo(0.5 / 24, 6);
    expect(stepTarget(11.99, 24, 10, 12)).toBeLessThan(12);
    expect(stepTarget(1, 0, 1, 12)).toBeGreaterThan(1); // unknown fps assumes 30
  });
  it('estimates the frame rate from frame gaps and falls back to 30', () => {
    expect(estimateFps([1 / 24, 1 / 24, 1 / 24.1, 1 / 24, 0.09])).toBeCloseTo(24, 0);
    expect(estimateFps([0.01])).toBe(30);
  });
});

describe('animated pictures', () => {
  it('shows a 0 or 10 ms GIF delay as 100 ms, like browsers do', () => {
    expect([0, 10_000, null, 40_000, 100_000].map(frameMs)).toEqual([100, 100, 100, 40, 100]);
  });
  it('wraps frame steps around both ends', () => {
    expect([wrapFrame(30, 30), wrapFrame(-1, 30), wrapFrame(5, 30), wrapFrame(3, 0)]).toEqual([
      0, 29, 5, 0,
    ]);
  });
  it('only takes over GIF and WebP', () => {
    expect(['GIF', 'webp', 'png', 'mp4'].map(animMime)).toEqual([
      'image/gif',
      'image/webp',
      null,
      null,
    ]);
  });
});

describe('leaving the viewer list', () => {
  it('keeps showing the next item when the one on screen (or one before it) is taken out', () => {
    const ids = ['a', 'b', 'c', 'd'];
    expect(indexAfterRemoval(ids, 1, 'b')).toBe(1); // c moves up into place
    expect(indexAfterRemoval(ids, 2, 'a')).toBe(1); // still on c
    expect(indexAfterRemoval(ids, 1, 'd')).toBe(1);
    expect(indexAfterRemoval(ids, 3, 'd')).toBe(2); // the last one: back to the new last
    expect(indexAfterRemoval(ids, 2, 'x')).toBe(2); // not in the list
  });

  it('names a saved frame after the clip and the time', () => {
    expect(frameFileName('clip', 2.9)).toBe('clip 2s.png');
    expect(frameFileName('Pose 3', 83.4)).toBe('Pose 3 1m23s.png');
  });
});
