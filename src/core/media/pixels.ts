// Turning vips raw output into pixels we can work with.

import type { MediaContext } from './context';
import { vipsThumbnailArgs } from './vips';

/**
 * Decode an image upright at exactly w x h into raw bytes with 1-4 bands. `vips thumbnail`
 * rotates by EXIF, converts to sRGB and keeps alpha; the band count isn't printed, but it is
 * the output length divided by w*h.
 */
export async function decodeRaw(
  ctx: MediaContext,
  path: string,
  w: number,
  h: number,
): Promise<{ data: Buffer; bands: number }> {
  const { stdout } = await ctx.runner.run('vips', vipsThumbnailArgs(path, '.raw', w, h, 'force'), {
    timeoutMs: ctx.imageTimeoutMs,
  });
  const bands = stdout.length / (w * h);
  if (!Number.isInteger(bands) || bands < 1 || bands > 4)
    throw new Error(`unexpected raw size ${stdout.length} for ${w}x${h}`);
  return { data: stdout, bands };
}

/** 1 band = gray, 2 = gray + alpha, 3 = RGB, 4 = RGBA; always returned as RGBA. */
export function toRgba(data: Uint8Array, bands: number, pixels: number): Uint8Array {
  if (bands === 4) return data instanceof Uint8Array ? data : new Uint8Array(data);
  const out = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    if (bands === 3) {
      out[o] = data[i * 3];
      out[o + 1] = data[i * 3 + 1];
      out[o + 2] = data[i * 3 + 2];
      out[o + 3] = 255;
    } else {
      out[o] = out[o + 1] = out[o + 2] = data[i * bands];
      out[o + 3] = bands === 2 ? data[i * 2 + 1] : 255;
    }
  }
  return out;
}

/**
 * Plain bilinear resize, the way a browser canvas draws an image smaller: four neighbours, no
 * prefilter, sample points at pixel centers, edges clamped, result rounded. Eagle's palette
 * reads pixels drawn this way, and it is measurably closer to its output than Lanczos or
 * triangle filters (see palette tests).
 */
export function bilinearResize(
  src: Uint8Array,
  w: number,
  h: number,
  W: number,
  H: number,
): Uint8Array {
  const out = new Uint8Array(W * H * 4);
  const sx = w / W;
  const sy = h / H;
  for (let y = 0; y < H; y++) {
    const fy = (y + 0.5) * sy - 0.5;
    const y0 = Math.floor(fy);
    const wy = fy - y0;
    const ya = Math.min(Math.max(y0, 0), h - 1);
    const yb = Math.min(Math.max(y0 + 1, 0), h - 1);
    for (let x = 0; x < W; x++) {
      const fx = (x + 0.5) * sx - 0.5;
      const x0 = Math.floor(fx);
      const wx = fx - x0;
      const xa = Math.min(Math.max(x0, 0), w - 1);
      const xb = Math.min(Math.max(x0 + 1, 0), w - 1);
      const a = (ya * w + xa) * 4;
      const b = (ya * w + xb) * 4;
      const c = (yb * w + xa) * 4;
      const d = (yb * w + xb) * 4;
      const o = (y * W + x) * 4;
      for (let k = 0; k < 4; k++) {
        const top = src[a + k] * (1 - wx) + src[b + k] * wx;
        const bottom = src[c + k] * (1 - wx) + src[d + k] * wx;
        out[o + k] = Math.round(top * (1 - wy) + bottom * wy);
      }
    }
  }
  return out;
}
