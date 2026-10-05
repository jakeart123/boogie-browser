// The one path every mutation takes: check writable -> open a journal group -> let the
// operation write through the adapter -> keep the index in step -> commit -> tell the UI.
import { join } from 'node:path';
import type {
  Actor,
  Counts,
  EagleItemRecord,
  EagleRootRecord,
  HistoryEntry,
  MutationResult,
} from '../../shared/types';
import type { ChangeContext, ItemWrite } from '../contracts';
import { PartialWriteError } from '../eagle';
import { notFound, skip } from './skips';
import { buildLibraryState } from './state';
import type { Session, Touch } from './types';
import { chunks, Mutex, yieldToLoop } from './util';

/** Big batches are written in slices of this many, yielding to the event loop between them. */
export const CHUNK = 200;

/** Who Boogie's own safety writes are logged as (putting back a stale overwrite; see partner.ts). */
export const BOOGIE: Actor = { kind: 'system', name: 'Boogie' };

const noPause = () => yieldToLoop();

export function newTouch(pause: () => Promise<void> = noPause): Touch {
  return {
    changed: new Set(),
    added: new Set(),
    removed: new Set(),
    root: false,
    skipped: [],
    pause,
  };
}

export function ensureWritable(s: Session): void {
  if (s.closed) throw new Error('That library was closed.');
  if (s.readOnly) throw new Error(s.readOnlyReason ?? 'This library is read-only.');
}

/** Folder and tag-group edits can't reach a running Eagle in a shared library (research/live-behavior). */
export function sharedWarning(s: Session): string | undefined {
  if (!s.shared) return undefined;
  const who = s.partnerName ? `${s.partnerName}'s` : "your partner's";
  return `Eagle on ${who} computer won't pick this up until it restarts, and may undo it.`;
}

export function currentCounts(s: Session): Counts {
  return { ...s.index.counts(), smartFolders: s.query.smartFolderCounts() };
}

function announce(s: Session, t: Touch, entry: HistoryEntry | null): void {
  const { emit } = s.env;
  if (t.changed.size) emit('itemsChanged', { ids: [...t.changed], source: 'self' });
  if (t.added.size) emit('itemsAdded', { ids: [...t.added], source: 'self' });
  if (t.removed.size) emit('itemsRemoved', { ids: [...t.removed], source: 'self' });
  if (t.root) emit('library', buildLibraryState(s));
  if ((t.changed.size || t.added.size || t.removed.size || t.root) && s.env.hasListener('counts')) {
    emit('counts', currentCounts(s));
  }
  if (entry) emit('history', entry);
}

/**
 * Run one user-visible action as a single history group. A failure half way still commits what
 * was written (so it can be undone) and then rethrows.
 * `lock: false` is for jobs that take the lock per write themselves (or not at all, like imports),
 * and for callers that already hold it (undo). Inside a locked group, `t.pause()` between chunks
 * lets queued edits and outside changes through, so a huge edit never freezes everything else.
 */
export async function runGroup(
  s: Session,
  actor: Actor,
  label: string,
  kind: HistoryEntry['kind'],
  fn: (ctx: ChangeContext, t: Touch) => Promise<void>,
  opts: { lock?: boolean } = {},
): Promise<{ entry: HistoryEntry | null; t: Touch }> {
  ensureWritable(s);
  const body = async (pause?: () => Promise<void>) => {
    ensureWritable(s);
    const group = s.journal.begin(s.ref.id, actor, label, kind);
    const t = newTouch(pause);
    let failed = false;
    let failure: unknown;
    try {
      await fn({ actor, group }, t);
    } catch (e) {
      failed = true;
      failure = e;
    }
    if (t.label) group.label = t.label;
    let entry: HistoryEntry | null = null;
    try {
      entry = s.journal.commit(group, { itemIds: [...t.changed, ...t.added, ...t.removed] });
    } catch (e) {
      if (!failed) {
        failed = true;
        failure = e;
      }
    }
    if (s.syncPromise) for (const id of [...t.changed, ...t.added]) s.dirtyDuringSync.add(id);
    // Shared library: the partner's Eagle may not show these yet (partner.ts).
    try {
      if (entry) s.partner?.afterGroup(entry.groupId, t.changed);
    } catch (e) {
      console.error("[boogie] could not note changes for the partner's Eagle", e);
    }
    announce(s, t, entry);
    if (failed) throw failure;
    return { entry, t };
  };
  return opts.lock === false ? body() : inOrder(s, actor, () => s.lock.run(body));
}

/**
 * One actor's actions run strictly in the order they were asked for, even when a long one steps
 * aside for others (another actor's edit, an outside change). So "your newest action" in History is
 * always the one you did last, and Ctrl+Z after a big edit plus a small one undoes the small one.
 */
export function inOrder<T>(s: Session, actor: Actor, fn: () => Promise<T>): Promise<T> {
  const key = `${actor.kind}:${actor.name}`;
  let queue = s.actorQueues.get(key);
  if (!queue) s.actorQueues.set(key, (queue = new Mutex()));
  return queue.run(fn);
}

/** The adapter's skip reasons name the id, which the skipped list already carries. */
const adapterSkip = (id: string, reason: string) =>
  /not found/i.test(reason)
    ? notFound(id)
    : skip(id, "It couldn't be read (it may still be syncing), so it was left alone.");

export function toResult(entry: HistoryEntry | null, t: Touch): MutationResult {
  const items = t.changed.size + t.added.size + t.removed.size;
  const result: MutationResult = {
    groupId: entry?.groupId ?? null,
    changed: t.count ?? items + (t.root ? 1 : 0), // items written, plus the root record if it was
    skipped: t.skipped,
  };
  if (t.warning) result.warning = t.warning;
  return result;
}

/** Give the index the records the adapter just wrote (parsed from the new file text). */
export function applyWrites(s: Session, t: Touch, writes: readonly (ItemWrite | null)[]): number {
  const records: EagleItemRecord[] = [];
  for (const w of writes) {
    if (!w || w.after === null) continue;
    try {
      records.push(JSON.parse(w.after) as EagleItemRecord);
      t.changed.add(w.id);
    } catch {
      /* the adapter wrote it, so it parses; if not, the next refresh will sort it out */
    }
  }
  if (records.length) s.index.upsertRecords(records);
  return records.length;
}

/**
 * The same edit on many items, in slices, pausing between them. Returns how many were written.
 * If the adapter fails part way, what did land still reaches the index (and so the history group).
 */
export async function editItems(
  s: Session,
  ctx: ChangeContext,
  t: Touch,
  ids: readonly string[],
  mutate: (rec: EagleItemRecord) => boolean | void,
): Promise<number> {
  let written = 0;
  for (const part of chunks(ids, CHUNK)) {
    // Eagle may have opened the library here while we stepped aside: stop, keep what landed.
    ensureWritable(s);
    let writes: ItemWrite[];
    try {
      writes = await s.lib.updateItems(part, mutate, ctx, (id, reason) =>
        t.skipped.push(adapterSkip(id, reason)),
      );
    } catch (e) {
      // A disk error part way: what landed is on disk and journaled, so the index and History get it too.
      if (e instanceof PartialWriteError) applyWrites(s, t, e.writes);
      throw e;
    }
    written += applyWrites(s, t, writes);
    await t.pause();
  }
  return written;
}

/**
 * How long a write to a shared library's root files waits for Dropbox (docs/specs/merge.md
 * section 4), and how long it stops waiting after a wait ran out.
 */
export const SETTLE = { maxMs: 20_000, pollMs: 500, restMs: 5 * 60_000 };

/** When a wait last ran out, per open library. */
const gaveUp = new WeakMap<Session, number>();

/**
 * Before writing the root metadata.json or tags.json of a shared library (the files everyone
 * edits): if Dropbox says that file is still syncing, wait for it (up to 20 s), so the write isn't
 * made over a version that is about to be replaced, then write anyway. No Dropbox client, a
 * library that isn't shared, or any answer but "syncing" never waits.
 *
 * Two cases never wait, because the wait runs inside the edit (the person is watching it):
 * - we wrote this file ourselves a moment ago, so what Dropbox is busy with is our own upload
 *   (the second of two quick folder edits would otherwise always wait for the first);
 * - a wait ran out a little while ago: Dropbox isn't getting anywhere (no network, say), and
 *   every further folder edit would stand still for the full 20 s.
 */
export async function settleSharedFile(s: Session, relPath: string): Promise<void> {
  const dropbox = s.env.deps.dropbox;
  if (!s.shared || !dropbox.fileStatus) return;
  if (s.lib.recentSelfWrites().has(relPath)) return;
  if (Date.now() - (gaveUp.get(s) ?? -Infinity) < SETTLE.restMs) return;
  const file = join(s.lib.root, relPath);
  const deadline = Date.now() + SETTLE.maxMs;
  for (;;) {
    const state = await dropbox.fileStatus([file]).then(
      (found) => found[file],
      () => 'unknown',
    );
    if (state !== 'syncing' || s.closed) return;
    if (Date.now() + SETTLE.pollMs > deadline) {
      gaveUp.set(s, Date.now());
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE.pollMs));
  }
}

/** One root write. Keeps the index and our copy of the root in step. Returns false if nothing changed. */
export async function writeRoot(
  s: Session,
  ctx: ChangeContext,
  t: Touch,
  mutate: (root: EagleRootRecord) => boolean | void,
): Promise<boolean> {
  await settleSharedFile(s, 'metadata.json');
  const done = await s.lib.updateRoot(mutate, ctx);
  if (!done) return false;
  s.root = JSON.parse(done.after) as EagleRootRecord;
  s.index.setRoot(s.root);
  s.partner?.noteRoot(s.root.modificationTime); // another Boogie's items may build on it (+1)
  t.root = true;
  return true;
}

const ITEM_ID = /^(?:[0-9A-Za-z]{13}|[0-9A-Za-z-]{36})$/;
/** Item ids become folder names (images/<id>.info), so anything else is refused. */
export function isItemId(id: string): boolean {
  return ITEM_ID.test(id);
}
