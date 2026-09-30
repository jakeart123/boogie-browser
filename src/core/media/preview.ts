// Browser-viewable renditions of formats Chromium can't show (HEIC, PSD, TIFF, RAW, PDF...), and
// smaller copies of pictures too big for it (HUGE_IMAGE). Rendered once into
// <cacheDir>/previews/<cacheKey>.webp (.jpg for the huge ones) and reused.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaContext } from './context';
import { FONT_SIZE, HUGE_IMAGE, VECTOR_EXTS, isBrowserViewable, kindOfExt } from './formats';
import { sniffFile } from './sniff';
import { fontSpecimen, videoFrameWebp, withKraImage } from './thumbnail';
import { vipsHeader, vipsThumbnailArgs } from './vips';

const QUALITY = 85;
/** Reading a 200+ MB original off a USB drive and shrinking it takes a while. */
const HUGE_TIMEOUT_MS = 180_000;
/** Remembered failures are forgotten after this many, so a long session can retry. */
const MAX_FAILURES = 5000;

/** Keep the key usable as a file name; if it needed changes, add a hash so two keys can't collide. */
function fileNameFor(cacheKey: string): string {
  const clean = cacheKey.replace(/[^\w.-]/g, '_').slice(0, 120);
  return clean === cacheKey
    ? clean
    : `${clean}-${createHash('sha1').update(cacheKey).digest('hex').slice(0, 8)}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

/** A browser-viewable file too big for the browser to show (HUGE_IMAGE), by its header. */
async function tooBigForBrowser(ctx: MediaContext, src: string): Promise<boolean> {
  const h = await vipsHeader(ctx, src);
  return !!h && h.width * h.height > HUGE_IMAGE.pixels;
}

/**
 * A huge photo or scan, shrunk to maxEdge as a JPEG: at 8192 px vips encodes that in ~3 s where
 * WebP takes ~16 s, and Chromium decodes it faster too. Transparency is flattened onto white.
 */
async function renderHuge(ctx: MediaContext, src: string, maxEdge: number): Promise<Uint8Array> {
  const args = vipsThumbnailArgs(
    src,
    `.jpg[Q=${QUALITY},strip,background=255]`,
    maxEdge,
    maxEdge,
    'down',
  );
  const timeoutMs = Math.max(ctx.imageTimeoutMs, HUGE_TIMEOUT_MS);
  return (await ctx.runner.run('vips', args, { timeoutMs })).stdout;
}

async function render(
  ctx: MediaContext,
  src: string,
  ext: string,
  maxEdge: number,
): Promise<Uint8Array> {
  const kind = kindOfExt(ext);
  if (kind === 'video') {
    // Not playable in Chromium (mkv, avi...): a poster frame, scaled down to maxEdge.
    const fit = `scale=min(iw\\,${maxEdge}):min(ih\\,${maxEdge}):force_original_aspect_ratio=decrease,setsar=1`;
    return videoFrameWebp(ctx, src, 1, { filter: fit, quality: QUALITY });
  }
  if (kind === 'font') {
    const edge = Math.min(maxEdge, FONT_SIZE.width);
    return fontSpecimen(ctx, src, edge, edge);
  }
  if (kind !== 'image' && !VECTOR_EXTS.has(ext)) throw new Error(`no preview for .${ext} files`);

  // Raster: never enlarge. PDF/AI/EPS are vector: render at the target size.
  const size = VECTOR_EXTS.has(ext) ? 'both' : 'down';
  const args = (input: string) =>
    vipsThumbnailArgs(input, `.webp[Q=${QUALITY},strip]`, maxEdge, maxEdge, size);
  const run = async (input: string) =>
    (await ctx.runner.run('vips', args(input), { timeoutMs: ctx.imageTimeoutMs })).stdout;
  return ext === 'kra' ? withKraImage(ctx, src, run) : run(src);
}

export async function previewOf(
  ctx: MediaContext,
  src: string,
  cacheKey: string,
  maxEdge = 2560,
): Promise<string> {
  const dir = join(ctx.cacheDir, 'previews');
  const base = join(dir, fileNameFor(cacheKey));
  // Cache hit: no need to even open the source.
  for (const done of [`${base}.webp`, `${base}.jpg`]) if (await exists(done)) return done;
  const failed = ctx.previewFailures.get(base);
  if (failed !== undefined) throw new Error(failed);
  const { ext } = await sniffFile(src);
  // A browser-viewable file only gets here when it may be too big for the browser.
  const viewable = isBrowserViewable(ext);
  if (viewable && !(await tooBigForBrowser(ctx, src))) return src; // nothing to render
  const out = `${base}.${viewable ? 'jpg' : 'webp'}`;

  // Two asks for one preview share one render.
  let job = ctx.previewJobs.get(out);
  if (!job) {
    job = (async () => {
      await mkdir(dir, { recursive: true });
      const bytes = viewable
        ? await renderHuge(ctx, src, maxEdge)
        : await render(ctx, src, ext, maxEdge);
      if (!bytes.length) throw new Error('empty preview');
      // Write beside, then rename, so a reader never sees half a file.
      const tmp = `${out}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, out);
      return out;
    })()
      .catch((e: unknown) => {
        // A closed pool is not the file's fault; anything else would fail the same way again.
        if ((e as { reason?: string }).reason !== 'closed') {
          if (ctx.previewFailures.size >= MAX_FAILURES) ctx.previewFailures.clear();
          ctx.previewFailures.set(base, e instanceof Error ? e.message : String(e));
        }
        throw e;
      })
      .finally(() => ctx.previewJobs.delete(out));
    ctx.previewJobs.set(out, job);
  }
  return job;
}
