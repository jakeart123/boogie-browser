// Saved filters (Eagle's saved-filters.json, which a running Eagle re-reads, so they reach the partner).
// Entries have no ids: the core addresses them by position and checks the name, so every change
// here passes both. Applying one replaces the filter you have.
import { api } from '../../lib/api';
import { canEdit, mutate as change } from '../../lib/edit';
import type { MutationResult } from '../../../shared/types';
import { library } from '../../lib/stores/library.svelte';
import { ui } from '../../lib/stores/ui.svelte';
import { view } from '../../lib/stores/view.svelte';
import type { FilterSpec, SavedFilterInfo } from '../../../shared/types';
import { describeFilter } from './chips';
import { quoted } from '../../lib/format';

export const savedFilters = (): SavedFilterInfo[] => library.state?.savedFilters ?? [];

/** Replace the current filter with a saved one, and say plainly what Boogie can't apply. */
export function applySaved(f: SavedFilterInfo): void {
  view.applyFilter($state.snapshot(f.filter) as FilterSpec);
  if (f.unsupported.length)
    ui.toast(
      `${quoted(f.name)} also filters by ${f.unsupported.join(', ')}, which only works in Eagle.`,
      {
        kind: 'warn',
        ms: 9000,
      },
    );
}

/** "Tags: a, b · Rating: 4+": a name to start from when saving. */
function suggestName(filter: FilterSpec): string {
  const chips = describeFilter(filter, {
    folderName: (id) => library.folder(id)?.node.name ?? 'folder',
  });
  return chips
    .map((c) => c.title)
    .join(' · ')
    .slice(0, 60);
}

/**
 * saved-filters.json changes can't be undone from History (no Undo in the toast). A change that
 * failed (usually "that saved filter changed on disk") reloads the list so it shows what's there.
 */
async function mutate(run: () => Promise<MutationResult>, done?: string): Promise<void> {
  if (await change(run, done, { undoable: false })) return;
  const state = await api.getLibraryState().catch(() => null);
  if (state) library.state = state;
}

export async function saveCurrentFilter(): Promise<void> {
  if (!view.filtered || !canEdit()) return;
  const filter = $state.snapshot(view.filter) as FilterSpec;
  const name = await ui.prompt('Save filter', {
    label: 'Name',
    value: suggestName(filter),
    body: 'Saved filters live in the library, so Eagle gets them too.',
  });
  if (name) await mutate(() => api.saveFilter(name, filter), `Saved the filter ${quoted(name)}`);
}

export async function renameSaved(f: SavedFilterInfo): Promise<void> {
  if (!canEdit()) return;
  const name = await ui.prompt('Rename saved filter', { value: f.name, confirmLabel: 'Rename' });
  if (name && name !== f.name)
    await mutate(
      () => api.updateSavedFilter(f.index, f.name, { name }, f.key),
      `Renamed to ${quoted(name)}`,
    );
}

/** Put the filter you have now into a saved one (its name stays). */
export async function updateSaved(f: SavedFilterInfo): Promise<void> {
  if (!view.filtered || !canEdit()) return;
  const filter = $state.snapshot(view.filter) as FilterSpec;
  await mutate(
    () => api.updateSavedFilter(f.index, f.name, { filter }, f.key),
    `Updated ${quoted(f.name)}`,
  );
}

export async function deleteSaved(f: SavedFilterInfo): Promise<void> {
  if (!canEdit()) return;
  const ok = await ui.confirm(
    `Delete ${quoted(f.name)}?`,
    'Only the saved filter goes. Your items are not touched.',
    'Delete',
    true,
  );
  if (ok)
    await mutate(() => api.deleteSavedFilter(f.index, f.name, f.key), `Deleted ${quoted(f.name)}`);
}

/** Drag to reorder. Name and key let the core find the entry even if Eagle reordered the file. */
export async function moveSaved(f: SavedFilterInfo, to: number): Promise<void> {
  if (f.index === to || !canEdit()) return;
  await mutate(() => api.moveSavedFilter(f.index, to, f.name, f.key));
}
