// App-wide commands for the window: the command bar, going back and forth, the side panels and
// how the grid looks.
import type { Command } from '../commands.svelte';
import { LAYOUTS, setLayout, toggleMeta, toggleNames, toggleSubfolders, zoomBy } from '../prefs';
import { ui } from '../stores/ui.svelte';
import { view } from '../stores/view.svelte';

const ZOOM_STEP = 20;

/** Ctrl+K: toggles the palette. Ctrl+F: opens it with the current keywords ready to edit. */
export function toggleCommandBar(): void {
  if (ui.overlay?.kind === 'command') ui.closeOverlay();
  else ui.openOverlay('command');
}

export function openSearch(): void {
  ui.openOverlay('command', { text: view.filter.keywords ?? '' });
}

function togglePanels(): void {
  const anyVisible = ui.sidebarVisible || ui.inspectorVisible;
  ui.sidebarVisible = ui.inspectorVisible = !anyVisible;
}

export function windowCommands(): Command[] {
  const noDialog = () => !ui.dialog;
  return [
    {
      id: 'app.commandBar',
      title: 'Open the command bar',
      group: 'App',
      icon: 'command',
      keys: ['Ctrl+K'],
      allowInInput: true,
      priority: 10,
      when: noDialog,
      run: toggleCommandBar,
      hidden: true,
    },
    {
      id: 'app.search',
      title: 'Search…',
      group: 'App',
      icon: 'search',
      keys: ['Ctrl+F'],
      allowInInput: true,
      priority: 10,
      when: noDialog,
      run: openSearch,
    },
    {
      id: 'nav.back',
      mainWindow: true,
      title: 'Go back',
      group: 'Navigate',
      keys: ['Alt+ArrowLeft'],
      when: (c) => c.region !== 'overlay' && view.back.length > 0,
      run: () => view.goBack(),
    },
    {
      id: 'nav.forward',
      mainWindow: true,
      title: 'Go forward',
      group: 'Navigate',
      keys: ['Alt+ArrowRight'],
      when: (c) => c.region !== 'overlay' && view.forward.length > 0,
      run: () => view.goForward(),
    },
    {
      id: 'ui.sidebar',
      title: 'Show or hide the sidebar',
      group: 'View',
      icon: 'panel-left',
      keys: ['Ctrl+Alt+1'],
      run: () => (ui.sidebarVisible = !ui.sidebarVisible),
    },
    {
      id: 'ui.inspector',
      title: 'Show or hide the inspector',
      group: 'View',
      icon: 'panel-right',
      keys: ['Ctrl+Alt+2'],
      run: () => (ui.inspectorVisible = !ui.inspectorVisible),
    },
    {
      id: 'ui.panels',
      title: 'Show or hide both side panels',
      group: 'View',
      keys: ['Ctrl+Alt+3'],
      run: togglePanels,
    },
    {
      id: 'view.names',
      title: 'Show or hide names',
      group: 'View',
      keys: ['Ctrl+Alt+4'],
      run: toggleNames,
    },
    {
      id: 'view.meta',
      title: 'Show or hide dimensions',
      group: 'View',
      keys: ['Ctrl+Alt+5'],
      run: toggleMeta,
    },
    {
      id: 'view.subfolders',
      title: 'Show or hide subfolder contents',
      group: 'View',
      keys: ['Ctrl+Alt+7'],
      run: toggleSubfolders,
    },
    {
      id: 'view.grayscale',
      title: 'Grayscale thumbnails',
      group: 'View',
      icon: 'contrast',
      keys: ['Ctrl+Alt+G'],
      // The viewer has its own (it wins while open).
      when: (c) => c.region !== 'overlay' && !ui.viewer,
      run: () => (view.grayscale = !view.grayscale),
    },
    {
      id: 'view.zoomIn',
      repeat: true,
      title: 'Bigger thumbnails',
      group: 'View',
      icon: 'zoom-in',
      keys: ['Ctrl+=', 'Ctrl++', 'Ctrl+Shift++'],
      run: () => zoomBy(ZOOM_STEP),
    },
    {
      id: 'view.zoomOut',
      repeat: true,
      title: 'Smaller thumbnails',
      group: 'View',
      keys: ['Ctrl+-'],
      run: () => zoomBy(-ZOOM_STEP),
    },
    ...LAYOUTS.map((l) => ({
      id: `view.layout.${l.id}`,
      title: `Layout: ${l.label}`,
      group: 'View',
      run: () => setLayout(l.id),
    })),
  ];
}
