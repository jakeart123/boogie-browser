// Folders, smart folders and quick access (tags and tag groups: tagOps.ts). Everything here that
// changes the root metadata.json does it through one adapter root write per action.
import type {
  Actor,
  EagleFolderRecord,
  FolderColor,
  FolderPatch,
  MutationResult,
  OrderBy,
  SmartCondition,
} from '../../shared/types';
import { findSmartFolder } from '../eagle';
import { editItems, ensureWritable, runGroup, sharedWarning, toResult, writeRoot } from './group';
import { itemsText, quoted } from './labels';
import { itemIdsInFolders } from './sql';
import type { Session } from './types';

// ───────────────────────── folders ─────────────────────────

export async function createFolder(
  s: Session,
  actor: Actor,
  name: string,
  parentId: string | null,
  opts?: { iconColor?: FolderColor },
): Promise<{ id: string; groupId: string }> {
  ensureWritable(s);
  const { tree } = s.env.deps.helpers;
  const clean = name.trim();
  if (!clean) throw new Error('Give the folder a name.');
  const parent = parentId ? tree.findFolder(s.root, parentId) : null;
  if (parentId && !parent) throw new Error('That parent folder does not exist.');

  let id = '';
  let groupId = '';
  const { entry } = await runGroup(
    s,
    actor,
    `Created folder ${quoted(clean)}`,
    'folders',
    async (ctx, t) => {
      groupId = ctx.group.id;
      await writeRoot(s, ctx, t, (root) => {
        id = tree.addFolder(root, { name: clean, parentId, iconColor: opts?.iconColor });
      });
      const made = tree.findFolder(s.root, id)?.name ?? clean;
      t.label = parent
        ? `Created folder ${quoted(made)} in ${quoted(parent.name)}`
        : `Created folder ${quoted(made)}`;
    },
  );
  return { id, groupId: entry?.groupId ?? groupId };
}

export async function updateFolder(
  s: Session,
  actor: Actor,
  id: string,
  patch: FolderPatch,
): Promise<MutationResult> {
  ensureWritable(s);
  const { tree } = s.env.deps.helpers;
  const before = tree.findFolder(s.root, id);
  if (!before) throw new Error('That folder does not exist.');
  const oldName = before.name;
  if (patch.name !== undefined && !patch.name.trim())
    throw new Error("A folder name can't be empty.");

  const { entry, t } = await runGroup(
    s,
    actor,
    `Edited folder ${quoted(oldName)}`,
    'folders',
    async (ctx, t) => {
      await writeRoot(s, ctx, t, (root) => tree.updateFolder(root, id, patch));
      const now = tree.findFolder(s.root, id)?.name ?? oldName;
      t.label =
        now !== oldName
          ? `Renamed folder ${quoted(oldName)} to ${quoted(now)}`
          : `Edited folder ${quoted(now)}`;
    },
  );
  return toResult(entry, t);
}

export async function moveFolder(
  s: Session,
  actor: Actor,
  id: string,
  parentId: string | null,
  index: number,
): Promise<MutationResult> {
  ensureWritable(s);
  const { tree } = s.env.deps.helpers;
  const folder = tree.findFolder(s.root, id);
  if (!folder) throw new Error('That folder does not exist.');
  const parent = parentId ? tree.findFolder(s.root, parentId) : null;
  if (parentId && !parent) throw new Error('That parent folder does not exist.');
  if (parentId && tree.descendantIds(s.root, id).includes(parentId))
    throw new Error("A folder can't go inside itself.");

  const label = parent
    ? `Moved folder ${quoted(folder.name)} into ${quoted(parent.name)}`
    : `Moved folder ${quoted(folder.name)} to the top level`;
  const { entry, t } = await runGroup(s, actor, label, 'folders', async (ctx, t) => {
    await writeRoot(s, ctx, t, (root) => tree.moveFolder(root, id, parentId, index));
  });
  return toResult(entry, t);
}

/** Eagle's "Sort by name": lowercased names, numbers in number order ("2" before "10"). */
const byName = new Intl.Collator('en', { numeric: true });

/** Sort one level of the tree A to Z (a folder's subfolders, or the top level), like Eagle. */
export async function sortFolders(
  s: Session,
  actor: Actor,
  parentId: string | null,
): Promise<MutationResult> {
  ensureWritable(s);
  const { tree } = s.env.deps.helpers;
  const parent = parentId ? tree.findFolder(s.root, parentId) : null;
  if (parentId && !parent) throw new Error('That folder does not exist.');
  const label = parent
    ? `Sorted the folders in ${quoted(parent.name)} A to Z`
    : 'Sorted the top-level folders A to Z';
  const { entry, t } = await runGroup(s, actor, label, 'folders', async (ctx, t) => {
    await writeRoot(s, ctx, t, (root) => {
      const list = parentId ? tree.findFolder(root, parentId)?.children : root.folders;
      if (!Array.isArray(list)) return false;
      const name = (f: EagleFolderRecord) => String(f?.name ?? '').toLowerCase();
      const sorted = [...list].sort((a, b) => byName.compare(name(a), name(b)));
      if (sorted.every((f, i) => f === list[i])) return false;
      list.splice(0, list.length, ...sorted);
    });
  });
  return toResult(entry, t);
}

/**
 * Items first, root second: the folder id comes off every item that has it (Eagle's own order),
 * so no item is ever left pointing at a folder that is gone.
 */
export async function deleteFolder(
  s: Session,
  actor: Actor,
  id: string,
  opts?: { deleteContents?: boolean },
): Promise<MutationResult> {
  ensureWritable(s);
  const { tree, edits } = s.env.deps.helpers;
  const folder = tree.findFolder(s.root, id);
  if (!folder) throw new Error('That folder does not exist.');
  const gone = tree.descendantIds(s.root, id);
  const goneSet = new Set(gone);
  const affected = itemIdsInFolders(s.index, gone);

  const { entry, t } = await runGroup(
    s,
    actor,
    `Deleted folder ${quoted(folder.name)}`,
    'folders',
    async (ctx, t) => {
      let trashed = 0;
      await editItems(s, ctx, t, affected, (rec) => {
        const had = rec.folders ?? [];
        if (!had.some((f) => goneSet.has(f))) return false;
        edits.removeFolders(rec, gone);
        // Eagle's "delete contents": items that were only in this folder go to the trash, with no deletedTime.
        if (opts?.deleteContents && had.every((f) => goneSet.has(f)) && !rec.isDeleted) {
          rec.isDeleted = true;
          trashed++;
        }
      });
      await writeRoot(s, ctx, t, (root) => {
        tree.removeFolder(root, id);
      });
      t.label = trashed
        ? `Deleted folder ${quoted(folder.name)} and moved ${itemsText(trashed)} to trash`
        : `Deleted folder ${quoted(folder.name)}`;
    },
  );
  return toResult(entry, t);
}

// ───────────────────────── smart folders and quick access ─────────────────────────

export async function createSmartFolder(
  s: Session,
  actor: Actor,
  name: string,
  conditions: SmartCondition[],
  parentId: string | null | undefined,
  opts?: { iconColor?: FolderColor },
): Promise<{ id: string; groupId: string }> {
  ensureWritable(s);
  const { tree } = s.env.deps.helpers;
  const clean = name.trim();
  if (!clean) throw new Error('Give the smart folder a name.');
  if (parentId && !findSmartFolder(s.root, parentId))
    throw new Error('That parent smart folder does not exist.');

  let id = '';
  let groupId = '';
  const { entry } = await runGroup(
    s,
    actor,
    `Created smart folder ${quoted(clean)}`,
    'folders',
    async (ctx, t) => {
      groupId = ctx.group.id;
      await writeRoot(s, ctx, t, (root) => {
        id = tree.addSmartFolder(root, { name: clean, conditions, parentId: parentId ?? null });
        // In the same write, so a colored smart folder is one history entry.
        if (opts?.iconColor) tree.updateSmartFolder(root, id, { iconColor: opts.iconColor });
      });
    },
  );
  return { id, groupId: entry?.groupId ?? groupId };
}

export async function updateSmartFolder(
  s: Session,
  actor: Actor,
  id: string,
  patch: {
    name?: string;
    conditions?: SmartCondition[];
    iconColor?: FolderColor | null;
    orderBy?: OrderBy | null;
  },
): Promise<MutationResult> {
  ensureWritable(s);
  const { tree } = s.env.deps.helpers;
  const before = findSmartFolder(s.root, id);
  if (!before) throw new Error('That smart folder does not exist.');
  if (patch.name !== undefined && !patch.name.trim())
    throw new Error("A smart folder name can't be empty.");
  const oldName = before.name;

  const { entry, t } = await runGroup(
    s,
    actor,
    `Edited smart folder ${quoted(oldName)}`,
    'folders',
    async (ctx, t) => {
      await writeRoot(s, ctx, t, (root) => tree.updateSmartFolder(root, id, patch));
      const now = findSmartFolder(s.root, id)?.name ?? oldName;
      t.label =
        now !== oldName
          ? `Renamed smart folder ${quoted(oldName)} to ${quoted(now)}`
          : `Edited smart folder ${quoted(now)}`;
    },
  );
  return toResult(entry, t);
}

export async function deleteSmartFolder(
  s: Session,
  actor: Actor,
  id: string,
): Promise<MutationResult> {
  ensureWritable(s);
  const { tree } = s.env.deps.helpers;
  const folder = findSmartFolder(s.root, id);
  if (!folder) throw new Error('That smart folder does not exist.');
  const { entry, t } = await runGroup(
    s,
    actor,
    `Deleted smart folder ${quoted(folder.name)}`,
    'folders',
    async (ctx, t) => {
      await writeRoot(s, ctx, t, (root) => tree.removeSmartFolder(root, id));
    },
  );
  return toResult(entry, t);
}

export async function setQuickAccess(
  s: Session,
  actor: Actor,
  entries: { type: 'folder' | 'smartFolder'; id: string }[],
): Promise<MutationResult> {
  ensureWritable(s);
  const { tree } = s.env.deps.helpers;
  const { entry, t } = await runGroup(s, actor, 'Changed quick access', 'other', async (ctx, t) => {
    if (await writeRoot(s, ctx, t, (root) => tree.setQuickAccess(root, entries)))
      t.warning = sharedWarning(s);
  });
  return toResult(entry, t);
}
