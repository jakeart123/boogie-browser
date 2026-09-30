// palette(imagePath): decode like Eagle does, then run the quantizer.

import type { Palette } from '../../../shared/types';
import type { MediaContext } from '../context';
import { kindOfExt } from '../formats';
import { bilinearResize, decodeRaw, toRgba } from '../pixels';
import { sniffFile } from '../sniff';
import { vipsHeader } from '../vips';
import { mmcqPalette } from './mmcq';

/** Eagle skips palettes when height/width exceeds 30,000,000 / 480^2 (about 130). */
const MAX_ASPECT = 30_000_000 / (480 * 480);
const ANALYSIS_WIDTH = 360;
/** Above this many pixels we let vips do the shrinking instead of holding the whole image. */
const MAX_FULL_DECODE_PIXELS = 4_000_000;

/** `dims` is the upright size when the caller knows it (the importer does), saving a vips run. */
export async function paletteOf(
  ctx: MediaContext,
  path: string,
  dims?: { width: number; height: number },
): Promise<Palette[] | null> {
  const { ext } = await sniffFile(path);
  if (kindOfExt(ext) === 'audio') return null;

  try {
    const header = dims?.width && dims.height ? dims : await vipsHeader(ctx, path);
    if (!header || header.height / header.width > MAX_ASPECT) return null;
    const { width: w, height: h } = header;

    // Eagle draws the image at width min(w, 360) into a canvas, plain bilinear.
    const W = Math.min(w, ANALYSIS_WIDTH);
    const H = Math.max(1, Math.round(h / (w / W)));
    let rgba: Uint8Array;
    if (W === w || w * h > MAX_FULL_DECODE_PIXELS) {
      // No resampling needed (the usual case for a 320 px thumbnail), or too big to hold at full
      // size: let vips shrink it.
      const raw = await decodeRaw(ctx, path, W, H);
      rgba = toRgba(raw.data, raw.bands, W * H);
    } else {
      const raw = await decodeRaw(ctx, path, w, h);
      rgba = bilinearResize(toRgba(raw.data, raw.bands, w * h), w, h, W, H);
    }
    const palette = mmcqPalette(rgba, W, H);
    return palette.length ? palette : null;
  } catch (e) {
    if ((e as { reason?: string }).reason === 'closed') throw e;
    return null;
  }
}

export { mmcqPalette } from './mmcq';
