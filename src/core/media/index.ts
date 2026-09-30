// Media service: probing, Eagle-rule thumbnails, palettes, previews and hashes.
// All decoding happens in vips/ffmpeg subprocesses (see exec.ts); nothing here imports electron.

import { resolve } from 'node:path';
import type { EagleThumbResult, MediaService, ProbeResult } from '../contracts';
import type { Palette } from '../../shared/types';
import type { MediaContext } from './context';
import { Runner } from './exec';
import { isBrowserViewable } from './formats';
import { md5File, dhashOf } from './hash';
import { paletteOf } from './palette';
import { previewOf } from './preview';
import { probeFile } from './probe';
import { eagleThumbnail, videoFrameWebp } from './thumbnail';

export interface MediaServiceOptions {
  cacheDir: string;
  /** Subprocesses running at once (default 6). */
  concurrency?: number;
  /** Kill an image tool after this long (default 30 s). */
  imageTimeoutMs?: number;
  /** Kill ffmpeg/ffprobe after this long (default 60 s). */
  videoTimeoutMs?: number;
}

export interface BoogieMediaService extends MediaService {
  /** One frame of a video as WebP bytes, native size (for "set cover frame"). */
  videoFrame(srcPath: string, atSec: number): Promise<Uint8Array>;
}

export function createMediaService(opts: MediaServiceOptions): BoogieMediaService {
  const ctx: MediaContext = {
    runner: new Runner(Math.max(1, opts.concurrency ?? 6)),
    cacheDir: resolve(opts.cacheDir),
    imageTimeoutMs: opts.imageTimeoutMs ?? 30_000,
    videoTimeoutMs: opts.videoTimeoutMs ?? 60_000,
    previewJobs: new Map(),
    previewFailures: new Map(),
  };
  return {
    probe: (path) => probeFile(ctx, resolve(path)),
    eagleThumbnail: (src, probe, size, o) => eagleThumbnail(ctx, resolve(src), probe, size, o),
    palette: (imagePath, dims): Promise<Palette[] | null> =>
      paletteOf(ctx, resolve(imagePath), dims),
    preview: (src, cacheKey, maxEdge) => previewOf(ctx, resolve(src), cacheKey, maxEdge),
    dhash: (imagePath) => dhashOf(ctx, resolve(imagePath)),
    md5: (path, signal) => md5File(resolve(path), signal),
    isBrowserViewable,
    videoFrame: (src, atSec) => videoFrameWebp(ctx, resolve(src), atSec, { quality: 90 }),
    close: () => ctx.runner.close(),
  };
}

export type { EagleThumbResult, ProbeResult };
export { mmcqPalette } from './palette/mmcq';
export { sniffExt, sniffHeader } from './sniff';
export {
  isBrowserViewable,
  eagleCanPreview,
  canRenderLocally,
  AUDIO_SIZE,
  FONT_SIZE,
} from './formats';
export { decideNoThumbnail, thumbnailDims } from './thumbnail';
export { dhashFromGray } from './hash';
