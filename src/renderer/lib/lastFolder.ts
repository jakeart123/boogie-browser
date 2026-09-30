// The folder the last "add to folder" used, for Shift+D (repeat on the selection). Remembered per
// library so it survives a restart.
import { editItems } from './edit';
import { plural, quoted } from './format';
import { readJSON, writeJSON } from './storage';
import { library } from './stores/library.svelte';
import { selection } from './stores/selection.svelte';

const key = () => `lastFolder.${library.state?.ref.id ?? 'none'}`;

export function rememberFolder(id: string): void {
  writeJSON(key(), id);
}

/** The remembered folder id, if it still exists in the open library. */
export function lastFolderId(): string | null {
  const id = readJSON<unknown>(key(), null);
  return typeof id === 'string' && library.folders.has(id) ? id : null;
}

export async function addToLastFolder(): Promise<void> {
  const id = lastFolderId();
  if (!id) return;
  const ids = [...selection.ids];
  const name = library.folder(id)?.node.name ?? 'the folder';
  await editItems(
    ids,
    { addFolders: [id] },
    { done: `Added ${plural(ids.length, 'item')} to ${quoted(name)}` },
  );
}
