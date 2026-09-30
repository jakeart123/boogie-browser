// planUndo: turn one history group into an UndoPlan, computed against the CURRENT state.
// Pure with respect to the journal database: the store hands over the group's coalesced
// changes and this file decides what can still be undone safely.
import { existsSync } from 'node:fs';
import type { EagleItemRecord, EagleRootRecord } from '../../shared/types';
import type { Doc, EagleSavedFilter, EagleTagsFile, UndoPlan } from '../contracts';
import { thumbnailJournalId } from '../eagle/paths';
import { undoItem, undoSet } from './undoItem';
import { undoRoot } from './undoRoot';
import { CHANGED_SINCE, same, setOrDelete, unionKeys, type Conflict, type Rec } from './util';

/** One file's net change over the whole group: first `before`, last `after`. */
export interface GroupChange {
  relPath: string;
  itemId: string | null;
  before: string | null;
  after: string | null;
}

export interface GroupData {
  id: string;
  label: string;
  changes: GroupChange[];
  moves: { itemId: string; storedAt: string }[];
}

export interface CurrentState {
  readItem(id: string): Promise<Doc<EagleItemRecord> | null>;
  readRoot(): Promise<Doc<EagleRootRecord>>;
}

const ITEM_FILE = /^images\/([^/]+)\.info\/metadata\.json$/;
const ROOT_FILE = 'metadata.json';
const TAGS_FILE = 'tags.json';
const SAVED_FILTERS_FILE = 'saved-filters.json';
const READ_BATCH = 32; // reading thousands of records one by one is slow, all at once is rude

/** True if undoing this file could ever do something (used to set HistoryEntry.undoable). */
export function isUndoablePath(relPath: string): boolean {
  return (
    relPath === ROOT_FILE ||
    relPath === TAGS_FILE ||
    relPath === SAVED_FILTERS_FILE ||
    ITEM_FILE.test(relPath) ||
    thumbnailJournalId(relPath) !== null
  );
}

export async function planUndo(data: GroupData, current: CurrentState): Promise<UndoPlan> {
  const plan: UndoPlan = {
    groupId: data.id,
    items: [],
    root: null,
    moveBackIn: [],
    conflicts: [],
    label: `Undo: ${data.label}`,
  };
  const movedOut = new Set(data.moves.map((m) => m.itemId));

  // Permanently deleted items: the whole folder sits in the journal store; move it back.
  for (const m of data.moves) {
    if (!existsSync(m.storedAt))
      plan.conflicts.push({ id: m.itemId, field: 'item', reason: 'the stored copy is missing' });
    else if (await current.readItem(m.itemId))
      plan.conflicts.push({ id: m.itemId, field: 'item', reason: 'already in the library' });
    else plan.moveBackIn.push({ itemId: m.itemId, storedAt: m.storedAt });
  }

  const itemChanges: (GroupChange & { itemId: string })[] = [];
  let rootChange: GroupChange | null = null;
  for (const c of data.changes) {
    const id = c.itemId ?? ITEM_FILE.exec(c.relPath)?.[1] ?? null;
    const thumbOf = thumbnailJournalId(c.relPath);
    if (c.relPath === ROOT_FILE) rootChange = c;
    else if (c.relPath === TAGS_FILE) plan.tagsFile = planTagsFile(c, plan.conflicts);
    else if (c.relPath === SAVED_FILTERS_FILE)
      plan.savedFilters = planSavedFilters(c, plan.conflicts);
    else if (thumbOf) {
      if (!movedOut.has(thumbOf))
        (plan.thumbnails ??= []).push({
          id: thumbOf,
          before: c.before === null ? null : Buffer.from(c.before, 'base64'),
          after: c.after === null ? null : Buffer.from(c.after, 'base64'),
        });
    } else if (id && ITEM_FILE.test(c.relPath) && !movedOut.has(id))
      itemChanges.push({ ...c, itemId: id });
  }

  for (let i = 0; i < itemChanges.length; i += READ_BATCH) {
    const done = await Promise.all(
      itemChanges.slice(i, i + READ_BATCH).map((c) => planItem(c, current)),
    );
    for (const d of done) {
      if (d.item) plan.items.push(d.item);
      plan.conflicts.push(...d.conflicts);
    }
  }

  if (rootChange) {
    const before = parse(rootChange.before);
    const after = parse(rootChange.after);
    if (!before || !after) {
      plan.conflicts.push({
        id: ROOT_FILE,
        field: 'folders',
        reason: 'the saved copy could not be read',
      });
    } else {
      const dryRun = structuredClone((await current.readRoot()).value) as Rec;
      const found: Conflict[] = [];
      if (undoRoot(dryRun, before, after, found))
        plan.root = (root) => undoRoot(root as Rec, before, after, []);
      plan.conflicts.push(...found);
    }
  }
  return plan;
}

async function planItem(
  c: GroupChange & { itemId: string },
  current: CurrentState,
): Promise<{ item?: UndoPlan['items'][number]; conflicts: Conflict[] }> {
  const id = c.itemId;
  const now = await current.readItem(id);

  if (c.before === null) {
    // The group created this item (an import, or one the partner added): undo trashes it, never deletes.
    if (!now || now.value.isDeleted) return { conflicts: [] };
    return {
      item: {
        id,
        apply: (rec) => {
          if (rec.isDeleted) return false;
          rec.isDeleted = true;
          rec.deletedTime = Date.now();
          return true;
        },
      },
      conflicts: [],
    };
  }

  if (!now) return { conflicts: [{ id, field: 'item', reason: 'no longer exists' }] };
  const before = parse(c.before);
  const after = parse(c.after);
  if (!before || !after)
    return {
      conflicts: [
        {
          id,
          field: 'item',
          reason:
            c.after === null
              ? 'the file was removed and no copy was kept'
              : 'the saved copy could not be read',
        },
      ],
    };

  const dry = undoItem(structuredClone(now.value) as Rec, before, after);
  const conflicts = dry.conflicts.map((field) => ({ id, field, reason: CHANGED_SINCE }));
  if (!dry.changed && dry.renameTo === undefined) return { conflicts };
  return {
    item: {
      id,
      apply: (rec) => undoItem(rec as Rec, before, after).changed,
      ...(dry.renameTo !== undefined ? { renameTo: dry.renameTo } : {}),
    },
    conflicts,
  };
}

/**
 * tags.json: each list (starred, recent) undone set-wise like an item's tags, so a star added since
 * stays; any other key only if it still holds what the group wrote. Conflicts are found against the
 * fresh file at write time, so they land in `conflicts` then.
 */
function planTagsFile(c: GroupChange, conflicts: Conflict[]): (file: EagleTagsFile) => boolean {
  const before = parse(c.before) ?? { historyTags: [], starredTags: [] }; // it didn't exist
  const after = parse(c.after) ?? {};
  return (file) => {
    const rec = file as Rec;
    let changed = false;
    for (const key of unionKeys(before, after)) {
      if (same(before[key], after[key])) continue;
      if (Array.isArray(before[key]) || Array.isArray(after[key])) {
        if (undoSet(rec, key, before[key], after[key])) changed = true;
      } else if (same(rec[key], after[key])) {
        setOrDelete(rec, key, before[key]);
        changed = true;
      } else conflicts.push({ id: TAGS_FILE, field: key, reason: CHANGED_SINCE });
    }
    return changed;
  };
}

/**
 * saved-filters.json: exactly the old list if nobody changed it since; otherwise entry by entry
 * (an entry is its exact JSON). An edited filter (the same name, removed and added) is put back in
 * its place if it is still as the group left it, else reported, never added again beside the
 * newer one (review5 should-fix 2). The group's new entries come out if still there, its removed
 * ones go back at their old place. A pure reorder is undone only if the list is still as it left it.
 */
function planSavedFilters(
  c: GroupChange,
  conflicts: Conflict[],
): (list: EagleSavedFilter[]) => boolean {
  const before = parseList(c.before);
  const after = parseList(c.after);
  const key = (e: unknown) => JSON.stringify(e);
  return (list) => {
    if (same(list, after)) {
      if (same(list, before)) return false;
      list.splice(0, list.length, ...structuredClone(before));
      return true;
    }
    const beforeKeys = new Set(before.map(key));
    const afterKeys = new Set(after.map(key));
    let added = after.filter((e) => !beforeKeys.has(key(e)));
    let removed = before.flatMap((e, i) => (afterKeys.has(key(e)) ? [] : [{ e, i }]));
    const reorderOnly = !added.length && !removed.length;
    let changed = false;
    // Edits: one removed and one added entry with the same name.
    for (const r of [...removed]) {
      const edited = added.find((a) => a.name === r.e.name);
      if (!edited) continue;
      added = added.filter((a) => a !== edited);
      removed = removed.filter((x) => x !== r);
      const at = list.findIndex((x) => key(x) === key(edited));
      if (at < 0)
        conflicts.push({ id: SAVED_FILTERS_FILE, field: r.e.name, reason: CHANGED_SINCE });
      else {
        list.splice(at, 1, structuredClone(r.e));
        changed = true;
      }
    }
    for (const e of added) {
      const at = list.findIndex((x) => key(x) === key(e));
      if (at >= 0) {
        list.splice(at, 1);
        changed = true;
      } else conflicts.push({ id: SAVED_FILTERS_FILE, field: e.name, reason: CHANGED_SINCE });
    }
    for (const { e, i } of removed) {
      if (list.some((x) => key(x) === key(e))) continue;
      list.splice(Math.min(i, list.length), 0, structuredClone(e));
      changed = true;
    }
    if (reorderOnly)
      conflicts.push({ id: SAVED_FILTERS_FILE, field: 'order', reason: CHANGED_SINCE });
    return changed;
  };
}

function parseList(text: string | null): EagleSavedFilter[] {
  try {
    const v: unknown = text === null ? [] : JSON.parse(text);
    return Array.isArray(v) ? (v as EagleSavedFilter[]) : [];
  } catch {
    return [];
  }
}

function parse(text: string | null): Rec | null {
  if (text === null) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null;
  } catch {
    return null;
  }
}
