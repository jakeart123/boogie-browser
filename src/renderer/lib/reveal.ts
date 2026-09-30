// The app's `reveal` event: an eagle:// link or the Eagle API's /item, /folder, /smart-folder
// asked to show something. Folders open; an item is selected and scrolled to, in the view you're
// in if it's there, else in its first folder (else All).
import { items } from './stores/items.svelte';
import { library } from './stores/library.svelte';
import { ui } from './stores/ui.svelte';
import { view } from './stores/view.svelte';
import type { BoogieEvents } from '../../shared/api';

export async function revealThing({ kind, id }: BoogieEvents['reveal']): Promise<void> {
  // A link can arrive while the app is still starting (or opening the library it points into):
  // wait for the first view, so starting it doesn't undo what the link asked for.
  await library.ready;
  if (!library.state) return;
  ui.viewer = null;
  if (kind === 'folder') {
    if (!library.folders.has(id)) return void ui.toast('That folder isn’t in this library');
    return view.setScope({ kind: 'folder', id, includeSubfolders: view.showSubfolderContents });
  }
  if (kind === 'smartFolder') {
    if (!library.smartFolders.has(id))
      return void ui.toast('That smart folder isn’t in this library');
    return view.setScope({ kind: 'smartFolder', id });
  }
  const item = await items.loadFull(id).catch(() => null);
  if (!item) return void ui.toast('That item isn’t in this library');
  if (!view.result?.ids.includes(id)) {
    const folder = item.folders.find((f) => library.folders.has(f));
    const scope = item.isDeleted
      ? ({ kind: 'trash' } as const)
      : folder
        ? ({ kind: 'folder', id: folder, includeSubfolders: view.showSubfolderContents } as const)
        : ({ kind: 'all' } as const);
    view.setScope(scope);
    if (view.filtered) view.clearFilter(); // same place, but a filter was hiding it
  }
  ui.revealId = id; // the grid selects it and scrolls to it once it's in the result
}
