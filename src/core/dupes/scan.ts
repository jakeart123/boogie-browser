// Duplicate scan: exact copies by content hash, near-copies by perceptual hash.
//
// Speed comes from doing as little I/O as possible: exact mode only hashes files whose byte size
// is shared with another item, and every hash is cached in the library's index (`hashes` table)
// keyed by the original's size + mtime, so a second scan reads nothing but file metadata.
import { stat } from 'node:fs/promises';
import type {
  DupeScanOptions,
  DupeScanStats,
  DuplicateGroup,
  DuplicateMember,
  EagleItemRecord,
} from '../../shared/types';
import type { DupeSource, MediaService, ScanProgress } from '../contracts';
import { clusterHashesInSlices, hamming, isDhash, MAX_THRESHOLD } from './cluster';
import { strings } from './planMerge';
import { scopeSql, type ScopeSql } from './scope';

/** Similar-mode clusters bigger than this are almost always blank or solid images. */
export const MAX_CLUSTER = 50;
const DEFAULT_THRESHOLD = 6;
/** Reading whole originals for md5: 4 at once on an SSD, 2 on a slow drive (more just seek). */
const FAST_CONCURRENCY = 4;
const SLOW_CONCURRENCY = 2;
/**
 * Perceptual hashes read small thumbnails, and media batches the requests that arrive together
 * into one vips run (see media/hash.ts), so many in flight is what makes it fast on any drive.
 */
const SIMILAR_CONCURRENCY = 64;

/** Extensions worth a perceptual hash (Eagle makes thumbnails for the odd ones, e.g. psd, raw). */
const IMAGE_EXTS = [
  'jpg',
  'jpeg',
  'jfif',
  'png',
  'gif',
  'webp',
  'avif',
  'bmp',
  'tif',
  'tiff',
  'heic',
  'heif',
  'svg',
  'psd',
  'ico',
  'cr2',
  'cr3',
  'nef',
  'arw',
  'dng',
  'orf',
  'rw2',
  'raf',
];

type HashRow = ReturnType<DupeSource['index']['getHashes']>[number];

/** A source, plus whether it sits on slow storage (service/storage decides; default fast). */
export type ScanSource = DupeSource & { slow?: boolean };

interface Src {
  source: DupeSource;
  current: boolean;
  slow: boolean;
  rows?: Map<string, HashRow>;
}

/** One item taking part in a scan. `hash` is its md5 (exact mode) or dhash (similar mode). */
interface Cand {
  src: Src;
  id: string;
  size: number;
  hash?: string;
}

interface Loaded {
  c: Cand;
  rec: EagleItemRecord;
}

interface Ctx {
  sources: Src[];
  scope: ScopeSql;
  media: MediaService;
  onProgress?: (p: ScanProgress) => void;
  signal?: AbortSignal;
  stats: DupeScanStats;
}

export async function scanDuplicates(
  opts: DupeScanOptions,
  current: ScanSource,
  others: ScanSource[],
  media: MediaService,
  onProgress?: (p: ScanProgress) => void,
  signal?: AbortSignal,
  stats?: DupeScanStats,
): Promise<DuplicateGroup[]> {
  signal?.throwIfAborted();
  const scope = scopeSql(opts.scope);
  const st = stats ?? ({} as DupeScanStats);
  Object.assign(st, { candidates: 0, hashed: 0, cached: 0, failed: 0, skippedClusters: 0 });
  if (!scope) return []; // the Trash scope holds nothing live

  // The same library listed twice (or as its own "other") would match every item with itself.
  const seen = new Set([current.ref.id]);
  const sources: Src[] = [toSrc(current, true)];
  for (const o of others) {
    if (seen.has(o.ref.id)) continue;
    seen.add(o.ref.id);
    sources.push(toSrc(o, false));
  }

  const ctx: Ctx = { sources, scope, media, onProgress, signal, stats: st };
  return opts.mode === 'similar' ? scanSimilar(opts, ctx) : scanExact(ctx);
}

// ───────────────────────── exact ─────────────────────────

async function scanExact(ctx: Ctx): Promise<DuplicateGroup[]> {
  // Group by byte size across every source; only sizes shared by 2+ items can hold duplicates.
  const bySize = new Map<number, Cand[]>();
  for (const src of ctx.sources) {
    for (const r of liveRows(src, ctx, false)) {
      if (r.size <= 0) continue; // Eagle refuses empty files; they'd all "match" each other
      const list = bySize.get(r.size);
      const c: Cand = { src, id: r.id, size: r.size };
      if (list) list.push(c);
      else bySize.set(r.size, [c]);
    }
  }
  // A group with nothing from the current library can't be acted on, so don't hash it.
  const cands: Cand[] = [];
  for (const list of bySize.values())
    if (list.length > 1 && list.some((c) => c.src.current)) cands.push(...list);

  await fingerprint(cands, 'md5', ctx);
  ctx.signal?.throwIfAborted();

  const byMd5 = new Map<string, Cand[]>();
  for (const c of cands) {
    if (!c.hash) continue;
    const list = byMd5.get(c.hash);
    if (list) list.push(c);
    else byMd5.set(c.hash, [c]);
  }
  const groups: DuplicateGroup[] = [];
  for (const [md5, list] of byMd5) {
    if (list.length < 2 || !list.some((c) => c.src.current)) continue;
    const g = buildGroup('exact', md5, list, false);
    if (g) groups.push(g);
  }
  // Biggest wasted space first.
  const wasted = (g: DuplicateGroup) => g.members[0].size * (g.members.length - 1);
  return groups.sort((a, b) => wasted(b) - wasted(a) || (a.key < b.key ? -1 : 1));
}

// ───────────────────────── similar ─────────────────────────

async function scanSimilar(opts: DupeScanOptions, ctx: Ctx): Promise<DuplicateGroup[]> {
  const threshold = Math.min(
    MAX_THRESHOLD,
    Math.max(0, Math.floor(opts.threshold ?? DEFAULT_THRESHOLD)),
  );
  const cands: Cand[] = [];
  for (const src of ctx.sources) {
    for (const r of liveRows(src, ctx, true)) cands.push({ src, id: r.id, size: r.size });
  }

  await fingerprint(cands, 'dhash', ctx);

  const hashed = cands.filter((c) => isDhash(c.hash));
  const groups: DuplicateGroup[] = [];
  // Clustering 85k hashes is ~0.7 s of work: done in slices so the app keeps answering.
  const clusters = await clusterHashesInSlices(
    hashed.map((c) => c.hash as string),
    threshold,
    ctx.signal,
  );
  for (const idx of clusters) {
    const list = idx.map((i) => hashed[i]);
    if (!list.some((c) => c.src.current)) continue;
    if (list.length > MAX_CLUSTER) {
      ctx.stats.skippedClusters++;
      continue;
    }
    const key = 'similar-' + list.map((c) => (c.hash as string).toLowerCase()).sort()[0];
    const g = buildGroup('similar', key, list, true);
    if (g) groups.push(g);
  }
  return groups.sort((a, b) => b.members.length - a.members.length || (a.key < b.key ? -1 : 1));
}

// ───────────────────────── gathering ─────────────────────────

function toSrc(source: ScanSource, current: boolean): Src {
  return { source, current, slow: !!source.slow };
}

/** Live (not trashed) items. The scope only limits the current library. */
function liveRows(src: Src, ctx: Ctx, imagesOnly: boolean): { id: string; size: number }[] {
  const params: unknown[] = [];
  let sql = 'SELECT i.id AS id, i.size AS size FROM items i WHERE i.is_deleted = 0';
  if (imagesOnly) {
    sql += ` AND i.no_preview = 0 AND i.ext IN (${IMAGE_EXTS.map(() => '?').join(',')})`;
    params.push(...IMAGE_EXTS);
  }
  if (src.current) {
    sql += ' ' + ctx.scope.where;
    params.push(...ctx.scope.params);
  }
  return src.source.index.db.prepare(sql).all(...params) as {
    id: string;
    size: number;
  }[];
}

/** The index's cached hashes for a source, read once per scan. */
function hashRows(src: Src): Map<string, HashRow> {
  if (!src.rows) {
    src.rows = new Map();
    try {
      for (const r of src.source.index.getHashes()) src.rows.set(r.id, r);
    } catch {
      /* no cache: everything gets computed */
    }
  }
  return src.rows;
}

// ───────────────────────── hashing ─────────────────────────

interface Fingerprint {
  size: number;
  mtime: number;
}

/**
 * Fill `c.hash` for every candidate: from the index cache when the original's size and mtime
 * still match, else by reading the file. Files that can't be read are left without a hash.
 */
async function fingerprint(cands: Cand[], kind: 'md5' | 'dhash', ctx: Ctx): Promise<void> {
  ctx.stats.candidates = cands.length;
  const progress = makeProgress(cands.length, ctx.onProgress);
  const work = async (c: Cand) => {
    ctx.signal?.throwIfAborted();
    try {
      await hashOne(c, kind, ctx);
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      ctx.stats.failed++;
    }
    progress.tick();
  };
  await runPools(cands, work, kind);
}

async function hashOne(c: Cand, kind: 'md5' | 'dhash', ctx: Ctx): Promise<void> {
  const { lib, index } = c.src.source;
  const rec = index.getRecord(c.id);
  if (!rec) throw new Error('not in the index');
  const original = await lib.locateOriginal(c.id, rec);
  let fp: Fingerprint | null = null;
  if (original)
    fp = await stat(original).then(
      (s) => ({ size: s.size, mtime: Math.trunc(s.mtimeMs) }),
      () => null,
    );
  if (kind === 'md5' && (!original || !fp)) throw new Error('original is missing');
  // The grouping trusted the record's size; a file that no longer matches must not be merged.
  if (kind === 'md5' && fp && fp.size !== c.size)
    throw new Error('file size differs from the index');

  const row = hashRows(c.src).get(c.id);
  const fresh = !!row && !!fp && row.size === fp.size && row.fileMtime === fp.mtime;
  const cached = fresh ? row![kind] : null;
  if (cached && (kind === 'md5' || isDhash(cached))) {
    c.hash = cached;
    ctx.stats.cached++;
    return;
  }

  // Perceptual hashes come from Eagle's small thumbnail when there is one (fast, and the
  // original may be huge); md5 always reads the original.
  const path = kind === 'md5' ? original : ((await lib.locateThumbnail(c.id, rec)) ?? original);
  if (!path) throw new Error('no file to read');
  const value = await abortable(
    kind === 'md5' ? ctx.media.md5(path, ctx.signal) : ctx.media.dhash(path),
    ctx.signal,
  );
  c.hash = value;
  ctx.stats.hashed++;

  if (fp) {
    // Keep the other hash if it is still valid for this file: setHash may replace the whole row.
    const keep = fresh ? row : null;
    try {
      index.setHash(c.id, {
        size: fp.size,
        fileMtime: fp.mtime,
        md5: kind === 'md5' ? value : (keep?.md5 ?? undefined),
        dhash: kind === 'dhash' ? value : (keep?.dhash ?? undefined),
      });
    } catch {
      /* the cache is best effort */
    }
  }
}

/**
 * Run `fn` over the items. md5 reads whole originals: up to 4 at once on fast storage, 2 on slow.
 * dhash reads thumbnails: SIMILAR_CONCURRENCY at once, wherever they are.
 */
async function runPools(
  cands: Cand[],
  fn: (c: Cand) => Promise<void>,
  kind: 'md5' | 'dhash',
): Promise<void> {
  let stop = false;
  const spawn = (list: Cand[], limit: number) => {
    let next = 0;
    return Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (!stop && next < list.length) {
        try {
          await fn(list[next++]);
        } catch (e) {
          stop = true;
          throw e;
        }
      }
    });
  };
  const workers =
    kind === 'dhash'
      ? spawn(cands, SIMILAR_CONCURRENCY)
      : [
          ...spawn(
            cands.filter((c) => !c.src.slow),
            FAST_CONCURRENCY,
          ),
          ...spawn(
            cands.filter((c) => c.src.slow),
            SLOW_CONCURRENCY,
          ),
        ];
  // Wait for every worker so nothing is still reading when we return or throw.
  const results = await Promise.allSettled(workers);
  const bad = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (bad) throw bad.reason;
}

/**
 * Give up waiting the moment the scan is cancelled. md5 also stops reading on the signal, but a
 * dhash subprocess can't be interrupted, so its result is simply dropped.
 */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function makeProgress(total: number, cb?: (p: ScanProgress) => void) {
  let done = 0;
  let last = 0;
  const emit = (force: boolean) => {
    const now = Date.now();
    if (force || now - last >= 100) {
      last = now;
      cb?.({ done, total });
    }
  };
  emit(true);
  return {
    tick() {
      done++;
      emit(done >= total);
    },
  };
}

// ───────────────────────── groups ─────────────────────────

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function toMember(l: Loaded, distance: number): DuplicateMember {
  const { ref, urls } = l.c.src.source;
  const { rec } = l;
  return {
    libraryId: ref.id,
    libraryName: ref.name,
    id: l.c.id,
    name: rec.name,
    ext: rec.ext,
    size: rec.size,
    width: num(rec.width),
    height: num(rec.height),
    folders: strings(rec.folders),
    tags: strings(rec.tags),
    star: Number(rec.star) || 0,
    importedAt: Number(rec.modificationTime) || 0,
    thumbUrl: urls.thumb(l.c.id, Number(rec.lastModified) || 0),
    distance,
  };
}

/** Best keeper first: (similar: most pixels), most folders, most tags, has a note, oldest. */
function keeperOrder(similar: boolean) {
  const pixels = (l: Loaded) => (num(l.rec.width) ?? 0) * (num(l.rec.height) ?? 0);
  const added = (l: Loaded) => Number(l.rec.modificationTime) || 0;
  return (a: Loaded, b: Loaded): number =>
    (similar ? pixels(b) - pixels(a) : 0) ||
    strings(b.rec.folders).length - strings(a.rec.folders).length ||
    strings(b.rec.tags).length - strings(a.rec.tags).length ||
    Number(String(b.rec.annotation ?? '').trim() !== '') -
      Number(String(a.rec.annotation ?? '').trim() !== '') ||
    added(a) - added(b) ||
    (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0);
}

function buildGroup(
  kind: 'exact' | 'similar',
  key: string,
  cands: Cand[],
  similar: boolean,
): DuplicateGroup | null {
  const items: Loaded[] = [];
  for (const c of cands) {
    const rec = c.src.source.index.getRecord(c.id);
    if (rec) items.push({ c, rec });
  }
  const currentItems = items.filter((l) => l.c.src.current);
  if (items.length < 2 || currentItems.length === 0) return null;

  // Current library first, then oldest first; the rest only makes the order deterministic.
  items.sort(
    (a, b) =>
      Number(b.c.src.current) - Number(a.c.src.current) ||
      (Number(a.rec.modificationTime) || 0) - (Number(b.rec.modificationTime) || 0) ||
      (a.c.src.source.ref.name < b.c.src.source.ref.name
        ? -1
        : a.c.src.source.ref.name > b.c.src.source.ref.name
          ? 1
          : 0) ||
      (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0),
  );
  const keeper = [...currentItems].sort(keeperOrder(similar))[0];
  const members = items.map((l) =>
    toMember(l, similar ? hamming(keeper.c.hash as string, l.c.hash as string) : 0),
  );
  return { key, kind, members, suggestedKeeperId: keeper.c.id };
}
