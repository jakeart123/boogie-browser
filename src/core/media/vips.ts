// Thin wrappers over the libvips command line tools.

import type { MediaContext } from './context';

export interface ImageHeader {
  /** As stored in the file (before EXIF rotation). */
  rawWidth: number;
  rawHeight: number;
  /** Upright: EXIF orientation 5-8 swaps the sides. */
  width: number;
  height: number;
  bands: number;
  /** Pages/frames (GIF, animated WebP, multi-page TIFF or PDF); 1 when the file doesn't say. */
  pages: number;
}

/**
 * Read an image's size without decoding pixels. Returns null when vips can't read the file.
 * `vipsheader -a` prints every field, which is the only way to get optional ones (orientation,
 * n-pages) in one go without an error for a missing field.
 */
export async function vipsHeader(ctx: MediaContext, path: string): Promise<ImageHeader | null> {
  let text: string;
  try {
    text = (
      await ctx.runner.run('vipsheader', ['-a', path], { timeoutMs: ctx.imageTimeoutMs })
    ).stdout.toString('utf8');
  } catch (e) {
    if ((e as { reason?: string }).reason === 'closed') throw e;
    return null;
  }
  const field = (name: string): number | null => {
    const m = new RegExp(`^${name}: (-?\\d+)`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  const rawWidth = field('width');
  const rawHeight = field('height');
  if (!rawWidth || !rawHeight) return null;
  const orientation = field('orientation') ?? 1;
  const swap = orientation >= 5 && orientation <= 8;
  return {
    rawWidth,
    rawHeight,
    width: swap ? rawHeight : rawWidth,
    height: swap ? rawWidth : rawHeight,
    bands: field('bands') ?? 3,
    pages: field('n-pages') ?? 1,
  };
}

/**
 * Arguments for `vips thumbnail`: rotate upright by EXIF, fit `w` x `h` (`size`: force = exactly
 * that, down = never enlarge, both), and convert to sRGB. The conversion matters for pictures
 * with an embedded profile (Display P3 phone photos, Adobe RGB): without `--output-profile`
 * vips passes their values through and they look flat. `out` is a suffix like `.webp[Q=75]`
 * (result on stdout) or `.raw`.
 */
export function vipsThumbnailArgs(
  input: string,
  out: string,
  w: number,
  h: number,
  size: 'force' | 'down' | 'both',
): string[] {
  return [
    'thumbnail',
    input,
    out,
    String(w),
    '--height',
    String(h),
    '--size',
    size,
    '--output-profile',
    'srgb',
  ];
}
