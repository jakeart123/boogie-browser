// Field-level inverse of one item's metadata.json change (PLAN "Write safety" §3).
//
// `undoItem` is pure and works on whatever record it is given. The planner runs it once on a
// clone of the current record (to find conflicts) and the returned `apply` runs it again on
// the fresh record the adapter reads right before writing, so a change that landed in between
// is still respected.
import { asArray, asObject, same, setOrDelete, unionKeys, type Rec } from './util';

export interface ItemUndo {
  changed: boolean;
  /** Set when the name must go back; the service does it through renameItem (files follow). */
  renameTo?: string;
  /** Fields left alone because the current value is no longer what the group wrote. */
  conflicts: string[];
}

/** Never restored: the adapter bumps lastModified on every write anyway. */
const SKIP = new Set(['id', 'lastModified']);

export function undoItem(rec: Rec, before: Rec, after: Rec): ItemUndo {
  const out: ItemUndo = { changed: false, conflicts: [] };
  const handled = new Set(SKIP);

  // Trash state is one unit: isDeleted and deletedTime move together (format-spec §14).
  if (!!before.isDeleted !== !!after.isDeleted) {
    handled.add('isDeleted').add('deletedTime');
    if (!!rec.isDeleted === !!after.isDeleted) {
      if (before.isDeleted) {
        // The group restored it, so undo re-trashes it with the time it had.
        rec.isDeleted = true;
        setOrDelete(rec, 'deletedTime', before.deletedTime);
      } else {
        // The group trashed it: restore like Eagle does (false, and drop deletedTime).
        rec.isDeleted = false;
        delete rec.deletedTime;
      }
      out.changed = true;
    } else out.conflicts.push('isDeleted');
  }

  for (const key of unionKeys(before, after)) {
    if (handled.has(key) || same(before[key], after[key], key)) continue;

    if (key === 'tags' || key === 'folders') {
      if (undoSet(rec, key, before[key], after[key])) out.changed = true;
    } else if (key === 'name') {
      if (rec.name === after.name && typeof before.name === 'string') out.renameTo = before.name;
      else out.conflicts.push('name');
    } else if (key === 'order') {
      if (undoOrder(rec, before.order, after.order, out)) out.changed = true;
    } else if (same(rec[key], after[key], key)) {
      setOrDelete(rec, key, before[key]);
      out.changed = true;
    } else out.conflicts.push(key);
  }
  return out;
}

/** tags / folders (and tags.json's lists): undo only what the group added or removed; keep everything else. */
export function undoSet(rec: Rec, key: string, bv: unknown, av: unknown): boolean {
  const b = asArray(bv);
  const a = asArray(av);
  const cur = asArray(rec[key]);
  let next: unknown[];
  if (same(cur, a)) {
    next = structuredClone(b); // nothing else changed: exact restore, original order
  } else {
    const added = a.filter((x) => !b.includes(x));
    const removed = b.filter((x) => !a.includes(x));
    next = cur.filter((x) => !added.includes(x));
    for (const x of removed) if (!next.includes(x)) next.push(x);
  }
  if (same(cur, next)) return false;
  rec[key] = next;
  return true;
}

/** order is a map folderId -> decimal string; each folder's entry is its own field. */
function undoOrder(rec: Rec, bv: unknown, av: unknown, out: ItemUndo): boolean {
  const b = asObject(bv);
  const a = asObject(av);
  const cur = asObject(rec.order);
  let changed = false;
  for (const folderId of unionKeys(b, a)) {
    if (b[folderId] === a[folderId]) continue;
    if (cur[folderId] === a[folderId]) {
      setOrDelete(cur, folderId, b[folderId]);
      changed = true;
    } else if (!out.conflicts.includes('order')) out.conflicts.push('order');
  }
  if (changed) {
    if (bv === undefined && Object.keys(cur).length === 0) delete rec.order;
    else rec.order = cur;
  }
  return changed;
}
