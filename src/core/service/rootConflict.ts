// A Dropbox conflicted copy of the root metadata.json ("metadata (Sam Lee's conflicted copy
// 2026-05-25).json"): Eagle ignores these files, so whatever the partner did to folders in that
// copy is silently lost. This lists the folder and smart-folder differences by id and applies the
// ones picked through the normal root write, as one history group. The copy itself is only read
// here. (The automatic merge and "settle this copy" are service/conflicts.ts; they share the
// pure folder rules in src/core/merge/root.ts.)
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Actor, EagleRootRecord, MutationResult, RootConflictPlan } from '../../shared/types';
import { conflictedCopyBase } from '../eagle';
import { applyChange, byApplyOrder, diffRoot, foldersLeaving, type Change } from '../merge';
import { editItems, ensureWritable, runGroup, toResult, writeRoot } from './group';
import { unchanged } from './skips';
import { itemIdsInFolders } from './sql';
import type { Session } from './types';

/** "Sam Lee's copy" from Dropbox's file name, else "the conflicted copy". */
function whoseCopy(relPath: string): string {
  const who = /\(([^()]+?)'s conflicted copy/i.exec(relPath)?.[1]?.trim();
  return who ? `${who}'s copy` : 'the conflicted copy';
}

/** Only a conflicted copy of the root file, directly in the library folder. */
function checkPath(relPath: string): void {
  if (!relPath || /[\\/]/.test(relPath) || conflictedCopyBase(relPath) !== 'metadata.json')
    throw new Error("That isn't a conflicted copy of the library's folder list.");
}

async function readCopy(s: Session, relPath: string): Promise<EagleRootRecord> {
  checkPath(relPath);
  let text: string;
  try {
    text = await readFile(join(s.lib.root, relPath), 'utf8');
  } catch {
    throw new Error('That conflicted copy is gone (maybe it was already removed).');
  }
  try {
    const v = JSON.parse(text) as EagleRootRecord;
    if (!v || typeof v !== 'object') throw new Error('not an object');
    return v;
  } catch {
    throw new Error("That conflicted copy can't be read (it may be damaged or still syncing).");
  }
}

export async function planRootConflict(s: Session, relPath: string): Promise<RootConflictPlan> {
  const copy = await readCopy(s, relPath);
  const live = (await s.lib.readRoot()).value;
  const changes = diffRoot(live, copy, whoseCopy(relPath)).map(({ aspects: _, ...c }) => c);
  return { relPath, changes };
}

// ───────────────────────── applying ─────────────────────────

/**
 * Apply the picked differences (by id) so those folders look like they do in the conflicted
 * copy. Worked out again against the files as they are now; a folder that goes away comes off
 * its items first, like a normal folder delete (the items themselves stay).
 */
export async function applyRootConflict(
  s: Session,
  actor: Actor,
  relPath: string,
  pickedIds: string[],
): Promise<MutationResult> {
  ensureWritable(s);
  const whose = whoseCopy(relPath);
  const picked = new Set(pickedIds);
  const { entry, t } = await runGroup(
    s,
    actor,
    `Merged changes from ${whose}`,
    'folders',
    async (ctx, t) => {
      const copy = await readCopy(s, relPath);
      const live = (await s.lib.readRoot()).value;
      const changes = diffRoot(live, copy, whose).filter((c) => picked.has(c.id));
      for (const id of picked)
        if (!changes.some((c) => c.id === id))
          t.skipped.push(unchanged(id, 'Nothing to merge for this one any more.'));
      if (!changes.length) return;

      // Folders that go away come off their items first, so no item points at a missing folder.
      // Subfolders the copy still has stay (removeKeepingCopy), and so do their items.
      const gone = foldersLeaving(
        live,
        copy,
        changes.filter((c) => c.kind === 'folder' && c.change === 'deletedInCopy').map((c) => c.id),
      );
      if (gone.length) {
        const goneSet = new Set(gone);
        await editItems(s, ctx, t, itemIdsInFolders(s.index, gone), (rec) => {
          if (!(rec.folders ?? []).some((f) => goneSet.has(f))) return false;
          s.env.deps.helpers.edits.removeFolders(rec, gone);
        });
      }
      const ordered: Change[] = byApplyOrder(changes);
      let merged = 0;
      await writeRoot(s, ctx, t, (root) => {
        for (const c of ordered) if (applyChange(root, copy, c)) merged++;
        return merged > 0;
      });
      t.count = merged;
      t.label = `Merged ${merged === 1 ? 'a change' : `${merged} changes`} from ${whose}`;
    },
  );
  return toResult(entry, t);
}
