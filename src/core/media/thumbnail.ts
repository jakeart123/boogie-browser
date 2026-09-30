// Eagle's thumbnails, reproduced from research/format-spec.md section 6 and
// thumbs-palette-import.md 1.2-1.6: when there is none (`noThumbnail`), how big it is, and
// lossy WebP q75 upright bytes for `<name>_thumbnail.png`.

import { randomBytes } from 'node:crypto';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { EagleThumbResult, ProbeResult } from '../contracts';
import type { MediaContext } from './context';
import { AUDIO_SIZE, FONT_SIZE, eagleCanPreview, thumbnailSizeFor } from './formats';
import { vipsThumbnailArgs } from './vips';
import { extractZipEntry } from './zip';

const SMALL_SIDE = 960;
const SMALL_FILE_BYTES = 15_000_000;
const PNG_ALWAYS_OVER = 1_048_576; // 1 MiB
const SVG_SMALL_BYTES = 100_000;
const WEBP_MAX_SIDE = 16383;
const NO_THUMB_FAIL: EagleThumbResult = {
  noThumbnail: false,
  bytes: null,
  width: null,
  height: null,
};

/** Does this file get no thumbnail file at all (the original is shown instead)? */
export function decideNoThumbnail(
  probe: ProbeResult,
  bytes: number,
): Pick<EagleThumbResult, 'noThumbnail' | 'removeThumbnail' | 'forceThumbnail'> {
  const { ext, width, height } = probe;
  const small = width !== null && height !== null && width <= SMALL_SIDE && height <= SMALL_SIDE;
  switch (ext) {
    case 'jpg':
    case 'jfif':
    case 'bmp':
    case 'jxl':
      return { noThumbnail: small && bytes <= SMALL_FILE_BYTES };
    case 'png':
      return { noThumbnail: small && bytes <= SMALL_FILE_BYTES && bytes <= PNG_ALWAYS_OVER };
    case 'avif':
      return { noThumbnail: small && bytes <= SMALL_FILE_BYTES && !probe.animated };
    case 'webp': // no file size test for webp
      return { noThumbnail: small && !probe.animated };
    case 'svg':
      return bytes < SVG_SMALL_BYTES
        ? { noThumbnail: true, removeThumbnail: true }
        : { noThumbnail: false, forceThumbnail: true };
    default: // gif and everything else always get one
      return { noThumbnail: false };
  }
}

/**
 * Eagle's thumbnail size for a `w` x `h` picture and size S: unchanged if the long edge fits,
 * else the SHORT edge becomes S and the long edge follows, truncated. So a picture that is long
 * but thin is scaled UP on its short edge (300x1000 becomes 320x1066).
 */
export function thumbnailDims(w: number, h: number, S: number): [number, number] {
  if (Math.max(w, h) <= S) return [w, h];
  return w > h ? [Math.floor((S * w) / h), S] : [S, Math.floor((S * h) / w)];
}

// ── rendering ──

async function vipsWebp(
  ctx: MediaContext,
  input: string,
  w: number,
  h: number,
): Promise<Uint8Array> {
  // WebP can't hold more than 16383 px; Eagle writes JPEG q70 for those.
  const big = w > WEBP_MAX_SIDE || h > WEBP_MAX_SIDE;
  const out = big ? '.jpg[Q=70,strip]' : '.webp[Q=75,strip]';
  const args = vipsThumbnailArgs(input, out, w, h, 'force'); // exactly w x h, worked out by thumbnailDims
  return (await ctx.runner.run('vips', args, { timeoutMs: ctx.imageTimeoutMs })).stdout;
}

async function ffmpegWebp(ctx: MediaContext, args: string[]): Promise<Uint8Array> {
  // prettier-ignore
  const full = ['-v', 'error', ...args, '-frames:v', '1', '-c:v', 'libwebp', '-q:v', '75', '-f', 'webp', 'pipe:1'];
  const { stdout } = await ctx.runner.run('ffmpeg', full, { timeoutMs: ctx.videoTimeoutMs });
  if (!stdout.length) throw new Error('ffmpeg produced no frame');
  return stdout;
}

/** The frame Eagle grabs: a third of the way in, but never later than 10 s (video.js). */
function videoThumbTime(duration: number | null): number {
  return duration ? Math.min(10, duration / 3) : 0;
}

/** Eagle draws the frame on a 480 px wide canvas (height truncated) and shrinks that by the usual rule. */
const VIDEO_CANVAS = 480;

/**
 * One video frame as WebP. `filter` is an ffmpeg video filter (scaling); without it the frame
 * keeps its native, upright size.
 */
export async function videoFrameWebp(
  ctx: MediaContext,
  src: string,
  atSec: number,
  opts: { filter?: string; quality?: number } = {},
): Promise<Uint8Array> {
  const args = ['-v', 'error', '-ss', String(Math.max(0, atSec)), '-i', src, '-frames:v', '1'];
  if (opts.filter) args.push('-vf', opts.filter);
  args.push('-c:v', 'libwebp', '-q:v', String(opts.quality ?? 75), '-f', 'webp', 'pipe:1');
  let { stdout } = await ctx.runner.run('ffmpeg', args, { timeoutMs: ctx.videoTimeoutMs });
  if (!stdout.length && atSec > 0) {
    // Seeked past the last frame (bad duration): take the first one.
    args[args.indexOf('-ss') + 1] = '0';
    stdout = (await ctx.runner.run('ffmpeg', args, { timeoutMs: ctx.videoTimeoutMs })).stdout;
  }
  if (!stdout.length) throw new Error('no video frame');
  return stdout;
}

/** Waveform picture for audio: Eagle draws it 280x140 in its blue (thumbnailDims keeps that size). */
function audioWaveform(ctx: MediaContext, src: string, w: number, h: number): Promise<Uint8Array> {
  const filter = `aformat=channel_layouts=mono,showwavespic=s=${w}x${h}:colors=0x0072EF`;
  return ffmpegWebp(ctx, ['-i', src, '-filter_complex', filter]);
}

/** Font specimen, 600x600 (Eagle uses html2canvas with the same three lines). */
export async function fontSpecimen(
  ctx: MediaContext,
  src: string,
  w: number,
  h: number,
): Promise<Uint8Array> {
  // prettier-ignore
  const args = [
    '-size', `${FONT_SIZE.width}x${FONT_SIZE.height}`, 'xc:white', '-font', src, '-pointsize', '90', '-fill', 'black',
    '-gravity', 'center', '-annotate', '+0+0', 'ABCDEFG\nabcdefg\n0123456', '-resize', `${w}x${h}!`, '-quality', '75', 'webp:-',
  ];
  const { stdout } = await ctx.runner.run('magick', args, { timeoutMs: ctx.imageTimeoutMs });
  if (!stdout.length) throw new Error('empty specimen');
  return stdout;
}

/** Krita: unpack the flattened picture from the .kra zip to a scratch file for `fn`, then remove it. */
export async function withKraImage<T>(
  ctx: MediaContext,
  src: string,
  fn: (pngPath: string) => Promise<T>,
): Promise<T> {
  const dir = join(ctx.cacheDir, 'tmp');
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `kra-${randomBytes(6).toString('hex')}.png`);
  try {
    if (!(await extractZipEntry(src, 'mergedimage.png', tmp)))
      throw new Error('no mergedimage.png');
    return await fn(tmp);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/** The size of the picture Eagle compresses into the thumbnail, before the S rule. */
function baseSize(probe: ProbeResult): { width: number; height: number } | null {
  const { kind, width, height } = probe;
  // Types that draw their own picture have a fixed size to start from.
  if (kind === 'audio') return AUDIO_SIZE;
  if (kind === 'font') return FONT_SIZE;
  if (!width || !height) return null;
  if (kind === 'video')
    return { width: VIDEO_CANVAS, height: Math.trunc((VIDEO_CANVAS * height) / width) || 1 };
  return { width, height };
}

/**
 * `force` skips Eagle's "show the original instead" rules and the Windows format list: the
 * caller wants a real thumbnail file (a bookmark's screenshot).
 */
export async function eagleThumbnail(
  ctx: MediaContext,
  src: string,
  probe: ProbeResult,
  size?: number,
  opts: { force?: boolean } = {},
): Promise<EagleThumbResult> {
  const { ext, kind } = probe;
  if (!opts.force && !eagleCanPreview(ext)) return NO_THUMB_FAIL;
  const decision = opts.force
    ? { noThumbnail: false }
    : decideNoThumbnail(probe, (await stat(src)).size);
  if (decision.noThumbnail)
    return { ...decision, bytes: null, width: probe.width, height: probe.height };

  const S = size ?? thumbnailSizeFor(ext);
  const base = baseSize(probe);
  if (!base) return NO_THUMB_FAIL;
  const [w, h] = thumbnailDims(base.width, base.height, S);

  try {
    let out: Uint8Array;
    if (kind === 'video') {
      out = await videoFrameWebp(ctx, src, videoThumbTime(probe.duration), {
        filter: `scale=${w}:${h},setsar=1`,
      });
    } else if (kind === 'audio') {
      out = await audioWaveform(ctx, src, w, h);
    } else if (kind === 'font') {
      out = await fontSpecimen(ctx, src, w, h);
    } else if (ext === 'kra') {
      out = await withKraImage(ctx, src, (png) => vipsWebp(ctx, png, w, h));
    } else if (kind === 'image' || ext === 'pdf' || ext === 'ai' || ext === 'eps') {
      out = await vipsWebp(ctx, src, w, h);
    } else {
      return NO_THUMB_FAIL; // office files, 3D, text and the like: nothing we can draw
    }
    if (!out.length) return NO_THUMB_FAIL;
    return { ...decision, noThumbnail: false, bytes: out, width: w, height: h };
  } catch (e) {
    if ((e as { reason?: string }).reason === 'closed') throw e;
    return NO_THUMB_FAIL;
  }
}
