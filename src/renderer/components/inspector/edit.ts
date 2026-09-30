// The inspector's edits: the shared rules (read-only, bulk confirm, toasts) from lib/edit, plus
// showing the result at once, since the change event from the core can arrive a moment later.
import { api } from '../../lib/api';
import { canEdit, editItems, mutate } from '../../lib/edit';
import { plural } from '../../lib/format';
import type { FolderPatch, ItemPatch } from '../../../shared/types';
import { selected } from './model.svelte';

export interface EditOptions {
  /** What is about to happen, naming the items: "add the tag Flesh Tones to 600 items". */
  what: string;
  /** A toast (with Undo) once it's done. Most inspector edits are quiet. */
  done?: string;
  /** Ask even for a small batch (one typed value about to overwrite many different ones). */
  always?: boolean;
}

/** Patch items. True if it went through. */
export async function editSelected(
  ids: string[],
  patch: ItemPatch,
  o: EditOptions,
): Promise<boolean> {
  const r = await editItems(ids, patch, o);
  if (r) await selected.refresh(ids);
  return !!r;
}

export async function editFolder(id: string, patch: FolderPatch): Promise<boolean> {
  if (!canEdit()) return false;
  return !!(await mutate(() => api.updateFolder(id, patch)));
}

export async function restoreItems(ids: string[]): Promise<void> {
  if (!ids.length || !canEdit()) return;
  if (await mutate(() => api.restoreItems(ids), `Restored ${plural(ids.length, 'item')}`))
    await selected.refresh(ids);
}
