// The pipeline for one file: probe -> duplicate check -> thumbnail -> palette -> createItem ->
// index. Every library write goes through the Eagle adapter (`deps.lib`). Never throws: every
// problem becomes a `failed` outcome, so one bad file can't stop a batch.
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { mkdir, open, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { EagleItemRecord, ImportOptions, Palette } from '../../shared/types';
import type {
  ChangeContext,
  EagleThumbResult,
  ImportDeps,
  NewItemInit,
  ProbeResult,
} from '../contracts';
import { addFolders, addTags } from '../eagle';
import { wholeSecond } from '../eagle/newItem';
import { eagleCanPreview } from '../media/formats';
import { isInside, isPartialExt, reasonOf, stripKnownExt } from './util';

/** Everything the pipeline needs to know about one file, decided by the front door that found it. */
export interface Job {
  /** File to copy in. Moved instead of copied only when it is one of our own temp files. */
  src: string;
  moveSource: boolean;
  /** Item name, without extension (the adapter sanitizes it). */
  name: string;
  /** A name the caller chose: drop a trailing ".ext" from it when that is the detected type. */
  stripNameExt?: boolean;
  folders: string[];
  tags: string[];
  modificationTime: number;
  url: string;
  annotation: string;
  star: number;
  /** Bookmarks describe themselves; real files are probed. */
  probe?: ProbeResult;
  /** Where the thumbnail comes from: the file itself, nothing (icon only), or a screenshot. */
  thumb: 'auto' | 'none' | { src: string; probe: ProbeResult };
  /** Cancelling the import stops a long md5 read of this file. */
  signal?: AbortSignal;
}

export type Outcome =
  /** `warning`: added, but not the way the caller will expect (a "picture" that can't be read). */
  | { kind: 'added'; id: string; warning?: string }
  | { kind: 'duplicate'; existingId: string }
  | { kind: 'failed'; reason: string }
  /** The import was cancelled while this file was being read. */
  | { kind: 'cancelled' };

/** Eagle keeps the first 32,768 UTF-16 units of a txt file in its `text` field. */
const TEXT_UNITS = 32 * 1024;

export class Pipeline {
  /**
   * Files of one size and type in flight right now. The next one waits, so it finds the first in
   * the index and two identical files in one batch can't both get in.
   */
  private busy = new Map<string, Promise<void>>();

  constructor(private readonly deps: ImportDeps) {}

  async ingest(job: Job, opts: ImportOptions, ctx: ChangeContext): Promise<Outcome> {
    try {
      const { lib, media } = this.deps;

      // 1. Look at the source.
      const st = await stat(job.src);
      if (!st.isFile()) return failed('not a file');
      // Eagle refuses empty files, except text files.
      if (st.size === 0 && extname(job.src).toLowerCase() !== '.txt') return failed('empty file');
      if (isInside(await realpath(job.src), await realpath(lib.root)))
        return failed('this file is already in the library');

      // 2. What is it? (Eagle's ext rules: mostly the file's own ext, see media/sniff.ts)
      const probed = job.probe ?? (await media.probe(job.src));
      const ext = probed.ext.trim().toLowerCase().replace(/^\./, '');
      if (!ext) return failed('unknown file type');
      if (isPartialExt(ext)) return failed('unfinished download');
      const probe = { ...probed, ext };
      const name = job.stripNameExt ? stripKnownExt(job.name, ext) : job.name;

      // 3. Same content already in the library? Only files of the same size and type can be, so
      //    only those get read for an md5.
      const mode = opts.onDuplicate ?? 'ask';
      if (mode === 'keep-both') return await this.create(job, name, st, probe, ctx);
      const key = `${st.size}:${extAliases(ext)[0]}`;
      for (let wait = this.busy.get(key); wait; wait = this.busy.get(key)) await wait;
      let done!: () => void;
      this.busy.set(key, new Promise<void>((resolve) => (done = resolve)));
      try {
        const candidates = sameSizeAndType(this.deps.index, st.size, ext);
        let md5: string | undefined;
        if (candidates.length) {
          md5 = await media.md5(job.src, job.signal);
          const existing = await findExisting(this.deps, candidates, st.size, md5, job.signal);
          if (existing) return await this.onExisting(existing, job, mode, ctx);
        }
        return await this.create(job, name, st, probe, ctx, md5);
      } finally {
        this.busy.delete(key);
        done();
      }
    } catch (e) {
      if (job.signal?.aborted) return { kind: 'cancelled' };
      return failed(reasonOf(e));
    }
  }

  /** Apply the caller's choice for a duplicate. */
  private async onExisting(
    existingId: string,
    job: Job,
    mode: NonNullable<ImportOptions['onDuplicate']>,
    ctx: ChangeContext,
  ): Promise<Outcome> {
    if (mode !== 'use-existing') return { kind: 'duplicate', existingId };
    // Keep the one item, but file it where the user asked and add the tags they asked for.
    const write = await this.deps.lib.updateItem(
      existingId,
      (rec) => {
        const tagged = addTags(rec, job.tags); // job.tags already hold the folders' auto-tags
        const filed = addFolders(rec, job.folders);
        return tagged || filed;
      },
      ctx,
    );
    if (write?.after) this.indexRecord(JSON.parse(write.after) as EagleItemRecord);
    return { kind: 'added', id: existingId };
  }

  /** Thumbnail, palette, then the new item. `md5` is stored when the duplicate check computed it. */
  private async create(
    job: Job,
    name: string,
    st: Stats,
    probe: ProbeResult,
    ctx: ChangeContext,
    md5?: string,
  ): Promise<Outcome> {
    const { lib, media } = this.deps;
    // Eagle keeps a txt file's text instead of a picture: no thumbnail, size or palette.
    const text = probe.ext === 'txt' ? await readText(job.src) : null;

    let thumb: EagleThumbResult | null = null;
    let thumbSrc = job.src;
    if (text === null && job.thumb !== 'none') {
      const from = job.thumb === 'auto' ? { src: job.src, probe } : job.thumb;
      const screenshot = job.thumb !== 'auto';
      thumbSrc = from.src;
      // A bookmark's screenshot always needs a real thumbnail file: the .url can't be shown.
      thumb = await media
        .eagleThumbnail(from.src, from.probe, undefined, screenshot ? { force: true } : undefined)
        .catch(() => null);
    }
    // No thumbnail and none needed is fine; no thumbnail when one was needed is an icon-only item.
    const noPreview = text === null && !thumb?.bytes && !thumb?.noThumbnail;
    // Eagle adds a file it can't draw as an icon-only item too (a text file named .jpg, a broken
    // download). Keep that, but say so: the file claimed to be a picture or video Eagle can show.
    const unreadable =
      noPreview &&
      job.thumb === 'auto' &&
      (probe.kind === 'image' || probe.kind === 'video') &&
      eagleCanPreview(probe.ext);
    const palettes = noPreview || text !== null ? null : await this.palette(probe, thumb, thumbSrc);

    const init: NewItemInit = {
      sourcePath: job.src,
      moveSource: job.moveSource && isInside(job.src, this.deps.tmpDir),
      name,
      ext: probe.ext,
      size: st.size,
      btime: wholeSecond(st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs),
      mtime: wholeSecond(st.mtimeMs),
      tags: job.tags,
      folders: job.folders,
      url: job.url,
      annotation: job.annotation,
      modificationTime: job.modificationTime,
    };
    if (job.star) init.star = job.star;
    const extra: Record<string, unknown> = {};
    if (noPreview) {
      init.noPreview = true; // icon only: no dimensions, no palette (format-spec 6)
    } else if (text !== null) {
      extra.text = text;
    } else {
      if (probe.width && probe.height) {
        init.width = probe.width;
        init.height = probe.height;
      }
      if (thumb?.noThumbnail) init.noThumbnail = true;
      if (thumb?.bytes) init.thumbnailBytes = thumb.bytes;
      if (thumb?.removeThumbnail) extra.removeThumbnail = true; // svg
      if (thumb?.forceThumbnail) extra.forceThumbnail = true;
      if (palettes) init.palettes = palettes;
      if (probe.kind === 'video' && init.width && init.height) {
        extra.resolutionWidth = init.width;
        extra.resolutionHeight = init.height;
      }
      if (probe.animated && (probe.ext === 'webp' || probe.ext === 'avif')) extra.animated = true;
    }
    if (Object.keys(extra).length) init.extra = extra;
    // `duration` is a named field: the adapter writes it after `extra`, which puts a video's keys
    // in Eagle's order (width, height, resolutionWidth, resolutionHeight, duration).
    if ((probe.kind === 'video' || probe.kind === 'audio') && probe.duration != null)
      init.duration = probe.duration;

    const { id, record } = await lib.createItem(init, ctx);
    this.indexRecord(record);
    // The copy's mtime is set to init.mtime, so this is the fingerprint dupes checks it against.
    if (md5) saveHash(this.deps.index, id, { size: st.size, fileMtime: init.mtime, md5 });
    if (!unreadable) return { kind: 'added', id };
    const what = probe.kind === 'video' ? 'a video' : 'a picture';
    return {
      kind: 'added',
      id,
      warning: `Couldn't read it as ${what}, so it was added as an icon only.`,
    };
  }

  /**
   * Eagle's palette input: the original when it shows the original (noThumbnail), else the
   * thumbnail (written to a temp file first). Audio never gets one. Null leaves
   * `processingPalette` for Eagle to fill in.
   */
  private async palette(
    probe: ProbeResult,
    thumb: EagleThumbResult | null,
    thumbSrc: string,
  ): Promise<Palette[] | null> {
    if (probe.kind === 'audio') return null;
    const { tmpDir, media } = this.deps;
    let tmp: string | null = null;
    try {
      let from = thumbSrc;
      if (thumb?.bytes) {
        await mkdir(tmpDir, { recursive: true });
        tmp = join(tmpDir, `thumb-${randomUUID()}.webp`);
        await writeFile(tmp, thumb.bytes);
        from = tmp;
      }
      // Both sizes are upright: the thumbnail's own, or the original's when it is shown as is.
      const w = thumb?.width;
      const h = thumb?.height;
      return await media.palette(from, w && h ? { width: w, height: h } : undefined);
    } catch {
      return null;
    } finally {
      if (tmp) await rm(tmp, { force: true }).catch(() => {});
    }
  }

  private indexRecord(record: EagleItemRecord): void {
    try {
      this.deps.index.upsertRecords([record]);
    } catch {
      // The item is safely on disk; the index is rebuilt from the library files if this failed.
    }
  }
}

// ───────────────────────── duplicate lookup (also used by "Add to other library") ─────────────────────────

/** Extensions that name the same kind of file: identical bytes saved as .jfif and .jpg are one picture. */
const EXT_GROUPS = [
  ['jpg', 'jpeg', 'jpe', 'jfif'],
  ['tif', 'tiff'],
  ['heic', 'heif', 'hif'],
];

export function extAliases(ext: string): string[] {
  return EXT_GROUPS.find((g) => g.includes(ext)) ?? [ext];
}

/** Live items with this byte size and type (the index has `items(size)`, so this is instant). */
export function sameSizeAndType(index: ImportDeps['index'], size: number, ext: string): string[] {
  const exts = extAliases(ext);
  const rows = index.db
    .prepare(
      `SELECT id FROM items WHERE size = ? AND ext IN (${exts.map(() => '?').join(',')}) AND is_deleted = 0`,
    )
    .all(size, ...exts) as { id: string }[];
  return rows.map((r) => r.id);
}

/** The hash cache is best effort: a failure here must not fail the caller. */
export function saveHash(
  index: ImportDeps['index'],
  id: string,
  h: Parameters<ImportDeps['index']['setHash']>[1],
): void {
  try {
    index.setHash(id, h);
  } catch {
    /* recomputed next time */
  }
}

/**
 * The first candidate whose file really has this md5. A cached hash counts only while the
 * original's size and mtime still match it; otherwise the original is hashed again (and cached).
 */
export async function findExisting(
  deps: Pick<ImportDeps, 'index' | 'lib' | 'media'>,
  ids: string[],
  size: number,
  md5: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const { index, lib, media } = deps;
  const cached = new Map(index.getHashes(ids).map((h) => [h.id, h]));
  for (const id of ids) {
    signal?.throwIfAborted();
    const rec = index.getRecord(id);
    const original = rec ? await lib.locateOriginal(id, rec) : null;
    const st = original ? await stat(original).catch(() => null) : null;
    if (!original || !st || st.size !== size) continue;
    const fileMtime = Math.trunc(st.mtimeMs);
    const row = cached.get(id);
    const valid = row && row.size === size && row.fileMtime === fileMtime ? row : null;
    let hash = valid?.md5 ?? null;
    if (!hash) {
      try {
        hash = await media.md5(original, signal);
      } catch (e) {
        if (signal?.aborted) throw e;
        continue; // an unreadable candidate can't be proven identical
      }
      saveHash(index, id, { size, fileMtime, md5: hash, dhash: valid?.dhash ?? undefined });
    }
    if (hash === md5) return id;
  }
  return null;
}

/**
 * The first 32,768 UTF-16 units of a text file, decoded like Eagle (Node's utf8, BOM kept).
 * UTF-8 never needs more than 3 bytes per unit, so reading that many bytes is always enough.
 */
async function readText(path: string): Promise<string> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(TEXT_UNITS * 3);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString('utf8').slice(0, TEXT_UNITS);
  } finally {
    await fh.close();
  }
}

function failed(reason: string): Outcome {
  return { kind: 'failed', reason };
}
