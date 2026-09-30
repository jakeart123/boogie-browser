// The app-wide commands: keys and palette entries that belong to no one panel. Registered once
// by App.svelte. Split by what they act on: the window, the selected items, the library.
import { registerCommands } from '../commands.svelte';
import { itemCommands } from './items';
import { libraryCommands } from './library';
import { windowCommands } from './window';

export { emptyTrash, newFolder } from './library';
export { openSearch, toggleCommandBar } from './window';

export function registerAppCommands(): () => void {
  return registerCommands([...windowCommands(), ...itemCommands(), ...libraryCommands()]);
}
