// Small pure helpers for the video and audio controls.

export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

/** 83 -> "1:23", 3725 -> "1:02:05". `fine` adds hundredths ("1:23.04") for frame stepping. */
export function clock(sec: number, fine = false): string {
  const t = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const whole = Math.floor(t);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, '0');
  const base = h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  return fine ? `${base}.${String(Math.floor((t - whole) * 100)).padStart(2, '0')}` : base;
}

/** The next preset above (dir 1) or below (dir -1) `current`, staying inside the list. */
export function nextSpeed(current: number, dir: 1 | -1): number {
  if (dir === 1) return SPEEDS.find((s) => s > current + 1e-6) ?? SPEEDS[SPEEDS.length - 1];
  return [...SPEEDS].reverse().find((s) => s < current - 1e-6) ?? SPEEDS[0];
}

/**
 * Where to seek to step `n` frames from time `t`. Lands in the middle of a frame so the browser
 * shows that frame and not its neighbour, whatever rounding the decoder does.
 */
export function stepTarget(t: number, fps: number, n: number, duration: number): number {
  const rate = fps > 0 ? fps : 30;
  const frame = Math.floor(t * rate + 1e-3) + n;
  const target = (Math.max(0, frame) + 0.5) / rate;
  return duration > 0 ? Math.min(target, Math.max(0, duration - 0.5 / rate)) : target;
}

/** Frame rate from the gaps (seconds) between consecutive presented frames. Falls back to 30. */
export function estimateFps(gaps: number[]): number {
  const good = gaps.filter((g) => g > 0.004 && g < 0.2).sort((a, b) => a - b);
  if (good.length < 3) return 30;
  const fps = 1 / good[Math.floor(good.length / 2)];
  return Math.min(120, Math.max(5, Math.round(fps * 100) / 100));
}
