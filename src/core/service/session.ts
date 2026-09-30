// One open library: everything wired together (adapter, index, query, journal, watcher, importer)
// plus how it opens, decides whether it may be edited, syncs its index, and closes.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileUrl, previewUrl, thumbUrl } from '../../shared/api';
import type { EagleItemRecord, LibraryRef } from '../../shared/types';
import type { EagleLibrary, LibraryIndex, ScanProgress, UrlBuilder } from '../contracts';
import { childPath } from '../eagle';
import { pathExists } from '../libraries/fsutil';
import { libraryRef } from '../libraryId';
import { whyNotWritable } from '../safety/writeGuard';
import {
  applyDelta,
  handleForeignMtime,
  handleItemsHint,
  handleRootHint,
  startVerify,
} from './external';
import { hugeImageLookup } from './files';
import { currentCounts } from './group';
import { quoted } from './labels';
import { Partner } from './partner';
import { buildLibraryState, loadLibraryFiles } from './state';
import type { Env, OpenSource, ReadOnlyKind, Session } from './types';
import { Mutex, throttle } from './util';

const REASONS = {
  // Each reason reads well on its own (the banner) and after the UI's "Read-only: " (tooltips).
  user: 'You opened it for viewing only.',
  guard: 'Editing is off for this library. Allow it in Settings.',
  // Allowed in Settings, but it sits in Dropbox or on a drive: that has its own switch in Settings.
  protected:
    'Editing is off for libraries in Dropbox and on external drives. Allow it in Settings.',
  eagle: 'Eagle is open on this library on this computer. Close Eagle to edit here.',
} as const;

export function versionReason(version: string | null): string {
  return version
    ? `This library was saved by a newer Eagle (${version}), so Boogie won't change it.`
    : "This library has no Eagle version recorded, so Boogie won't change it.";
}

/** First matching reason wins (spec order): asked for, settings, Eagle open here, version. */
export async function decideReadOnly(
  env: Env,
  ref: LibraryRef,
  opts: { userReadOnly: boolean; versionReason: string | null },
): Promise<{ kind: ReadOnlyKind | null; reason: string | null }> {
  if (opts.userReadOnly) return { kind: 'user', reason: REASONS.user };
  const blocked = whyNotWritable(ref.path);
  if (blocked)
    return blocked.startsWith('protected')
      ? { kind: 'protected', reason: REASONS.protected }
      : { kind: 'guard', reason: REASONS.guard };
  const eagle = await env.deps.eagleMonitor.check().catch(() => null);
  if (
    eagle?.running &&
    eagle.openLibraryPath &&
    libraryRef(eagle.openLibraryPath).path === ref.path
  ) {
    return { kind: 'eagle', reason: REASONS.eagle };
  }
  if (opts.versionReason) return { kind: 'version', reason: opts.versionReason };
  return { kind: null, reason: null };
}

/** The index lives under our own cache folder (paths.cache), so a test or a second profile never shares one. */
export function openIndex(env: Env, ref: LibraryRef): LibraryIndex {
  return env.deps.indexes.open(ref, { dir: join(env.paths.cache, 'index') });
}

export function makeUrls(env: Env, libraryId: string, index?: LibraryIndex): UrlBuilder {
  const huge = index ? hugeImageLookup(index) : () => false;
  return {
    thumb: (id, v) => thumbUrl(libraryId, id, v),
    file: (id, v) => fileUrl(libraryId, id, v),
    // Formats a browser can show as they are are served from the original, unless the picture
    // is too big for the browser (service/files isHugeImage): that gets a smaller rendition.
    preview: (id, ext, v) =>
      env.media().isBrowserViewable(ext) && !huge(id)
        ? fileUrl(libraryId, id, v)
        : previewUrl(libraryId, id, v),
  };
}

/**
 * Where an item's original should be: `<name>.<ext>` inside its folder. The record comes from the
 * library (a partner's, a downloaded one), so a name or ext that would leave the folder
 * (`jpg/../../x`) gives the folder itself instead.
 */
export function filePathOf(dir: string, rec: Pick<EagleItemRecord, 'name' | 'ext'> | null): string {
  if (!rec) return dir;
  try {
    return childPath(dir, `${rec.name}.${rec.ext}`);
  } catch {
    return dir;
  }
}

export async function openSession(
  env: Env,
  path: string,
  opts: { readOnly?: boolean },
  meta: { shared: boolean; partnerName: string | null },
): Promise<Session> {
  const { deps } = env;
  const ref = libraryRef(path);
  if (!(await pathExists(join(ref.path, 'metadata.json')))) {
    throw new Error(
      `${quoted(ref.name)} doesn't look like an Eagle library (there is no metadata.json in it).`,
    );
  }
  const probe = await deps.eagle.probe(ref.path);
  const version = probe.ok ? null : versionReason(probe.applicationVersion);
  const userReadOnly = !!opts.readOnly;
  const decision = await decideReadOnly(env, ref, { userReadOnly, versionReason: version });
  const nameMaxChars = env.settings().windowsNameMaxChars;

  const journal = deps.createJournal({ dir: join(env.paths.data, 'journal') });
  let lib: EagleLibrary | undefined;
  let index: LibraryIndex | undefined;
  try {
    const openedLib = (lib = await deps.eagle.open(ref.path, {
      readOnly: decision.reason !== null,
      journal,
      nameMaxChars,
    }));
    const root = (await openedLib.readRoot()).value;
    const openedIndex = (index = openIndex(env, ref));
    const urls = makeUrls(env, ref.id, openedIndex);
    const query = deps.queries.create(openedIndex, urls, (id) =>
      filePathOf(openedLib.itemDir(id), openedIndex.getRecord(id)),
    );
    await mkdir(env.paths.tmp, { recursive: true });
    const importer = deps.importers.create({
      lib: openedLib,
      index: openedIndex,
      media: env.media(),
      tmpDir: env.paths.tmp,
      nameMaxChars,
    });
    const counts = openedIndex.counts();
    const session: Session = {
      env,
      ref,
      lib: openedLib,
      index: openedIndex,
      query,
      journal,
      importer,
      watcher: deps.createWatcher(),
      urls,
      root,
      readOnly: decision.reason !== null,
      readOnlyReason: decision.reason,
      readOnlyKind: decision.kind,
      adapterReadOnly: decision.reason !== null,
      userReadOnly,
      versionReason: version,
      shared: meta.shared,
      partnerName: meta.partnerName,
      // A cached index is usable at once; only a fresh one shows "indexing".
      indexing: counts.all + counts.trash === 0 ? { done: 0, total: 0 } : null,
      syncPromise: null,
      needsResync: false,
      dirtyDuringSync: new Set(),
      conflicts: [],
      itemConflicts: new Map(),
      lock: new Mutex(),
      actorQueues: new Map(),
      abort: new AbortController(),
      verifying: null,
      dupeSources: [],
      closed: false,
    };
    session.partner = new Partner(session, {
      refreshAndLog: async (ids) => {
        const delta = await openedIndex.refresh(openedLib, { ids });
        await applyDelta(session, delta, { journal: !delta.firstScan, quiet: !!delta.firstScan });
      },
      readAgain: (ids) => handleItemsHint(session, { ids, listDir: false }),
    });
    return session;
  } catch (e) {
    await lib?.close().catch(() => undefined);
    index?.close();
    journal.close();
    // A root file we can't read at all (Dropbox mid-sync, a damaged copy) can't be shown, even read-only:
    // say that in plain English instead of the adapter's technical message.
    if (!probe.ok && probe.applicationVersion === null && probe.reason)
      throw new Error(probe.reason);
    throw e;
  }
}

/** Start watching, the first index sync, then the slow verify pass (all in the background). */
export function startSession(s: Session): void {
  const report = (what: string) => (e: unknown) => {
    if (!s.closed) console.error(`[boogie] ${what} failed`, e);
  };
  s.watcher.start(s.lib, {
    items: (hint) => void handleItemsHint(s, hint).catch(report('reading an outside change')),
    root: () => void handleRootHint(s).catch(report('reading an outside folder change')),
    conflicts: (files) => {
      s.conflicts = files;
      s.env.statusChanged();
    },
    rootFiles: (which) =>
      void loadLibraryFiles(s, which).catch(report('reading tags.json or saved-filters.json')),
    // The partner's Eagle is running (service/partner): its rewrite may have undone our raises.
    foreignMtime: (info) => handleForeignMtime(s, info),
  });
  void loadLibraryFiles(s).catch(report('reading tags.json or saved-filters.json'));
  void startSync(s).then(() => {
    if (!s.closed) void startVerify(s);
  });
}

// ───────────────────────── index sync ─────────────────────────

/** Sync the index with the files on disk now (or join the sync already running). */
export function startSync(s: Session): Promise<void> {
  if (s.syncPromise) return s.syncPromise;
  const run = async () => {
    try {
      do {
        s.needsResync = false;
        await syncPass(s);
      } while (s.needsResync && !s.closed);
    } catch (e) {
      s.indexing = null;
      if (!s.closed) {
        console.error('[boogie] index sync failed', e);
        s.env.emit('library', buildLibraryState(s));
      }
    }
  };
  const p = run();
  s.syncPromise = p;
  void p.then(() => {
    if (s.syncPromise === p) s.syncPromise = null;
  });
  return p;
}

async function syncPass(s: Session): Promise<void> {
  // Only for showing "indexing": whether this is a first scan is the index's call (delta.firstScan).
  const before = s.index.counts();
  const fresh = before.all + before.trash === 0;
  s.dirtyDuringSync.clear();
  let shown = fresh; // did the UI see an "indexing" state that we now have to clear?
  if (fresh) s.indexing = { done: 0, total: 0 };

  const sendState = throttle(() => s.env.emit('library', buildLibraryState(s)), 250);
  // The sidebar's All count, the item count and the library size climb with the grid.
  const sendCounts = throttle(() => {
    if (!s.closed && s.env.hasListener('counts')) s.env.emit('counts', currentCounts(s));
  }, 1000);
  const onProgress = (p: ScanProgress) => {
    if (s.closed || !(fresh || p.total >= 500)) return;
    s.indexing = { done: p.done, total: p.total };
    shown = true;
    sendState();
    sendCounts();
  };
  const rootBefore = s.index.getRoot(); // outside folder changes while we were closed get logged
  const delta = await s.index.sync(s.lib, onProgress, s.abort.signal);
  sendState.cancel();
  sendCounts.cancel();
  if (s.closed) return;
  s.indexing = null;

  await s.lock.run(async () => {
    if (s.closed) return;
    // Anything we wrote while the scan ran may have been read from an older copy: read it again.
    if (s.dirtyDuringSync.size) {
      await s.index.refresh(s.lib, { ids: [...s.dirtyDuringSync] });
      s.dirtyDuringSync.clear();
    }
    // A first scan (even one resumed after a quit) is the library as it is, not outside changes.
    await applyDelta(s, delta, {
      journal: !delta.firstScan,
      quiet: !!delta.firstScan,
      rootBefore,
    });
    if (shown && !delta.rootChanged) s.env.emit('library', buildLibraryState(s));
  });
}

// ───────────────────────── close ─────────────────────────

export function closeDupeSources(s: Session): void {
  for (const src of s.dupeSources.splice(0)) closeSource(src);
}

export function closeSource(src: OpenSource): void {
  void src.lib.close().catch(() => undefined);
  src.index.close();
}

/**
 * Never throws: whatever fails (a mtime.json that won't parse, say), the index and journal are
 * released, so the library can always be closed, switched away from, or quit. For a shared
 * library, items whose raise couldn't be written stay partner-pending and are touched again when
 * the partner's Eagle is next seen running.
 */
export async function closeSession(s: Session): Promise<void> {
  if (s.closed) return;
  s.closed = true;
  const step = async (what: string, fn: () => unknown) => {
    try {
      await fn();
    } catch (e) {
      console.error(`[boogie] ${what} failed while closing the library`, e);
    }
  };
  await step('stopping the watcher', () => s.watcher.stop());
  s.partner?.stop();
  s.abort.abort();
  await step('stopping jobs', () => s.env.jobs.cancelScope(s.ref.id));
  await step('the index sync', () => s.syncPromise);
  await step('the check pass', () => s.verifying?.done);
  await step('waiting for edits', () => s.lock.idle());
  await step('closing other libraries', () => closeDupeSources(s));
  await step('writing mtime.json', () => s.lib.flushMtime());
  await step('closing the library files', () => s.lib.close());
  await step('closing the index', () => s.index.close());
  await step('closing the journal', () => s.journal.close());
}
