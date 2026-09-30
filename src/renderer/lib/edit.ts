// One way to change the library from the UI. Every edit goes through here, so the read-only rule,
// the bulk confirmation, errors, the core's warnings and the Undo button behave the same
// everywhere.
//
// The Undo rule: a change that announces itself with a toast offers Undo in that toast whenever it
// made a history entry. Quiet edits (a rating key, a field in the inspector) show no toast; Ctrl+Z
// and the History tab undo those. Destructive changes (trash, remove from a folder, delete, merge)
// always announce themselves, so they always offer Undo.
import { api } from './api';
import { plural } from './format';
import { chainRoot } from './history';
import { library } from './stores/library.svelte';
import { ui } from './stores/ui.svelte';
import type { ItemPatch, MutationResult, UndoResult } from '../../shared/types';

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** An error toast. */
export function fail(e: unknown, prefix = ''): void {
  ui.toast(prefix + errorText(e), { kind: 'error' });
}

/** "Read-only: <reason>" while the library can't be edited (for tooltips), else undefined. */
export function readOnlyTip(): string | undefined {
  if (!library.readOnly) return undefined;
  return `Read-only: ${library.state?.readOnlyReason ?? 'This library can’t be edited.'}`;
}

/** False (after a toast saying why) when the library can't be edited. Call before any edit. */
export function canEdit(): boolean {
  const tip = readOnlyTip();
  if (!tip) return true;
  ui.toast(tip, { kind: 'warn' });
  return false;
}

/**
 * Ask before one action touches more items than the bulk threshold (settings, default 500).
 * `what` finishes "This will ..." ("add the tag X to 600 items"); `always` asks for any batch of
 * two or more (one typed value about to overwrite many different ones).
 */
export async function confirmBulk(
  count: number,
  opts: { what?: string; always?: boolean } = {},
): Promise<boolean> {
  const limit = library.settings?.bulkConfirmThreshold ?? 500;
  if (count <= limit && !(opts.always && count > 1)) return true;
  const body = opts.what
    ? `This will ${opts.what}. You can undo it from History.`
    : `This changes more than ${limit.toLocaleString()} items at once. You can undo it from History.`;
  return ui.confirm(`Change ${plural(count, 'item')}?`, body, 'Continue');
}

/**
 * Show what a finished change has to say: the core's warning, skipped items, and `done` with Undo.
 * `undoable: false` for changes History can't take back (tags.json, saved-filters.json): no Undo.
 */
export function report(r: MutationResult, done?: string, undoable = true): void {
  if (r.warning) ui.toast(r.warning, { kind: 'warn', ms: 9000 });
  // An item that already was that way (a rating key pressed twice) is no problem worth a warning.
  const skipped = r.skipped.filter((x) => x.kind !== 'unchanged');
  if (skipped.length)
    ui.toast(`${plural(skipped.length, 'item')} skipped: ${skipped[0].reason}`, {
      kind: 'warn',
    });
  if (!done || !(r.changed > 0 || r.groupId)) return;
  if (undoable) toastWithUndo(done, r.groupId);
  else ui.toast(done, { kind: 'ok' });
}

/** A success toast that offers Undo when there is a history entry to undo. */
export function toastWithUndo(text: string, groupId: string | null | undefined): void {
  const id = groupId ?? null;
  ui.toast(text, {
    kind: 'ok',
    ms: id ? 8000 : 4000,
    action: id ? { label: 'Undo', run: () => void undo(id, text) } : undefined,
  });
}

/** Run a change. A failure becomes an error toast and null; see `report` for the rest. */
export async function mutate(
  run: () => Promise<MutationResult>,
  done?: string,
  opts: { undoable?: boolean } = {},
): Promise<MutationResult | null> {
  try {
    const r = await run();
    report(r, done, opts.undoable ?? true);
    return r;
  } catch (e) {
    fail(e);
    return null;
  }
}

/** api.updateItems behind the read-only check and the bulk confirm. Null when nothing was done. */
export async function editItems(
  ids: string[],
  patch: ItemPatch,
  opts: { done?: string; what?: string; always?: boolean } = {},
): Promise<MutationResult | null> {
  if (!ids.length || !canEdit()) return null;
  if (!(await confirmBulk(ids.length, opts))) return null;
  return mutate(() => api.updateItems(ids, patch), opts.done);
}

// ── undo / redo ──

/**
 * Undo one history group, or (no id) your latest action, and say what happened. `label` names the
 * change for the toast ("Undid: <label>"); without it the history is asked. Undoing an undo brings
 * the change back, so the History tab passes verb 'Redid' for those. Returns null on an error.
 */
export async function undo(
  groupId?: string,
  label?: string,
  verb: 'Undid' | 'Redid' = 'Undid',
): Promise<UndoResult | null> {
  try {
    const r = await api.undo(groupId);
    await reportUndo(r, label, verb);
    return r;
  } catch (e) {
    fail(e);
    return null;
  }
}

export async function redo(): Promise<UndoResult | null> {
  try {
    const r = await api.redo();
    await reportUndo(r, undefined, 'Redid');
    return r;
  } catch (e) {
    fail(e);
    return null;
  }
}

async function reportUndo(r: UndoResult, label: string | undefined, verb: 'Undid' | 'Redid') {
  if (!r.groupId && r.reverted === 0) {
    ui.toast(verb === 'Undid' ? 'Nothing to undo' : 'Nothing to redo', { key: 'undo' });
  } else {
    label ??= await undoneLabel(r.groupId);
    // Undo, redo, undo: one toast that says where you are now, not a stack of them.
    ui.toast(label ? `${verb}: ${label}` : `${verb} ${plural(r.reverted, 'change')}`, {
      kind: 'ok',
      key: 'undo',
    });
  }
  if (r.conflicts.length) ui.toast(conflictText(r.conflicts), { kind: 'warn', ms: 9000 });
}

/**
 * Why an undo or redo left changes alone, from the core's reasons: "2 changes left alone: edited
 * after this action." or "1 change left alone: the earlier thumbnail wasn't kept, so the new one
 * stays (and 1 other reason)."
 */
export function conflictText(conflicts: UndoResult['conflicts']): string {
  const reasons = [
    ...new Set(
      conflicts.map((c) => (c.reason === 'changed since' ? 'edited after this action' : c.reason)),
    ),
  ];
  const more = reasons.length > 1 ? ` (and ${plural(reasons.length - 1, 'other reason')})` : '';
  return `${plural(conflicts.length, 'change')} left alone: ${reasons[0]}${more}.`;
}

/** What the new undo group reversed, named by the action at the start of its chain. */
async function undoneLabel(undoGroupId: string | null): Promise<string | undefined> {
  if (!undoGroupId) return undefined;
  try {
    const list = await api.listHistory({ limit: 50 });
    const entry = list.find((e) => e.groupId === undoGroupId);
    const { root, depth } = entry ? chainRoot(entry, list) : { root: null, depth: 0 };
    return depth ? root?.label : undefined;
  } catch {
    return undefined;
  }
}
