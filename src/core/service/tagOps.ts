// Tags across the library (rename, merge, delete) and tag groups. A tag lives on items, in folder
// auto-tags, smart-folder rules, tag groups and tags.json: each action reaches all of them as one
// history group, the root file in one adapter write.
import type {
  Actor,
  EagleFolderRecord,
  EagleSmartFolderRecord,
  MutationResult,
} from '../../shared/types';
import type { ChangeContext, EagleTagsFile } from '../contracts';
import { upsertTagGroup as putTagGroup } from '../eagle';
import { editItems, ensureWritable, runGroup, sharedWarning, toResult, writeRoot } from './group';
import { quoted } from './labels';
import { itemIdsWithTag } from './sql';
import { buildLibraryState } from './state';
import { removeFromList, renameInList, writeTagsFile } from './tagsFile';
import type { Session, Touch } from './types';

const NOTHING: MutationResult = { groupId: null, changed: 0, skipped: [] };

/** A folder's auto-tags: `from` becomes `to` (no repeats). Walks the whole tree. */
function renameInFolderTags(
  list: EagleFolderRecord[] | undefined,
  from: string,
  to: string,
): boolean {
  let changed = false;
  for (const f of list ?? []) {
    if (Array.isArray(f.tags) && f.tags.includes(from)) {
      f.tags = [...new Set(f.tags.map((x) => (x === from ? to : x)))];
      changed = true;
    }
    changed = renameInFolderTags(f.children, from, to) || changed;
  }
  return changed;
}

function removeFromFolderTags(list: EagleFolderRecord[] | undefined, tag: string): boolean {
  let changed = false;
  for (const f of list ?? []) {
    if (Array.isArray(f.tags) && f.tags.includes(tag)) {
      f.tags = f.tags.filter((x) => x !== tag);
      changed = true;
    }
    changed = removeFromFolderTags(f.children, tag) || changed;
  }
  return changed;
}

/** Smart-folder "Tags" rules that list `from` now list `to` (no repeats), like Eagle's rename. */
function renameInSmartRules(
  list: EagleSmartFolderRecord[] | undefined,
  from: string,
  to: string,
): boolean {
  let changed = false;
  for (const f of list ?? []) {
    for (const c of Array.isArray(f.conditions) ? f.conditions : []) {
      for (const r of Array.isArray(c?.rules) ? c.rules : []) {
        if (r?.property !== 'tags' || !Array.isArray(r.value) || !r.value.includes(from)) continue;
        r.value = [...new Set((r.value as unknown[]).map((x) => (x === from ? to : x)))];
        changed = true;
      }
    }
    changed = renameInSmartRules(f.children, from, to) || changed;
  }
  return changed;
}

/**
 * The tags.json part of a rename or delete, last and best-effort: the items and the root are
 * already written by then, so a tags.json that can't be read right now (half-synced by Dropbox)
 * turns into a warning instead of an error for a change that did happen.
 */
async function tagListsBestEffort(
  s: Session,
  ctx: ChangeContext,
  t: Touch,
  mutate: (file: EagleTagsFile) => boolean,
): Promise<boolean> {
  try {
    return await writeTagsFile(s, ctx, t, mutate);
  } catch (e) {
    console.error('[boogie] could not update tags.json', e);
    t.warning =
      "Done, but the starred and recent tag lists (tags.json) couldn't be updated right now. They may still show the old name.";
    return false;
  }
}

/**
 * Rename (or merge into an existing tag) everywhere Eagle's own rename reaches: every item, tag
 * groups, folder auto-tags (or folders would keep adding the old tag), smart-folder tag rules and
 * the recent-tags list, plus the starred list (Eagle leaves a starred tag behind under its old
 * name; Boogie keeps the star). One history group.
 */
export async function renameTag(
  s: Session,
  actor: Actor,
  from: string,
  to: string,
): Promise<MutationResult> {
  ensureWritable(s);
  const { edits, tree } = s.env.deps.helpers;
  const next = to.trim();
  if (!next) throw new Error('A tag needs a name.');
  if (from === next) return NOTHING;
  const ids = itemIdsWithTag(s.index, from);
  const merging = s.index.tags().some((x) => x.name === next && x.count > 0);
  const label = merging
    ? `Merged tag ${quoted(from)} into ${quoted(next)}`
    : `Renamed tag ${quoted(from)} to ${quoted(next)}`;

  let listsChanged = false;
  const { entry, t } = await runGroup(s, actor, label, 'items', async (ctx, t) => {
    await editItems(s, ctx, t, ids, (rec) => {
      const tags = rec.tags ?? [];
      if (!tags.includes(from)) return false;
      edits.setTags(
        rec,
        tags.map((x) => (x === from ? next : x)),
      );
    });
    const rootChanged = await writeRoot(s, ctx, t, (root) => {
      const groupsBefore = JSON.stringify(root.tagsGroups);
      tree.renameTagInGroups(root, from, next);
      const groups = JSON.stringify(root.tagsGroups) !== groupsBefore;
      const folders = renameInFolderTags(root.folders, from, next);
      const smart = renameInSmartRules(root.smartFolders, from, next);
      return groups || folders || smart;
    });
    // Folder and tag-group changes don't reach a running Eagle; tags.json says the same itself.
    if (rootChanged) t.warning = sharedWarning(s);
    listsChanged = await tagListsBestEffort(s, ctx, t, (file) => {
      const recent = renameInList(file.historyTags, from, next);
      const starred = renameInList(file.starredTags, from, next);
      return recent || starred;
    });
  });
  // The starred and recent lists are part of the library state, like the root.
  if (listsChanged && !t.root) s.env.emit('library', buildLibraryState(s));
  return toResult(entry, t);
}

/** Delete from every item, folder auto-tags, tag groups and the starred list (Eagle's delete). */
export async function deleteTag(s: Session, actor: Actor, name: string): Promise<MutationResult> {
  ensureWritable(s);
  const { edits, tree } = s.env.deps.helpers;
  const ids = itemIdsWithTag(s.index, name);

  let listsChanged = false;
  const { entry, t } = await runGroup(
    s,
    actor,
    `Deleted tag ${quoted(name)}`,
    'items',
    async (ctx, t) => {
      await editItems(s, ctx, t, ids, (rec) => {
        if (!(rec.tags ?? []).includes(name)) return false;
        edits.removeTags(rec, [name]);
      });
      const rootChanged = await writeRoot(s, ctx, t, (root) => {
        const groupsBefore = JSON.stringify(root.tagsGroups);
        tree.removeTagFromGroups(root, name);
        const groups = JSON.stringify(root.tagsGroups) !== groupsBefore;
        const folders = removeFromFolderTags(root.folders, name);
        return groups || folders;
      });
      if (rootChanged) t.warning = sharedWarning(s);
      listsChanged = await tagListsBestEffort(s, ctx, t, (file) =>
        removeFromList(file.starredTags, name),
      );
    },
  );
  if (listsChanged && !t.root) s.env.emit('library', buildLibraryState(s));
  return toResult(entry, t);
}

/** `color`: undefined keeps the group's color, null or "" clears it. */
export async function upsertTagGroup(
  s: Session,
  actor: Actor,
  group: { id?: string; name: string; tags: string[]; color?: string | null; description?: string },
): Promise<MutationResult> {
  ensureWritable(s);
  const name = group.name.trim();
  if (!name) throw new Error('Give the tag group a name.');
  const color = group.color === undefined ? undefined : group.color || null;
  const record = {
    ...(group.id ? { id: group.id } : {}),
    name,
    tags: [...new Set(group.tags.map((x) => x.trim()).filter(Boolean))],
    ...(color !== undefined ? { color } : {}),
    ...(group.description !== undefined ? { description: group.description } : {}),
  };
  const { entry, t } = await runGroup(
    s,
    actor,
    `Saved tag group ${quoted(name)}`,
    'other',
    async (ctx, t) => {
      // Eagle's own upsert: it takes null as "clear the color" (helpers.tree's type can't say it).
      if (await writeRoot(s, ctx, t, (root) => void putTagGroup(root, record)))
        t.warning = sharedWarning(s);
    },
  );
  return toResult(entry, t);
}

export async function deleteTagGroup(
  s: Session,
  actor: Actor,
  id: string,
): Promise<MutationResult> {
  ensureWritable(s);
  const { tree } = s.env.deps.helpers;
  const group = s.root.tagsGroups?.find((g) => g.id === id);
  if (!group) throw new Error('That tag group does not exist.');
  const { entry, t } = await runGroup(
    s,
    actor,
    `Deleted tag group ${quoted(group.name)}`,
    'other',
    async (ctx, t) => {
      if (await writeRoot(s, ctx, t, (root) => tree.removeTagGroup(root, id)))
        t.warning = sharedWarning(s);
    },
  );
  return toResult(entry, t);
}
