// Zoom and pan math for the stage. The view is stored relative to "fit" so panes showing
// different-sized versions of one picture stay aligned (compare), and so a window resize
// keeps the picture where it was:
//   z      zoom relative to fit (1 = fit, 2 = twice as big as fit)
//   px,py  offset of the picture's center from the stage center, as a fraction of the fit size
export interface StageView {
  z: number;
  px: number;
  py: number;
}
export interface Box {
  w: number;
  h: number;
}

export const FIT_VIEW: StageView = { z: 1, px: 0, py: 0 };
/** "Fit" never enlarges a small picture past its real size. */
export const MAX_FIT_SCALE = 1;
/** The biggest zoom is 3200% of real size. */
export const MAX_ABS_SCALE = 32;
export const MIN_Z = 0.2;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Picture size as it appears on screen after a quarter-turn rotation. */
export function shown(img: Box, rot: number): Box {
  return rot % 180 === 0 ? img : { w: img.h, h: img.w };
}

/** Scale that makes the (rotated) picture fit the box. */
export function fitScale(box: Box, img: Box, rot: number): number {
  const s = shown(img, rot);
  if (!(box.w > 0 && box.h > 0 && s.w > 0 && s.h > 0)) return 1;
  return Math.min(MAX_FIT_SCALE, box.w / s.w, box.h / s.h);
}

export interface Ctx {
  box: Box;
  img: Box;
  rot: number;
  fit: number;
}

export function maxZ(fit: number): number {
  return Math.max(1, MAX_ABS_SCALE / fit);
}

/** Keeps the picture on screen: on an axis where it is smaller than the box it stays centered. */
export function clampView(v: StageView, c: Ctx): StageView {
  const s = shown(c.img, c.rot);
  const fw = s.w * c.fit;
  const fh = s.h * c.fit;
  if (!(fw > 0 && fh > 0)) return FIT_VIEW;
  const z = clamp(v.z, MIN_Z, maxZ(c.fit));
  const mx = Math.max(0, (fw * z - c.box.w) / 2);
  const my = Math.max(0, (fh * z - c.box.h) / 2);
  return { z, px: clamp(v.px * fw, -mx, mx) / fw, py: clamp(v.py * fh, -my, my) / fh };
}

/**
 * Zoom to `z`, keeping the picture point under (cx, cy) still. cx, cy are px from the stage center.
 * `snap` makes a step that passes through fit land exactly on fit (wheel and +/- steps, not jumps).
 */
export function zoomAround(
  v: StageView,
  z: number,
  cx: number,
  cy: number,
  c: Ctx,
  snap = false,
): StageView {
  const s = shown(c.img, c.rot);
  const fw = s.w * c.fit;
  const fh = s.h * c.fit;
  if (!(fw > 0 && fh > 0)) return FIT_VIEW;
  let nz = clamp(z, MIN_Z, maxZ(c.fit));
  if (snap && ((v.z - 1) * (nz - 1) < 0 || Math.abs(nz - 1) < 0.02)) nz = 1;
  const k = nz / v.z;
  const tx = cx - (cx - v.px * fw) * k;
  const ty = cy - (cy - v.py * fh) * k;
  return clampView({ z: nz, px: tx / fw, py: ty / fh }, c);
}

export function panBy(v: StageView, dx: number, dy: number, c: Ctx): StageView {
  const s = shown(c.img, c.rot);
  const fw = s.w * c.fit;
  const fh = s.h * c.fit;
  if (!(fw > 0 && fh > 0)) return v;
  return clampView({ z: v.z, px: v.px + dx / fw, py: v.py + dy / fh }, c);
}

/** True when the picture is bigger than the stage on some axis (so dragging can pan it). */
export function canPan(v: StageView, c: Ctx): boolean {
  const s = shown(c.img, c.rot);
  return s.w * c.fit * v.z > c.box.w + 0.5 || s.h * c.fit * v.z > c.box.h + 0.5;
}
