// Undo and redo. The journal works out WHAT to change (planUndo, against the current files, so
// it never clobbers a later edit); this file applies the plan as one new group.
import { readFile } from 'node:fs/promises';
import type { Actor, HistoryEntry, UndoResult } from '../../shared/types';
import type { ChangeContext, UndoPlan } from '../contracts';
import { applyWrites, ensureWritable, inOrder, runGroup, writeRoot } from './group';
import { itemsText, quoted } from './labels';
import { loadLibraryFiles } from './state';
import type { Session, Touch } from './types';
import { mapLimit } from './util';

const NOTHING: UndoResult = { groupId: null, reverted: 0, conflicts: [] };

/** Ctrl+Z covers what you did in the app, never a background save by the browser extension or an
 * agent's work (those undo their own, or you pick them in History). */
const sameActor = (a: Actor, b: Actor) => a.kind === b.kind && a.name === b.name;

/** Newest first (the journal's order). */
function recent(s: Session): HistoryEntry[] {
  return s.journal.list(s.ref.id, { limit: 500 });
}

/**
 * An undo is an ordinary group, so it can be undone too (that is how redo works). How many
 * times a group has been "reversed": 0 for a normal action, 1 for an undo of it, 2 for the undo
 * of that undo (a redo), and so on. Odd = its effect is currently reversed, even = applied.
 */
function depthOf(e: HistoryEntry, target: Map<string, HistoryEntry>): number {
  let depth = 0;
  for (
    let cur: HistoryEntry | undefined = e;
    cur?.kind === 'undo' && depth < 50;
    cur = target.get(cur.groupId)
  )
    depth++;
  return depth;
}

/** undo group id -> the group it undid (the journal only stores that link as `undoneBy` on the target). */
function targets(list: HistoryEntry[]): Map<string, HistoryEntry> {
  const byUndoer = new Map<string, HistoryEntry>();
  for (const e of list) if (e.undoneBy) byUndoer.set(e.undoneBy, e);
  return byUndoer;
}

/**
 * What Ctrl+Z reverses: your newest action that is still applied. That is a normal action, or a
 * redo (which re-applied something). Plain undos are markers, not actions: skipped, so a second
 * Ctrl+Z goes further back. If that newest action can't be undone, it is returned anyway (the
 * caller says so) rather than silently undoing an older one behind it (review should-fix 15).
 */
export function findUndoable(list: HistoryEntry[], actor: Actor): HistoryEntry | null {
  const target = targets(list);
  for (const e of list) {
    if (!sameActor(e.actor, actor) || e.undoneBy) continue;
    if (depthOf(e, target) % 2 === 0) return e;
  }
  return null;
}

/**
 * What redo reverses: your newest undo that hasn't been redone yet. Walking back from the newest:
 * a normal action means nothing is left to redo (like any editor, a new action clears redo);
 * a redo just means "keep looking further back" (its own undo is marked done).
 */
export function findRedo(list: HistoryEntry[], actor: Actor): HistoryEntry | null {
  const target = targets(list);
  for (const e of list) {
    if (!sameActor(e.actor, actor) || e.undoneBy) continue;
    const depth = depthOf(e, target);
    if (depth === 0) return null;
    if (depth % 2 === 1) return e;
  }
  return null;
}

/**
 * Finding the target, applying it and marking it undone happen in one hold of the lock (never while
 * another action is part way, and after your own earlier actions), so two quick Ctrl+Z presses undo
 * two different actions.
 */
export function undo(s: Session, actor: Actor, groupId?: string): Promise<UndoResult> {
  ensureWritable(s);
  return inOrder(s, actor, () =>
    s.lock.exclusive(async () => {
      if (groupId) {
        // By id: an entry older than the newest few hundred is still found (review6).
        const known = s.journal.getEntry(groupId);
        if (known?.undoneBy) throw new Error('That change was already undone.');
        if (known && !known.undoable) throw new Error("That change can't be undone.");
        return applyUndo(
          s,
          actor,
          groupId,
          known?.staleOverwrite ? putBackLabel(s, known) : undefined,
        );
      }
      const entry = findUndoable(recent(s), actor);
      if (entry && !entry.undoable)
        throw new Error(`Your last change (${entry.label}) can't be undone.`);
      return entry ? applyUndo(s, actor, entry.groupId) : NOTHING;
    }),
  );
}

export function redo(s: Session, actor: Actor): Promise<UndoResult> {
  ensureWritable(s);
  return inOrder(s, actor, () =>
    s.lock.exclusive(async () => {
      const entry = findRedo(recent(s), actor);
      return entry ? applyUndo(s, actor, entry.groupId) : NOTHING;
    }),
  );
}

/** "Put back your change to “Study”": the undo of a stale-overwrite entry ("Put my change back"). */
export function putBackLabel(s: Session, e: HistoryEntry): string {
  const one = e.itemCount === 1 ? s.index.getRecord(e.itemIds[0] ?? '')?.name : undefined;
  return `Put back ${one !== undefined ? `your change to ${quoted(one)}` : `your changes to ${itemsText(e.itemCount)}`}`;
}

/** Runs inside the lock (undo/redo hold it). Also puts right old copies (partner/outside.ts). */
export async function applyUndo(
  s: Session,
  actor: Actor,
  target: string,
  label?: string,
): Promise<UndoResult> {
  let conflicts: UndoResult['conflicts'] = [];
  let reverted = 0;
  const run = async (ctx: ChangeContext, t: Touch) => {
    // Planned inside the lock, against the files as they are right now.
    const plan = await s.journal.planUndo(target, {
      readItem: (id) => s.lib.readItem(id),
      readRoot: () => s.lib.readRoot(),
    });
    conflicts = plan.conflicts;
    t.label = label ?? plan.label;

    // Folders first, so an item is never written pointing at a folder that isn't in the tree yet.
    if (plan.root) await writeRoot(s, ctx, t, plan.root);

    for (const back of plan.moveBackIn) {
      await s.lib.moveItemIn(back.itemId, back.storedAt, ctx);
      const doc = await s.lib.readItem(back.itemId);
      if (doc) {
        s.index.upsertRecords([doc.value]);
        t.added.add(back.itemId);
      }
    }

    await mapLimit(plan.items, 8, async (item) => {
      applyWrites(s, t, [await s.lib.updateItem(item.id, item.apply, ctx)]);
      if (item.renameTo) applyWrites(s, t, [await s.lib.renameItem(item.id, item.renameTo, ctx)]);
    });
    const files = await undoSmallFiles(s, ctx, plan);
    for (const id of await undoThumbnails(s, ctx, plan)) t.changed.add(id);
    reverted =
      t.changed.size +
      t.added.size +
      (t.root && !t.changed.size && !t.added.size ? 1 : 0) +
      (!t.changed.size && !t.added.size && !t.root ? files : 0);
    // Linked before commit so the history event already carries undoOf. The journal drops the link
    // if the group commits empty, so a fully blocked undo can be tried again.
    s.journal.markUndone(target, ctx.group.id);
  };
  const { entry } = await runGroup(s, actor, 'Undo', 'undo', run, { lock: false });
  return { groupId: entry?.groupId ?? null, reverted, conflicts };
}

/** tags.json and saved-filters.json (a starred tag, a tag rename's fix-up, a saved filter). */
async function undoSmallFiles(s: Session, ctx: ChangeContext, plan: UndoPlan): Promise<number> {
  let done = 0;
  if (plan.tagsFile && (await s.lib.updateTagsFile?.(plan.tagsFile, ctx))) done++;
  if (plan.savedFilters && (await s.lib.updateSavedFilters?.(plan.savedFilters, ctx))) done++;
  if (plan.tagsFile) await loadLibraryFiles(s, 'tags');
  if (plan.savedFilters) await loadLibraryFiles(s, 'savedFilters');
  return done;
}

/**
 * A custom thumbnail's undo: the old picture goes back, only if the item still shows the one the
 * group put there (else it changed since, and is left alone).
 */
async function undoThumbnails(s: Session, ctx: ChangeContext, plan: UndoPlan): Promise<string[]> {
  const done: string[] = [];
  for (const th of plan.thumbnails ?? []) {
    const doc = await s.lib.readItem(th.id);
    if (!doc) continue;
    if (!th.before) {
      // Not kept (a refresh past its journal budget, or a huge picture), or there was none.
      const reason = th.after?.length
        ? 'there was no thumbnail before, so the new one stays'
        : "the earlier thumbnail wasn't kept, so the new one stays";
      plan.conflicts.push({ id: th.id, field: 'thumbnail', reason });
      continue;
    }
    const path = await s.lib.locateThumbnail(th.id, doc.value);
    const now = path ? await readFile(path).catch(() => null) : null;
    if (!now || !th.after?.length || !Buffer.from(th.after).equals(now)) {
      plan.conflicts.push({ id: th.id, field: 'thumbnail', reason: 'changed since' });
      continue;
    }
    // Kept in this group's journal too, so undoing this undo (redo) puts the other picture back.
    await s.lib.writeThumbnail(th.id, doc.value, th.before, ctx, { keepOld: true });
    done.push(th.id);
  }
  return done;
}
