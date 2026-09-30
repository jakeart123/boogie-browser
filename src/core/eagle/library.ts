// The EagleLibrary implementation: the only code in the app that reads or writes a library.
// Every write is: fresh read from disk, apply the change, lastModified bump, journal the before
// and after text, atomic write, then queue the mtime.json raise that lets the partner's Eagle see it.
import { constants } from 'node:fs';
import { copyFile, cp, mkdir, readdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { EagleItemRecord, EagleRootRecord } from '../../shared/types';
import type {
  ChangeContext,
  Doc,
  EagleLibrary,
  EagleLibraryFactory,
  EagleSavedFilter,
  EagleTagsFile,
  ItemWrite,
  JournalSink,
  NewItemInit,
} from '../contracts';
import { assertWritable } from '../safety/writeGuard';
import {
  copyFileGuarded,
  mkdirGuarded,
  removeCreatedFolder,
  renameGuarded,
  setTimesGuarded,
  unlinkGuarded,
  writeFileAtomic,
} from './atomic';
import { createLibrary, probeLibrary } from './create';
import {
  ItemNotFoundError,
  ItemUnreadableError,
  LibraryUnreadableError,
  PartialWriteError,
  ReadOnlyError,
  isSkippableItemError,
} from './errors';
import { assertItemId, guid, isItemId } from './ids';
import { serialize } from './json';
import { KeyedLock } from './lock';
import { MtimeBatcher, type RaiseInfo } from './mtime';
import { buildItemRecord } from './newItem';
import { sanitizeItemName } from './names';
import {
  ROOT_METADATA,
  childPath,
  imagesDir,
  isInsideLibraryFolder,
  itemDir,
  itemMetadataRel,
  metadataPath,
  relFromRoot,
  thumbnailJournalRel,
} from './paths';
import {
  RETRY_DELAY_MS,
  findOriginal,
  findThumbnail,
  listItemIds,
  pathExists,
  readItemFile,
  readMtimeDoc,
  readRootDoc,
} from './read';
import {
  SAVED_FILTERS_KIND,
  TAGS_KIND,
  checkedMutation,
  readSmall,
  writeRoot,
  writeSmall,
  type RootWriteDeps,
} from './rootWrite';
import { itemStamp } from './stamp';

const BATCH_CONCURRENCY = 8;
/**
 * Thumbnails replaced are kept in the journal so undo (and redo) can put them back. A picture
 * bigger than this isn't kept; a refresh of many items keeps pictures until this much per action,
 * then only records that the rest weren't kept, so undo says so instead of claiming success
 * (review5 should-fix 8, review6 must-fix 1: a refresh can replace a custom picture).
 */
const THUMB_JOURNAL_MAX_BYTES = 8 * 1024 * 1024;
const THUMB_JOURNAL_BUDGET = 64 * 1024 * 1024;
const SELF_WRITE_MS = 10_000;
const LOCATE_CACHE_MAX = 50_000;

/** What the contract's `open` takes, plus knobs for tests and diagnostics. */
export interface EagleOpenOptions {
  readOnly: boolean;
  journal: JournalSink;
  nameMaxChars: number;
  /** Wait between re-reads of a half-written JSON file (default 500 ms). */
  retryDelayMs?: number;
  /** Quiet time before mtime.json is written (default 1000 ms). */
  mtimeDelayMs?: number;
  mtimeMaxWaitMs?: number;
  /** How long the batched mtime.json write may keep failing before it is reported (default 60000). */
  mtimeReportAfterMs?: number;
  /** Failures of background work (the batched mtime.json write, the root backup copy). */
  onError?: (err: unknown) => void;
  /** Journal bytes a thumbnail refresh may spend per action (default 64 MB). */
  thumbJournalBudget?: number;
}

// ───────────────────────── small helpers ─────────────────────────

const isExdev = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'EXDEV';

/** Copy a folder tree across filesystems and check it arrived whole (same names, same sizes). */
async function copyTreeVerified(src: string, dest: string): Promise<void> {
  await cp(src, dest, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });
  const walk = async (dir: string, prefix = ''): Promise<string[]> => {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix + e.name;
      if (e.isDirectory()) out.push(rel + '/', ...(await walk(join(dir, e.name), rel + '/')));
      else out.push(`${rel}:${(await stat(join(dir, e.name))).size}`);
    }
    return out.sort();
  };
  const [a, b] = await Promise.all([walk(src), walk(dest)]);
  if (a.length !== b.length || a.some((x, i) => x !== b[i]))
    throw new Error(`Copy of ${basename(src)} did not match the original; nothing was removed.`);
}

// ───────────────────────── the library ─────────────────────────

/** The contract's EagleLibrary, with every optional member always present. */
export type EagleAdapter = EagleLibrary &
  Required<
    Pick<
      EagleLibrary,
      | 'readTagsFile'
      | 'updateTagsFile'
      | 'readSavedFilters'
      | 'updateSavedFilters'
      | 'touchItem'
      | 'recentRaises'
      | 'raisedValue'
      | 'raiseInfo'
      | 'reannounce'
      | 'writeProblem'
    >
  >;

class EagleLibraryImpl implements EagleAdapter {
  readonly root: string;
  readonly readOnly: boolean;
  private readonly journal: JournalSink;
  private readonly nameMaxChars: number;
  private readonly retryDelayMs: number;
  private readonly onError?: (err: unknown) => void;
  private readonly mtime: MtimeBatcher;
  private readonly itemLock = new KeyedLock();
  private readonly rootLock = new KeyedLock();
  private readonly selfWrites = new Map<string, number>();
  private readonly locateCache = new Map<string, string>();
  private readonly inflight = new Set<Promise<unknown>>();
  /** The root's modificationTime, keyed by the file's stat (item stamps stay above it). */
  private rootTime: { sig: string; value: number } | null = null;
  /** Journal bytes a refresh has spent on thumbnails, per action. */
  private readonly thumbBytes = new WeakMap<object, number>();
  private readonly thumbBudget: number;
  private closed = false;

  constructor(root: string, opts: EagleOpenOptions) {
    this.root = root;
    this.readOnly = opts.readOnly;
    this.journal = opts.journal;
    this.nameMaxChars = opts.nameMaxChars;
    this.retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS;
    this.onError = opts.onError;
    this.thumbBudget = opts.thumbJournalBudget ?? THUMB_JOURNAL_BUDGET;
    this.mtime = new MtimeBatcher({
      root,
      delayMs: opts.mtimeDelayMs,
      maxWaitMs: opts.mtimeMaxWaitMs,
      reportAfterMs: opts.mtimeReportAfterMs,
      onWrite: (rel) => this.noteWrite(rel),
      onError: opts.onError,
    });
  }

  // ── plumbing ──

  private assertCanWrite(): void {
    if (this.closed) throw new Error('This library is closed.');
    if (this.readOnly) throw new ReadOnlyError();
  }

  /** Track a write so close() can wait for it. */
  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    const done = () => this.inflight.delete(p);
    p.then(done, done);
    return p;
  }

  private noteWrite(rel: string): void {
    this.selfWrites.set(rel, Date.now());
  }

  /**
   * Note the paths before AND after a write: before, so a watcher that fires mid-write already
   * sees them; after, so the time is not older than the file's own modification time.
   */
  private async marked<T>(rels: string[], fn: () => Promise<T>): Promise<T> {
    for (const r of rels) this.noteWrite(r);
    try {
      return await fn();
    } finally {
      for (const r of rels) this.noteWrite(r);
    }
  }

  recentSelfWrites(): Map<string, number> {
    const cutoff = Date.now() - SELF_WRITE_MS;
    for (const [k, t] of this.selfWrites) if (t < cutoff) this.selfWrites.delete(k);
    return new Map(this.selfWrites);
  }

  itemDir(id: string): string {
    return itemDir(this.root, id);
  }

  // ── reads ──

  readRoot(): Promise<Doc<EagleRootRecord>> {
    return readRootDoc(this.root, this.retryDelayMs);
  }

  listItemIds(): Promise<string[]> {
    return listItemIds(this.root);
  }

  async readItem(id: string): Promise<Doc<EagleItemRecord> | null> {
    const r = await readItemFile(this.root, id, this.retryDelayMs);
    return r.status === 'ok' ? r.doc : null;
  }

  async readMtimeIndex(): Promise<Record<string, number>> {
    const r = await readMtimeDoc(this.root);
    return r.status === 'ok' ? r.map : {};
  }

  private async locate(
    kind: 'orig' | 'thumb',
    id: string,
    rec: EagleItemRecord,
  ): Promise<string | null> {
    if (!isItemId(id)) return null;
    const key = `${kind}:${id}:${rec.lastModified ?? 0}:${rec.name}.${rec.ext}`;
    const hit = this.locateCache.get(key);
    if (hit && (await pathExists(hit))) return hit;
    const found =
      kind === 'orig'
        ? await findOriginal(this.root, id, rec)
        : await findThumbnail(this.root, id, rec);
    if (found) {
      if (this.locateCache.size >= LOCATE_CACHE_MAX) this.locateCache.clear();
      this.locateCache.set(key, found);
    }
    return found;
  }

  locateOriginal(id: string, rec: EagleItemRecord): Promise<string | null> {
    return this.locate('orig', id, rec);
  }

  locateThumbnail(id: string, rec: EagleItemRecord): Promise<string | null> {
    return this.locate('thumb', id, rec);
  }

  // ── item writes ──

  /**
   * Fresh read for a write. Anything we can't parse is an error: we never write over it. An empty
   * file gets a couple of re-reads first, because Eagle empties a file before it fills it.
   */
  private async readForWrite(id: string): Promise<Doc<EagleItemRecord>> {
    let r = await readItemFile(this.root, id, this.retryDelayMs, true);
    for (let i = 0; i < 2 && r.status === 'blank'; i++) {
      await new Promise((res) => setTimeout(res, this.retryDelayMs));
      r = await readItemFile(this.root, id, this.retryDelayMs, true);
    }
    if (r.status === 'ok') return r.doc;
    if (r.status === 'missing') throw new ItemNotFoundError(id);
    throw new ItemUnreadableError(
      id,
      r.status === 'blank' ? 'the file is empty or zero-filled' : r.reason,
    );
  }

  /**
   * Mutate an already freshly read item and write it. `cur` was read under the item's lock, so
   * nothing else in this process can have changed it since.
   */
  private async commitItem(
    id: string,
    cur: Doc<EagleItemRecord>,
    mutate: (rec: EagleItemRecord) => boolean | void,
    ctx: ChangeContext | null, // null: a touch (see touchItem), written even with no field change
  ): Promise<ItemWrite | null> {
    const rec = cur.value; // a parse we own, so mutating it in place is safe
    const baseline = JSON.stringify(rec);
    const prev =
      typeof rec.lastModified === 'number' && Number.isFinite(rec.lastModified)
        ? Math.floor(rec.lastModified)
        : 0;
    if (!checkedMutation(mutate(rec))) return null;
    if (ctx && JSON.stringify(rec) === baseline) return null;

    // Backdated, above mtime.json's entry and the root's time, and marked (stamp.ts): the partner's
    // Eagle only re-reads an item when that value goes up, and skips one less than 500 ms behind
    // its clock.
    const lastModified = itemStamp(
      Date.now(),
      prev,
      await this.mtime.entryFor(id),
      await this.rootModified(),
    );
    rec.lastModified = lastModified; // keeps its slot if the record had one, else it lands last
    let out: EagleItemRecord = rec;
    if (Object.keys(rec)[0] !== 'id' || rec.id !== id) {
      const { id: _drop, ...rest } = rec;
      out = { id, ...rest } as EagleItemRecord; // "id" first and equal to the folder name, always
    }
    const after = serialize(out);
    const relPath = itemMetadataRel(id);
    if (ctx) this.journal.recordFile(ctx.group, { relPath, before: cur.text, after, itemId: id });
    await this.marked([relPath], () => writeFileAtomic(metadataPath(this.root, id), after));
    this.mtime.raise(id, lastModified);
    return { id, relPath, before: cur.text, after, lastModified };
  }

  async updateItem(
    id: string,
    mutate: (rec: EagleItemRecord) => boolean | void,
    ctx: ChangeContext,
  ): Promise<ItemWrite | null> {
    this.assertCanWrite();
    assertItemId(id);
    return this.track(
      this.itemLock.run(id, async () => {
        assertWritable(metadataPath(this.root, id));
        return this.commitItem(id, await this.readForWrite(id), mutate, ctx);
      }),
    );
  }

  /**
   * Rewrite an item with no field change, so a partner's Eagle that kept an old copy re-reads it
   * (eagle-proof findings 1 and 2). Its lastModified, and so its mtime.json value, go above both
   * the file's and mtime.json's current values: Eagle re-reads an item only when that value goes
   * up. The value is backdated like every item stamp, so an Eagle whose clock is behind ours
   * doesn't skip it as its own write (stamp.ts). Not journaled: no field a user could undo changed.
   *
   * `ifText`: touch only if the file still is exactly this text (what the caller last read). A file
   * that changed since (the partner's save landing) is left alone and null returned, so a touch can
   * never re-send someone else's write as ours.
   */
  async touchItem(id: string, opts: { ifText?: string } = {}): Promise<ItemWrite | null> {
    this.assertCanWrite();
    assertItemId(id);
    return this.track(
      this.itemLock.run(id, async () => {
        assertWritable(metadataPath(this.root, id));
        const cur = await this.readForWrite(id);
        if (opts.ifText !== undefined && cur.text !== opts.ifText) return null;
        return this.commitItem(id, cur, () => true, null);
      }),
    );
  }

  /** Ids whose mtime.json raise was written in the last `withinMs` (up to a minute back). */
  recentRaises(withinMs: number): string[] {
    return this.mtime.recent(withinMs);
  }

  /** The mtime.json value we wrote for `id` in the last minute (undefined if none). */
  raisedValue(id: string): number | undefined {
    return this.mtime.valueFor(id);
  }

  /** What we wrote to mtime.json for `id` in the last minute, and when (undefined if nothing). */
  raiseInfo(id: string): RaiseInfo | undefined {
    return this.mtime.infoFor(id);
  }

  /**
   * Put the item's current lastModified in mtime.json again, without touching the item: after a
   * partner's rewrite from memory put our value back or dropped the id, their poll then sees the
   * value go up (or a new id) and reads the file. Cheaper than a touch: no item write to upload.
   */
  async reannounce(id: string): Promise<number | null> {
    this.assertCanWrite();
    assertItemId(id);
    const doc = await this.readItem(id);
    const lm = doc?.value.lastModified;
    if (typeof lm !== 'number' || !Number.isFinite(lm)) return null;
    this.mtime.raise(id, lm);
    return lm;
  }

  /** The root metadata.json's modificationTime now (0 if unreadable), re-read only when it changes. */
  private async rootModified(): Promise<number> {
    const path = join(this.root, ROOT_METADATA);
    try {
      const st = await stat(path);
      const sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
      if (this.rootTime?.sig !== sig) {
        const mt = Number(JSON.parse(await readFile(path, 'utf8'))?.modificationTime);
        this.rootTime = { sig, value: Number.isFinite(mt) ? mt : 0 };
      }
      return this.rootTime.value;
    } catch {
      return this.rootTime?.value ?? 0; // mid-sync: the last good value (or none) will do
    }
  }

  /** Plain English when the batched mtime.json write has kept failing, so a partner's Eagle can't see edits. */
  writeProblem(): string | null {
    const err = this.mtime.problem();
    if (!err) return null;
    const why = err instanceof LibraryUnreadableError ? err.reason : (err as Error)?.message;
    return `Boogie can't update mtime.json in this library (${why ?? 'unknown error'}), so Eagle on another computer won't see your edits until it can.`;
  }

  /**
   * Many items, 8 at a time. Items that are missing or unreadable are skipped (`onSkip` says why);
   * anything else (read-only, write blocked, disk error) stops the batch and throws. Writes done
   * before that stay written and journaled, so they come with the error as a PartialWriteError.
   * Results come back in input order.
   */
  async updateItems(
    ids: string[],
    mutate: (rec: EagleItemRecord) => boolean | void,
    ctx: ChangeContext,
    onSkip?: (id: string, reason: string) => void,
  ): Promise<ItemWrite[]> {
    this.assertCanWrite();
    const unique = [...new Set(ids)];
    const results = new Map<string, ItemWrite>();
    let fatal: unknown;
    let failed = false;
    let next = 0;
    const worker = async () => {
      while (!failed) {
        const id = unique[next++];
        if (id === undefined) return;
        if (!isItemId(id)) {
          onSkip?.(id, 'not a valid item id');
          continue;
        }
        try {
          const w = await this.updateItem(id, mutate, ctx);
          if (w) results.set(id, w);
        } catch (err) {
          if (isSkippableItemError(err)) onSkip?.(id, err.message);
          else {
            failed = true;
            fatal = err;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, unique.length) }, worker));
    const writes = unique.flatMap((id) => results.get(id) ?? []);
    if (failed) throw writes.length ? new PartialWriteError(writes, fatal) : fatal;
    return writes;
  }

  async renameItem(id: string, newName: string, ctx: ChangeContext): Promise<ItemWrite | null> {
    this.assertCanWrite();
    assertItemId(id);
    return this.track(this.itemLock.run(id, () => this.renameLocked(id, newName, ctx)));
  }

  private async renameLocked(
    id: string,
    newName: string,
    ctx: ChangeContext,
  ): Promise<ItemWrite | null> {
    assertWritable(metadataPath(this.root, id));
    const cur = await this.readForWrite(id);
    const rec = cur.value;
    const name = sanitizeItemName(newName, this.nameMaxChars);
    if (name === rec.name) return null;

    const dir = itemDir(this.root, id);
    const ext = String(rec.ext ?? '');
    const [oldOriginal, oldThumb] = await Promise.all([
      findOriginal(this.root, id, rec),
      findThumbnail(this.root, id, rec),
    ]);
    const moves: [string, string][] = [];
    // A lone file the fallback search picked with some other extension is not ours to rename.
    if (oldOriginal && extname(oldOriginal).slice(1).toLowerCase() === ext.toLowerCase())
      moves.push([oldOriginal, childPath(dir, `${name}.${ext}`)]);
    if (oldThumb) moves.push([oldThumb, childPath(dir, `${name}_thumbnail.png`)]);

    const touched = moves.flatMap(([f, t]) => [
      relFromRoot(this.root, f),
      relFromRoot(this.root, t),
    ]);
    return this.marked(touched, async () => {
      const done: [string, string][] = [];
      try {
        for (const [from, to] of moves) {
          if (from === to) continue; // already has the right name (e.g. an NFD record name over an NFC file)
          if (await pathExists(to))
            throw new Error(
              `Can't rename: "${basename(to)}" already exists in this item's folder.`,
            );
          await renameGuarded(from, to);
          done.push([from, to]);
        }
        return await this.commitItem(
          id,
          cur,
          (r) => {
            r.name = name;
          },
          ctx,
        );
      } catch (err) {
        for (const [from, to] of done.reverse()) await renameGuarded(to, from).catch(() => {});
        throw err;
      }
    });
  }

  async createItem(
    init: NewItemInit,
    ctx: ChangeContext,
  ): Promise<{ id: string; record: EagleItemRecord }> {
    this.assertCanWrite();
    return this.track(this.createLocked(init, ctx));
  }

  private async createLocked(
    init: NewItemInit,
    ctx: ChangeContext,
  ): Promise<{ id: string; record: EagleItemRecord }> {
    const ext = String(init.ext ?? '')
      .toLowerCase()
      .replace(/^\./, '');
    if (!/^[a-z0-9]{1,16}$/.test(ext))
      throw new Error(`Not a usable file extension: ${JSON.stringify(init.ext)}`);
    const name = sanitizeItemName(init.name, this.nameMaxChars);
    if (init.moveSource && isInsideLibraryFolder(init.sourcePath))
      throw new Error(
        "moveSource is only for Boogie's own temp files, never for a file inside a library.",
      );

    await mkdirGuarded(imagesDir(this.root), { recursive: true }); // Eagle recreates images/ if it is missing
    let id = '';
    let dir = '';
    for (let attempt = 0; ; attempt++) {
      id = guid();
      dir = itemDir(this.root, id);
      try {
        await mkdirGuarded(dir); // fails if it exists, which doubles as the "id is free" check
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 10) throw err;
      }
    }

    const original = childPath(dir, `${name}.${ext}`);
    const thumb = childPath(dir, `${name}_thumbnail.png`);
    const rels = [`images/${id}.info`, itemMetadataRel(id), relFromRoot(this.root, original)];
    const withThumb = !!init.thumbnailBytes && !init.noThumbnail;
    if (withThumb) rels.push(relFromRoot(this.root, thumb));
    const record = await this.marked(rels, async () => {
      const created: string[] = [];
      let movedIn = false;
      try {
        if (init.moveSource) {
          await this.moveFileIn(init.sourcePath, original);
          movedIn = true;
        } else {
          await copyFileGuarded(init.sourcePath, original);
          created.push(original);
        }
        await setTimesGuarded(original, init.mtime); // Dropbox keeps whole seconds; Windows Eagle compares them
        if (withThumb) {
          await writeFileAtomic(thumb, init.thumbnailBytes!);
          created.push(thumb);
        }
        const rec = buildItemRecord(id, name, ext, init);
        rec.lastModified = itemStamp(Date.now(), 0, 0, await this.rootModified()); // keeps its slot
        const text = serialize(rec);
        // metadata.json goes in LAST: its presence is what makes the folder an item.
        this.journal.recordFile(ctx.group, {
          relPath: itemMetadataRel(id),
          before: null,
          after: text,
          itemId: id,
        });
        await writeFileAtomic(metadataPath(this.root, id), text);
        return rec;
      } catch (err) {
        // A moved-in file may be the only copy of a download or a paste: it goes back, never away.
        // If even that fails it stays in the (then non-empty, so kept) item folder, and we say where.
        const keptAt = movedIn
          ? await this.moveFileBack(original, init.sourcePath).then(
              () => null,
              () => original,
            )
          : null;
        await removeCreatedFolder(dir, created);
        if (keptAt)
          throw new Error(`${(err as Error).message} (the file was kept at ${keptAt})`, {
            cause: err,
          });
        throw err;
      }
    });
    this.mtime.raise(id, record.lastModified as number, { created: true });
    return { id, record };
  }

  /** Move one of OUR temp files into a new item folder (rename, or copy + delete across filesystems). */
  private async moveFileIn(src: string, dest: string): Promise<void> {
    assertWritable(dest);
    try {
      await rename(src, dest);
    } catch (err) {
      if (!isExdev(err)) throw err;
      await copyFile(src, dest, constants.COPYFILE_EXCL);
      await unlink(src);
    }
  }

  /** Undo moveFileIn: the file goes back to where it came from (never over something there now). */
  private async moveFileBack(inLibrary: string, original: string): Promise<void> {
    assertWritable(inLibrary);
    if (await pathExists(original)) throw new Error(`${original} exists again; not replacing it.`);
    try {
      await rename(inLibrary, original);
    } catch (err) {
      if (!isExdev(err)) throw err;
      await copyFile(inLibrary, original, constants.COPYFILE_EXCL);
      await unlinkGuarded(inLibrary);
    }
  }

  /**
   * The name comes from a fresh read: a caller's record may predate a rename (ours or the partner's).
   * The picture it replaces is journaled (base64, under thumbnailJournalRel) so undo can put it
   * back: always with `keepOld` (a custom thumbnail, an undo or redo), within a per-action budget
   * otherwise (a refresh). One that isn't kept is still recorded, as not kept.
   */
  async writeThumbnail(
    id: string,
    _rec: EagleItemRecord,
    bytes: Uint8Array,
    ctx: ChangeContext,
    opts: { keepOld?: boolean } = {},
  ): Promise<void> {
    this.assertCanWrite();
    assertItemId(id);
    await this.track(
      this.itemLock.run(id, async () => {
        const rec = (await this.readForWrite(id)).value;
        const path = childPath(itemDir(this.root, id), `${rec.name}_thumbnail.png`);
        const oldPath = await findThumbnail(this.root, id, rec);
        const read = oldPath ? await readFile(oldPath).catch(() => null) : null;
        const spent = this.thumbBytes.get(ctx.group) ?? 0;
        const cost = (read?.length ?? 0) + bytes.length;
        const keep =
          (!read || read.length <= THUMB_JOURNAL_MAX_BYTES) &&
          (opts.keepOld || spent + cost <= this.thumbBudget);
        if (keep && !opts.keepOld) this.thumbBytes.set(ctx.group, spent + cost);
        // Not kept: before null and an empty after, which undo reports as "wasn't kept".
        this.journal.recordFile(ctx.group, {
          relPath: thumbnailJournalRel(id),
          before: keep && read ? read.toString('base64') : null,
          after: keep ? Buffer.from(bytes).toString('base64') : '',
          itemId: id,
        });
        await this.marked([relFromRoot(this.root, path)], () => writeFileAtomic(path, bytes));
      }),
    );
  }

  async moveItemOut(id: string, destDir: string, ctx: ChangeContext): Promise<void> {
    this.assertCanWrite();
    assertItemId(id);
    return this.track(this.itemLock.run(id, () => this.moveOutLocked(id, destDir, ctx)));
  }

  private async moveOutLocked(id: string, destDir: string, ctx: ChangeContext): Promise<void> {
    const src = itemDir(this.root, id);
    assertWritable(src);
    if (!(await pathExists(src))) throw new ItemNotFoundError(id);
    const parent = resolve(destDir);
    const dest = join(parent, `${id}.info`);
    // The store is Boogie's own folder outside any library. Never let it point into one.
    if (isInsideLibraryFolder(dest))
      throw new Error("The journal store can't be inside a library.");
    if (await pathExists(dest)) throw new Error(`Item ${id} is already in the store folder.`);
    await mkdir(parent, { recursive: true });
    this.journal.recordMoveOut(ctx.group, { itemId: id, storedAt: dest });
    this.noteWrite(`images/${id}.info`);
    try {
      await rename(src, dest);
    } catch (err) {
      if (!isExdev(err)) throw err;
      try {
        await copyTreeVerified(src, dest);
      } catch (copyErr) {
        await rm(dest, { recursive: true, force: true }).catch(() => {}); // our own partial copy in our own store
        throw copyErr;
      }
      // Verified. Remove exactly this one item folder from the library, and nothing else.
      if (basename(src) !== `${id}.info` || dirname(src) !== imagesDir(this.root))
        throw new Error('Refusing to remove an unexpected folder.');
      assertWritable(src);
      await rm(src, { recursive: true });
    }
    this.noteWrite(`images/${id}.info`);
    this.mtime.adjustCount(-1); // Eagle drops the dead id from mtime.json itself
  }

  async moveItemIn(id: string, fromDir: string, ctx: ChangeContext): Promise<void> {
    this.assertCanWrite();
    assertItemId(id);
    return this.track(this.itemLock.run(id, () => this.moveInLocked(id, fromDir, ctx)));
  }

  private async moveInLocked(id: string, fromDir: string, ctx: ChangeContext): Promise<void> {
    // Accept either the folder that holds `<id>.info` or the `<id>.info` folder itself.
    const given = resolve(fromDir);
    const src = basename(given) === `${id}.info` ? given : join(given, `${id}.info`);
    if (!(await pathExists(src))) throw new ItemNotFoundError(id);
    const dest = itemDir(this.root, id);
    assertWritable(dest);
    if (await pathExists(dest)) throw new Error(`Item ${id} already exists in this library.`);
    await mkdirGuarded(imagesDir(this.root), { recursive: true });

    // Back with a fresh stamp of ours (above its old value), so Eagle and another Boogie see a
    // Boogie write rather than an old one of the partner's (review5 should-fix 7).
    let text: string | null = null;
    let restamped: string | null = null;
    let lastModified = Date.now();
    try {
      text = await readFile(join(src, 'metadata.json'), 'utf8');
      const rec = JSON.parse(text) as EagleItemRecord;
      const old = typeof rec.lastModified === 'number' ? Math.floor(rec.lastModified) : 0;
      lastModified = itemStamp(
        Date.now(),
        old,
        await this.mtime.entryFor(id),
        await this.rootModified(),
      );
      rec.lastModified = lastModified; // keeps its slot
      restamped = serialize(rec);
    } catch {
      /* moved back as it is; raise with "now" */
    }
    if (text !== null)
      this.journal.recordFile(ctx.group, {
        relPath: itemMetadataRel(id),
        before: null,
        after: restamped ?? text,
        itemId: id,
      });
    this.noteWrite(`images/${id}.info`);
    this.noteWrite(itemMetadataRel(id));
    try {
      await rename(src, dest); // dest was checked above; src is the journal store, outside every library
    } catch (err) {
      if (!isExdev(err)) throw err;
      await copyTreeVerified(src, dest);
      await rm(src, { recursive: true }); // our own store copy, after the library copy is verified
    }
    if (restamped !== null) await writeFileAtomic(metadataPath(this.root, id), restamped);
    this.noteWrite(`images/${id}.info`);
    this.noteWrite(itemMetadataRel(id));
    this.mtime.raise(id, lastModified, { created: true });
  }

  // ── root metadata.json, tags.json, saved-filters.json (rootWrite.ts) ──

  private rootDeps(): RootWriteDeps {
    return {
      root: this.root,
      journal: this.journal,
      retryDelayMs: this.retryDelayMs,
      marked: (rels, fn) => this.marked(rels, fn),
      onError: this.onError,
    };
  }

  async updateRoot(
    mutate: (root: EagleRootRecord) => boolean | void,
    ctx: ChangeContext,
  ): Promise<{ before: string; after: string } | null> {
    this.assertCanWrite();
    return this.track(this.rootLock.run('root', () => writeRoot(this.rootDeps(), mutate, ctx)));
  }

  readTagsFile(): Promise<Doc<EagleTagsFile> | null> {
    return readSmall(this.rootDeps(), TAGS_KIND);
  }

  async updateTagsFile(
    mutate: (file: EagleTagsFile) => boolean | void,
    ctx: ChangeContext,
  ): Promise<{ before: string | null; after: string } | null> {
    this.assertCanWrite();
    return this.track(
      this.rootLock.run('tags', () => writeSmall(this.rootDeps(), TAGS_KIND, mutate, ctx)),
    );
  }

  readSavedFilters(): Promise<Doc<EagleSavedFilter[]> | null> {
    return readSmall(this.rootDeps(), SAVED_FILTERS_KIND);
  }

  async updateSavedFilters(
    mutate: (list: EagleSavedFilter[]) => boolean | void,
    ctx: ChangeContext,
  ): Promise<{ before: string | null; after: string } | null> {
    this.assertCanWrite();
    return this.track(
      this.rootLock.run('saved-filters', () =>
        writeSmall(this.rootDeps(), SAVED_FILTERS_KIND, mutate, ctx),
      ),
    );
  }

  // ── mtime.json and lifecycle ──

  flushMtime(): Promise<void> {
    return this.mtime.flush();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; // no new writes from here on
    await Promise.allSettled([...this.inflight]);
    await this.mtime.close();
  }
}

// ───────────────────────── factory ─────────────────────────

/** `eagleLibraries.open` with the extra knobs (retry delay, mtime timing, error callback) typed. */
export async function openLibrary(root: string, opts: EagleOpenOptions): Promise<EagleAdapter> {
  const path = resolve(root);
  if (!(await pathExists(join(path, ROOT_METADATA))))
    throw new LibraryUnreadableError(join(path, ROOT_METADATA), 'metadata.json is missing');
  return new EagleLibraryImpl(path, opts);
}

export const eagleLibraries: EagleLibraryFactory = {
  open: openLibrary,
  create: createLibrary,
  probe: probeLibrary,
};
