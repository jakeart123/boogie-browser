// Sidebar numbers from the index: the totals, every folder's own and deep count, and the tag list
// with counts. Items in password-locked folders are left out of the totals, like Eagle.
import type { Counts, EagleRootRecord, TagInfo } from '../../shared/types';
import type { FolderText } from './project';
import type { Statements } from './statements';

/** The folders numbered 0..n-1, with each one's ancestors (itself included) by number. */
export interface FolderNumbers {
  ids: string[];
  number: Map<string, number>;
  ancestors: Int32Array[];
}

export function numberFolders(
  folderText: Map<string, FolderText>,
  ancestorsOf: Map<string, string[]>,
): FolderNumbers {
  const ids = [...folderText.keys()];
  const number = new Map(ids.map((id, i) => [id, i]));
  const ancestors = ids.map((id) =>
    Int32Array.from((ancestorsOf.get(id) ?? [id]).map((a) => number.get(a) ?? -1)).filter(
      (a) => a >= 0,
    ),
  );
  return { ids, number, ancestors };
}

/** Some folder has a password, so its items are hidden (see LOCKED_ROWIDS). */
export function hasLocked(st: Statements): boolean {
  return st.anyLocked.get() !== undefined;
}

export function computeCounts(st: Statements, folderNumbers: FolderNumbers): Counts {
  const totals = st.totals.get() as {
    all: number;
    uncategorized: number;
    untagged: number;
    trash: number;
    totalSize: number;
  };
  // Per item, its folders that exist each count it once as their own, and every ancestor of any
  // of them counts it once deep. Folders are numbered (tree order) so this runs on typed arrays:
  // item_folders is read in item order, so `mark` (the last item an ancestor counted) dedupes.
  const { ids, number, ancestors } = folderNumbers;
  const own = new Int32Array(ids.length);
  const deep = new Int32Array(ids.length);
  const mark = new Int32Array(ids.length).fill(-1);
  const trashed = new Set(st.trashedRowids.all() as number[]);
  for (const [rowid, folderId] of st.folderPairs.all() as [number, string][]) {
    const f = number.get(folderId);
    if (f === undefined || trashed.has(rowid)) continue;
    own[f]++;
    for (const a of ancestors[f]) {
      if (mark[a] === rowid) continue;
      mark[a] = rowid;
      deep[a]++;
    }
  }
  const folders: Counts['folders'] = {};
  for (let f = 0; f < ids.length; f++) folders[ids[f]] = { own: own[f], deep: deep[f] };

  // Folder badges keep counting locked items (Eagle shows how many a locked folder holds).
  if (hasLocked(st)) {
    const locked = st.lockedTotals.get() as { n: number; untagged: number; size: number };
    totals.all -= locked.n;
    totals.untagged -= locked.untagged;
    totals.totalSize -= locked.size;
  }
  return {
    all: totals.all,
    uncategorized: totals.uncategorized,
    untagged: totals.untagged,
    trash: totals.trash,
    folders,
    smartFolders: {},
    totalSize: totals.totalSize,
  };
}

/** Live tag counts, plus tags that only live in a tag group (count 0), sorted by name. */
export function tagInfos(st: Statements, root: EagleRootRecord | null): TagInfo[] {
  const counts = new Map(st.tagCounts.all() as [string, number][]);
  for (const [tag, n] of st.trashedTagCounts.all() as [string, number][])
    counts.set(tag, (counts.get(tag) ?? 0) - n);
  if (hasLocked(st))
    for (const [tag, n] of st.lockedTagCounts.all() as [string, number][])
      counts.set(tag, (counts.get(tag) ?? 0) - n);

  const groups = new Map<string, string[]>();
  for (const g of root?.tagsGroups ?? []) {
    for (const tag of Array.isArray(g.tags) ? g.tags : []) {
      const list = groups.get(tag);
      if (list) list.push(g.id);
      else groups.set(tag, [g.id]);
    }
  }
  for (const tag of groups.keys()) if (!counts.has(tag)) counts.set(tag, 0);

  const out: TagInfo[] = [];
  for (const [name, count] of counts) {
    if (count > 0 || groups.has(name))
      out.push({ name, count: Math.max(count, 0), groupIds: groups.get(name) ?? [] });
  }
  return out.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
  );
}
