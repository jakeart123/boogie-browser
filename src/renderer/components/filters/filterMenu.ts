// The "+ Filter" menu (Ctrl+Shift+F), shared by the filter bar and the toolbar's funnel button.
import { openMenuBelow } from '../../lib/contextMenu.svelte';
import type { DateField, PopoverKind } from './chips';
import { filterUi } from './filterUi.svelte';

/** The filters you can add, for the + Filter menu and the saved filters popover. */
export const MENU: { kind: PopoverKind; label: string; keys?: string; field?: DateField }[] = [
  { kind: 'tags', label: 'Tags', keys: 'Alt T' },
  { kind: 'color', label: 'Color', keys: 'Alt C' },
  { kind: 'shape', label: 'Shape and aspect ratio', keys: 'Alt S' },
  { kind: 'rating', label: 'Rating', keys: 'Alt R' },
  { kind: 'type', label: 'File type', keys: 'Alt E' },
  { kind: 'date', label: 'Date imported', keys: 'Alt D' },
  { kind: 'date', label: 'Date modified', field: 'modifiedAt' },
  { kind: 'size', label: 'File size' },
  { kind: 'dimensions', label: 'Dimensions' },
  { kind: 'duration', label: 'Duration' },
  { kind: 'urlnote', label: 'Source URL and notes' },
  { kind: 'folders', label: 'Folders' },
];

export function openFilterMenu(): void {
  openMenuBelow(
    filterUi.menuAnchor(),
    MENU.map((m) => ({
      label: m.label,
      keys: m.keys,
      run: () => filterUi.openPopover(m.kind, filterUi.menuAnchor(), m.field),
    })),
  );
}
