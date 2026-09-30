// Change lists: the exact before/after an agent sees in a dry run. Pure functions, no I/O.
// Batch rename and duplicate merge use the app's own rules (service/rename.ts, dupes planMerge),
// so a dry run can never show something different from what gets applied.
import type { EagleItemRecord, Item, ItemPatch } from '../../shared/types';
import { planMerge } from '../dupes';
import { expandRenameTemplate, type RenameOptions } from '../service/rename';
import type { FolderIndex } from './folders';
import { uniq } from './kit';

export interface Change {
  /** Item id, or the folder/tag/path the change is about. */
  id: string;
  name: string;
  field: string;
  before: unknown;
  after: unknown;
}

const CHANGES_SHOWN = 100;
const CLIP = 200;

const clip = (v: unknown): unknown =>
  typeof v === 'string' && v.length > CLIP ? v.slice(0, CLIP) + '...' : v;

/** What the agent is shown: at most 100 rows, long text clipped. The digest uses the full list. */
export function displayChanges(changes: Change[]): {
  changes: Change[];
  changes_total: number;
  changes_truncated: boolean;
} {
  return {
    changes: changes
      .slice(0, CHANGES_SHOWN)
      .map((c) => ({ ...c, before: clip(c.before), after: clip(c.after) })),
    changes_total: changes.length,
    changes_truncated: changes.length > CHANGES_SHOWN,
  };
}

const sameList = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** Adds a change to `out` only when before and after differ (lists compare in order). */
function recorder(out: Change[], item: Item) {
  return (field: string, before: unknown, after: unknown) => {
    const same =
      Array.isArray(before) && Array.isArray(after) ? sameList(before, after) : before === after;
    if (!same) out.push({ id: item.id, name: item.name, field, before, after });
  };
}

/**
 * The per-item changes an ItemPatch would make. Mirrors what CoreApi.updateItems does: setX wins over
 * addX/removeX, and adding to a folder also adds that folder's auto-tags (own and ancestors').
 * No-ops are left out so a re-run of an already applied change is "nothing to do".
 */
export function diffPatch(item: Item, patch: ItemPatch, folders: FolderIndex): Change[] {
  const out: Change[] = [];
  const push = recorder(out, item);

  if (patch.name !== undefined) push('name', item.name, patch.name);

  let folderIds = item.folders;
  if (patch.setFolders) folderIds = uniq(patch.setFolders);
  else {
    if (patch.removeFolders) folderIds = folderIds.filter((f) => !patch.removeFolders!.includes(f));
    if (patch.addFolders) folderIds = uniq([...folderIds, ...patch.addFolders]);
  }
  push(
    'folders',
    item.folders.map((f) => folders.pathOf(f)),
    folderIds.map((f) => folders.pathOf(f)),
  );

  let tags = item.tags;
  if (patch.setTags) tags = uniq(patch.setTags);
  else {
    if (patch.removeTags) tags = tags.filter((t) => !patch.removeTags!.includes(t));
    if (patch.addTags) tags = uniq([...tags, ...patch.addTags]);
  }
  const addedFolders = (patch.addFolders ?? []).filter((f) => !item.folders.includes(f));
  if (addedFolders.length)
    tags = uniq([...tags, ...addedFolders.flatMap((f) => folders.autoTags(f))]);
  push('tags', item.tags, tags);

  if (patch.star !== undefined) push('rating', item.star, patch.star);
  if (patch.annotation !== undefined) push('note', item.annotation, patch.annotation);
  if (patch.url !== undefined) push('url', item.url, patch.url);
  return out;
}

/** The names batch rename gives these items, in this order (before the adapter makes them filename-safe). */
export function previewRename(items: Item[], template: string, opts: RenameOptions): string[] {
  const sources = items.map((i) => ({ name: i.name, tags: i.tags, importedAt: i.importedAt }));
  // The service trims each name before writing it, and skips empty ones.
  return expandRenameTemplate(template, sources, opts).map((n) => n.trim());
}

/** The record fields merge planning reads, from what the query engine returns. */
function asRecord(i: Item): EagleItemRecord {
  return {
    id: i.id,
    name: i.name,
    size: i.size,
    btime: i.btime,
    mtime: i.mtime,
    ext: i.ext,
    tags: [...i.tags],
    folders: [...i.folders],
    isDeleted: i.isDeleted,
    url: i.url,
    annotation: i.annotation,
    modificationTime: i.importedAt,
    ...(i.star ? { star: i.star } : {}),
    order: { ...i.order },
  };
}

/** The keeper's side of a duplicate merge (the app's own planMerge), and the ids it would trash. */
export function previewMerge(
  keeper: Item,
  others: Item[],
  folders: FolderIndex,
): { changes: Change[]; trashIds: string[] } {
  const rec = asRecord(keeper);
  const plan = planMerge(
    rec,
    others.map(asRecord),
    { keeperId: keeper.id, otherIds: others.map((o) => o.id) },
    (id) => folders.autoTags(id),
  );
  plan.keeper(rec);
  const out: Change[] = [];
  const push = recorder(out, keeper);
  push('tags', keeper.tags, rec.tags);
  push(
    'folders',
    keeper.folders.map((f) => folders.pathOf(f)),
    rec.folders.map((f) => folders.pathOf(f)),
  );
  push('rating', keeper.star, rec.star ?? 0);
  push('url', keeper.url, rec.url);
  push('note', keeper.annotation, rec.annotation);
  return { changes: out, trashIds: plan.trashIds };
}
