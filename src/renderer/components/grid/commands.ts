// The grid's keyboard shortcuts and palette entries. Registered by Grid.svelte on mount.
import { registerCommands, type Command, type CommandContext } from '../../lib/commands.svelte';
import { contextMenu } from '../../lib/contextMenu.svelte';
import {
  copyItems,
  copyLink,
  copyPaths,
  exportItems,
  openReference,
  openSource,
  pasteFromClipboard,
} from '../../lib/files';
import { zoomBy } from '../../lib/prefs';
import { selection } from '../../lib/stores/selection.svelte';
import { copyTags, pasteTags } from '../../lib/tags';
import { ui } from '../../lib/stores/ui.svelte';
import { view } from '../../lib/stores/view.svelte';
import * as act from './actions';

export type Move = 'left' | 'right' | 'up' | 'down' | 'home' | 'end' | 'pageUp' | 'pageDown';

/** The bits that need the layout, so they live in Grid.svelte. */
export interface GridNav {
  move(dir: Move, extend: boolean): void;
  selectAll(): void;
  reshuffle(): void;
}

/**
 * Keys belong to the grid only while nothing else (viewer, dialog, picker, right-click menu) has
 * taken over. The palette judges these from the region it was opened from, so they show up there,
 * also when it was opened while typing in the inspector (the selection is the same; key presses
 * in an inspector field never get here, they are typing).
 */
const active = (c: CommandContext) =>
  (c.region === 'grid' || c.region === 'inspector') &&
  !ui.viewer &&
  !ui.dialog &&
  !ui.picker &&
  !contextMenu.open;
const hasSel = (c: CommandContext) => active(c) && selection.count > 0;
const inTrash = () => view.scope.kind === 'trash';
const ids = () => [...selection.ids];

export function registerGridCommands(nav: GridNav): () => void {
  const moves: [Move, string[], string][] = [
    ['left', ['ArrowLeft', 'A'], 'Move left'],
    ['right', ['ArrowRight', 'D'], 'Move right'],
    ['up', ['ArrowUp'], 'Move up'],
    ['down', ['ArrowDown'], 'Move down'],
    ['home', ['Home'], 'Go to first item'],
    ['end', ['End'], 'Go to last item'],
    ['pageUp', ['PageUp'], 'Page up'],
    ['pageDown', ['PageDown'], 'Page down'],
  ];
  const movement: Command[] = moves.flatMap(([dir, keys, title]) => {
    const extendKeys = keys.filter((k) => k.length > 1).map((k) => `Shift+${k}`); // Shift+A is not a thing
    return [
      {
        id: `grid.${dir}`,
        title,
        keys,
        group: 'Selection',
        hidden: true,
        repeat: true,
        when: active,
        run: () => nav.move(dir, false),
      },
      {
        id: `grid.${dir}.extend`,
        title: `${title} and extend selection`,
        keys: extendKeys,
        group: 'Selection',
        hidden: true,
        repeat: true,
        when: active,
        run: () => nav.move(dir, true),
      },
    ];
  });

  const ratings: Command[] = [];
  for (let n = 0; n <= 5; n++) {
    const title = n === 0 ? 'Clear rating' : `Rate ${n} ${n === 1 ? 'star' : 'stars'}`;
    ratings.push({
      id: `grid.rate.${n}`,
      title,
      keys: [String(n)],
      group: 'Rating',
      when: hasSel,
      run: () => void act.rate(ids(), n),
    });
    if (n > 0) {
      ratings.push({
        id: `grid.rateNext.${n}`,
        title: `${title} and go to next`,
        keys: [`Shift+${n}`],
        group: 'Rating',
        hidden: true,
        when: hasSel,
        run: () => {
          const picked = ids();
          void act.rate(picked, n);
          nav.move('right', false);
        },
      });
    }
  }

  return registerCommands([
    ...movement,
    ...ratings,
    {
      id: 'grid.selectAll',
      title: 'Select all',
      keys: ['Ctrl+A'],
      group: 'Selection',
      when: active,
      run: () => nav.selectAll(),
    },
    {
      id: 'grid.clearSelection',
      title: 'Clear selection',
      keys: ['Escape'],
      group: 'Selection',
      when: hasSel,
      run: () => selection.clear(),
    },
    {
      id: 'grid.open',
      title: 'Open item',
      keys: ['Enter'],
      group: 'Items',
      hidden: true,
      when: (c) => active(c) && !!selection.primary,
      run: () => act.openViewer('detail', selection.primary!),
    },
    {
      id: 'grid.quickLook',
      title: 'Quick look',
      keys: ['Space'],
      group: 'Items',
      when: (c) => active(c) && !!selection.primary,
      run: () => act.openViewer('quicklook', selection.primary!),
    },
    {
      id: 'grid.reference',
      title: 'Open in reference window',
      keys: ['Ctrl+O'],
      group: 'Items',
      when: (c) => active(c) && !!selection.primary,
      run: () => void openReference(selection.primary!),
    },
    {
      id: 'grid.openSource',
      title: 'Open source URL',
      keys: ['Ctrl+Shift+O'],
      group: 'Items',
      when: (c) => active(c) && !!selection.primary,
      run: () => void openSource(selection.primary!),
    },
    {
      id: 'grid.copy',
      title: 'Copy',
      keys: ['Ctrl+C'],
      group: 'Items',
      when: hasSel,
      run: () => void copyItems(ids()),
    },
    {
      id: 'grid.copyPath',
      title: 'Copy file path',
      group: 'Items',
      when: hasSel,
      run: () => void copyPaths(ids()),
    },
    {
      id: 'grid.export',
      title: 'Export selected…',
      keys: ['Ctrl+Shift+E'],
      group: 'Items',
      icon: 'upload',
      when: hasSel,
      run: () => exportItems(selection.inOrder(view.result?.ids)),
    },
    {
      id: 'grid.copyLink',
      title: 'Copy link',
      group: 'Items',
      icon: 'link',
      when: hasSel,
      run: () => void copyLink('item', selection.inOrder(view.result?.ids)),
    },
    {
      id: 'grid.copyToLibrary',
      title: 'Add to other library…',
      group: 'Items',
      icon: 'copy-plus',
      when: hasSel,
      run: () => ui.openDialog('copyToLibrary', { ids: ids() }),
    },
    {
      id: 'grid.paste',
      title: 'Paste from clipboard',
      keys: ['Ctrl+V'],
      group: 'Items',
      when: active,
      run: () => void pasteFromClipboard(),
    },
    {
      id: 'grid.trash',
      title: 'Move to trash',
      keys: ['Delete'],
      group: 'Items',
      when: (c) => hasSel(c) && !inTrash(),
      run: () => void act.trash(ids()),
    },
    {
      id: 'grid.deleteForever',
      title: 'Delete permanently',
      keys: ['Delete'],
      group: 'Items',
      when: (c) => hasSel(c) && inTrash(),
      run: () => void act.deleteForever(ids()),
    },
    {
      id: 'grid.restore',
      title: 'Restore from trash',
      group: 'Items',
      when: (c) => hasSel(c) && inTrash(),
      run: () => void act.restore(ids()),
    },
    {
      id: 'grid.removeFromFolder',
      title: 'Remove from this folder',
      keys: ['Ctrl+Delete'],
      group: 'Items',
      when: (c) => hasSel(c) && view.scope.kind === 'folder',
      run: () => void act.removeFromFolder(ids()),
    },
    {
      id: 'grid.compare',
      title: 'Compare side by side',
      keys: ['C'],
      group: 'Items',
      when: (c) => active(c) && selection.count >= 2 && selection.count <= 4,
      run: () => act.compare(),
    },
    {
      id: 'grid.moveTo',
      title: 'Move to folder…',
      keys: ['M'],
      group: 'Folders',
      icon: 'folder-input',
      when: hasSel,
      run: () => act.openMoveTo(),
    },
    {
      id: 'grid.copyTags',
      title: 'Copy tags',
      keys: ['Ctrl+Shift+C'],
      group: 'Tags',
      icon: 'copy',
      when: hasSel,
      run: () => void copyTags(ids()),
    },
    {
      id: 'grid.pasteTags',
      title: 'Paste tags',
      keys: ['Ctrl+Shift+V'],
      group: 'Tags',
      icon: 'clipboard-paste',
      when: hasSel,
      run: () => void pasteTags(ids()),
    },
    // Eagle zooms thumbnails with the keypad's + and - too (Ctrl+= and Ctrl+- are global).
    {
      id: 'grid.zoomIn',
      repeat: true,
      title: 'Bigger thumbnails',
      keys: ['+'],
      group: 'View',
      hidden: true,
      when: active,
      run: () => zoomBy(20),
    },
    {
      id: 'grid.zoomOut',
      repeat: true,
      title: 'Smaller thumbnails',
      keys: ['-'],
      group: 'View',
      hidden: true,
      when: active,
      run: () => zoomBy(-20),
    },
    {
      id: 'grid.reshuffle',
      title: 'Shuffle again',
      keys: ['R'],
      group: 'View',
      when: (c) => active(c) && view.scope.kind === 'random',
      run: () => nav.reshuffle(),
    },
  ]);
}
