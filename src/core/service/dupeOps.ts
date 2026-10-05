// The duplicate finder: the scan job (this library, optionally with others opened read-only)
// and merging, one history entry per merge action.
import { join } from 'node:path';
import type {
  Actor,
  DupeScanOptions,
  DuplicateGroup,
  MergeOptions,
  MutationResult,
  Scope,
} from '../../shared/types';
import type { JournalSink } from '../contracts';
import type { ScanSource } from '../dupes/scan';
import { pathExists } from '../libraries/fsutil';
import { libraryRef } from '../libraryId';
import { applyWrites, editItems, ensureWritable, isItemId, runGroup, toResult } from './group';
import type { JobHandle } from './jobs';
import { quoted } from './labels';
import { syncOtherIndex } from './otherLibrary';
import { closeDupeSources, closeSource, makeUrls, openIndex } from './session';
import { cleanIds, skip } from './skips';
import { isSlowStorage } from './storage';
import type { OpenSource, Session } from './types';
import { plural } from './util';

/** Other libraries are opened read-only, so the adapter never asks this to record anything. */
const readOnlySink = (dir: string): JournalSink => ({
  recordFile() {},
  recordMoveOut() {},
  storeDirFor: () => dir,
});

async function openSource(s: Session, path: string, h: JobHandle): Promise<OpenSource> {
  const { deps, paths } = s.env;
  const ref = libraryRef(path);
  // Open in Boogie already (the window, or an agent): read that session's index, never a second one.
  const open = s.env.findOpen(ref.id);
  if (open) return { ref, lib: open.lib, index: open.index, urls: open.urls, borrowed: true };
  if (!(await pathExists(join(ref.path, 'metadata.json'))))
    throw new Error(`${quoted(ref.name)} doesn't look like an Eagle library.`);
  h.label(`Reading ${quoted(ref.name)}`);
  const lib = await deps.eagle.open(ref.path, {
    readOnly: true,
    journal: readOnlySink(join(paths.data, 'journal', 'read-only-unused')),
    nameMaxChars: s.env.settings().windowsNameMaxChars,
  });
  let index;
  try {
    index = openIndex(s.env, ref);
    await syncOtherIndex(s, ref, lib, index, (p) => h.progress(p.done, p.total), h.signal);
  } catch (e) {
    await lib.close().catch(() => undefined);
    index?.close();
    throw e;
  }
  return { ref, lib, index, urls: makeUrls(s.env, ref.id, index) };
}

/** The dupe finder works on plain scopes; a smart folder is its rules, which only the query engine knows. */
function resolveScope(s: Session, scope: Scope | undefined): Scope | undefined {
  if (scope?.kind !== 'smartFolder') return scope;
  return { kind: 'ids', ids: s.query.query({ scope, filter: {}, sort: null }).ids };
}

/** The scan job. The other libraries stay open (read-only) so their thumbnails keep resolving until the next scan or close. */
export function findDuplicates(s: Session, opts: DupeScanOptions): { jobId: string } {
  const jobId = s.env.jobs.start(
    'dupes',
    'Finding duplicates',
    async (h): Promise<DuplicateGroup[]> => {
      closeDupeSources(s);
      if (s.syncPromise) {
        h.label('Waiting for the library to finish indexing');
        await s.syncPromise;
      }
      // Whole originals are read 2 at a time from a slow drive (service/storage), 4 otherwise.
      const others: ScanSource[] = [];
      for (const path of opts.otherLibraries ?? []) {
        const ref = libraryRef(path);
        if (ref.id === s.ref.id || s.dupeSources.some((d) => d.ref.id === ref.id)) continue;
        const src = await openSource(s, path, h);
        if (s.closed) {
          closeSource(src);
          throw new Error('The library was closed.');
        }
        s.dupeSources.push(src);
        others.push({ ...src, slow: await isSlowStorage(src.ref.path) });
      }
      h.label('Finding duplicates');
      h.progress(0, 0);
      const current: ScanSource = {
        ref: s.ref,
        lib: s.lib,
        index: s.index,
        urls: s.urls,
        slow: await isSlowStorage(s.ref.path),
      };
      return s.env.deps.dupes.scan(
        { ...opts, scope: resolveScope(s, opts.scope) },
        current,
        others,
        s.env.media(),
        (p) => h.progress(p.done, p.total),
        h.signal,
      );
    },
    { scope: s.ref.id },
  );
  return { jobId };
}

/** A group or many ("Merge all exact groups"), always as ONE history entry, so one undo. */
export async function mergeDuplicates(
  s: Session,
  actor: Actor,
  opts: MergeOptions | MergeOptions[],
): Promise<MutationResult> {
  ensureWritable(s);
  const groups = Array.isArray(opts) ? opts : [opts];
  if (!groups.length) return { groupId: null, changed: 0, skipped: [] };
  for (const g of groups)
    if (!isItemId(g.keeperId)) throw new Error('That is not a valid item to keep.');
  const { dupes, helpers } = s.env.deps;

  const { entry, t } = await runGroup(s, actor, 'Merged duplicates', 'merge', async (ctx, t) => {
    let trashed = 0;
    let keeperName = '';
    for (const g of groups) {
      const { ids: others } = cleanIds(g.otherIds.filter((id) => id !== g.keeperId));
      const keeper = await s.lib.readItem(g.keeperId);
      if (!keeper) {
        // One missing keeper must not stop "merge all"; a single merge says so plainly.
        if (groups.length === 1) throw new Error('The item to keep could not be found.');
        t.skipped.push(skip(g.keeperId, 'The item to keep could not be found.', 'missing'));
        continue;
      }
      const found = (await Promise.all(others.map((id) => s.lib.readItem(id)))).flatMap((d) =>
        d ? [d.value] : [],
      );
      const plan = dupes.planMerge(keeper.value, found, { ...g, otherIds: others }, (folderId) =>
        helpers.tree.autoTagsFor(s.root, folderId),
      );
      applyWrites(s, t, [await s.lib.updateItem(g.keeperId, plan.keeper, ctx)]);
      const keepName = g.keepName && g.keepName !== 'keeper' ? g.keepName : null;
      if (keepName) applyWrites(s, t, [await s.lib.renameItem(g.keeperId, keepName, ctx)]);
      const trash = plan.trashIds.filter((id) => others.includes(id));
      await editItems(s, ctx, t, trash, (rec) => {
        if (rec.isDeleted) return false;
        helpers.edits.trash(rec, Date.now());
      });
      for (const id of others) if (!trash.includes(id)) t.skipped.push(skip(id, 'Not merged.'));
      trashed += trash.length;
      keeperName = keepName ?? keeper.value.name;
      await t.pause();
    }
    t.label =
      groups.length === 1
        ? `Merged ${plural(trashed, 'duplicate')} into ${quoted(keeperName)}`
        : `Merged ${plural(groups.length, 'group')} of duplicates (${plural(trashed, 'item')} to trash)`;
  });
  return toResult(entry, t);
}
