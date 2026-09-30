// Content hashes for the duplicate finder.

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, rmdir, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { MediaContext } from './context';
import { decodeRaw } from './pixels';

/**
 * md5 of the file's bytes, streamed 1 MiB at a time (no subprocess, never the whole file in
 * memory). Aborting stops the read and rejects with the abort reason.
 */
export function md5File(path: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5');
    createReadStream(path, { highWaterMark: 1024 * 1024, signal })
      .on('data', (chunk) => hash.update(chunk))
      .on('error', (e) => reject(signal?.aborted ? signal.reason : e))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * 64-bit difference hash of a 9x8 grayscale picture (72 bytes, row by row): each bit says
 * whether a pixel is brighter than its right neighbour. 16 hex characters, first bit first.
 */
export function dhashFromGray(gray: ArrayLike<number>): string {
  let hex = '';
  let nibble = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      nibble = (nibble << 1) | (gray[y * 9 + x] > gray[y * 9 + x + 1] ? 1 : 0);
      if ((y * 8 + x) % 4 === 3) {
        hex += nibble.toString(16);
        nibble = 0;
      }
    }
  }
  return hex;
}

/** Luma (Rec. 601, like Eagle's own phash) of vips raw output; transparency is flattened onto white. */
function grayOf(data: Uint8Array, bands: number, pixels: number): number[] {
  const gray: number[] = [];
  for (let i = 0; i < pixels; i++) {
    const o = i * bands;
    const alpha = bands === 2 ? data[o + 1] / 255 : bands === 4 ? data[o + 3] / 255 : 1;
    const luma = bands >= 3 ? 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2] : data[o];
    gray.push(luma * alpha + 255 * (1 - alpha));
  }
  return gray;
}

/** One file on its own (also the fallback for a file a batch couldn't do, with its own error). */
async function dhashOne(ctx: MediaContext, path: string): Promise<string> {
  // vips shrinks straight to 9x8 (shrink-on-load for big JPEGs), so this stays fast on originals too.
  const { data, bands } = await decodeRaw(ctx, path, 9, 8);
  return dhashFromGray(grayOf(data, bands, 72));
}

/**
 * Files per vipsthumbnail run. Starting vips costs ~30 ms and a 9x8 of a thumbnail ~4 ms, so one
 * process per file made a similar-duplicates scan of 85k items take 24 minutes.
 */
const DHASH_BATCH = 32;
/** How long a first request waits for others to join its batch. */
const GATHER_MS = 10;

interface DhashJob {
  path: string;
  resolve: (hash: string) => void;
  reject: (e: unknown) => void;
}
const queues = new WeakMap<MediaContext, { jobs: DhashJob[]; timer: NodeJS.Timeout | null }>();

/**
 * dHash of an image. Requests that arrive together (a duplicate scan runs many at once) share one
 * vipsthumbnail run; the answer is exactly the one-file `vips thumbnail` answer.
 */
export function dhashOf(ctx: MediaContext, path: string): Promise<string> {
  let q = queues.get(ctx);
  if (!q) queues.set(ctx, (q = { jobs: [], timer: null }));
  const queue = q;
  return new Promise((resolve, reject) => {
    queue.jobs.push({ path, resolve, reject });
    const flush = () => {
      if (queue.timer) clearTimeout(queue.timer);
      queue.timer = null;
      const jobs = queue.jobs.splice(0, DHASH_BATCH);
      if (queue.jobs.length) queue.timer = setTimeout(flush, 0);
      if (jobs.length) void runBatch(ctx, jobs);
    };
    if (queue.jobs.length >= DHASH_BATCH) flush();
    else queue.timer ??= setTimeout(flush, GATHER_MS);
  });
}

/** vipsthumbnail's name for an input's output (`%s`): the file name without its last extension. */
const outputName = (path: string): string => basename(path).replace(/\.[^.]*$/, '');

async function runBatch(ctx: MediaContext, jobs: DhashJob[]): Promise<void> {
  // Outputs are named after the inputs, so two inputs with one name (two "<name>_thumbnail.png"
  // from different items) can't share a run: the second goes on its own.
  const names = new Set<string>();
  const batch: DhashJob[] = [];
  for (const job of jobs) {
    const name = outputName(job.path);
    if (!name || names.has(name)) dhashOne(ctx, job.path).then(job.resolve, job.reject);
    else {
      names.add(name);
      batch.push(job);
    }
  }
  if (batch.length <= 1) {
    for (const job of batch) dhashOne(ctx, job.path).then(job.resolve, job.reject);
    return;
  }
  const dir = join(ctx.cacheDir, 'tmp', `dhash-${randomBytes(6).toString('hex')}`);
  const out = new Map<DhashJob, string>();
  try {
    await mkdir(dir, { recursive: true });
    try {
      await ctx.runner.run(
        'vipsthumbnail',
        ['--size', '9x8!', '--export-profile', 'srgb', '-o', join(dir, '%s.raw')].concat(
          batch.map((j) => j.path),
        ),
        { timeoutMs: ctx.imageTimeoutMs + batch.length * 1000 },
      );
    } catch (e) {
      // A file it couldn't read makes it exit non-zero after doing the rest; a closed pool is final.
      if ((e as { reason?: string }).reason === 'closed') throw e;
    }
    for (const job of batch) {
      const file = join(dir, `${outputName(job.path)}.raw`);
      let data: Buffer;
      try {
        data = await readFile(file);
        await unlink(file);
      } catch {
        continue;
      }
      const bands = data.length / 72;
      if (Number.isInteger(bands) && bands >= 1 && bands <= 4)
        out.set(job, dhashFromGray(grayOf(data, bands, 72)));
    }
  } catch (e) {
    const closed = (e as { reason?: string }).reason === 'closed';
    // Couldn't even set the batch up (a full cache disk?): one file at a time still works.
    for (const job of batch)
      if (closed) job.reject(e);
      else dhashOne(ctx, job.path).then(job.resolve, job.reject);
    return;
  } finally {
    // Something left in it (a run that stopped halfway) makes rmdir fail: then clear it all.
    await rmdir(dir).catch(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  }
  for (const job of batch) {
    const hash = out.get(job);
    if (hash) job.resolve(hash);
    else dhashOne(ctx, job.path).then(job.resolve, job.reject); // gets the real error, or a retry
  }
}
