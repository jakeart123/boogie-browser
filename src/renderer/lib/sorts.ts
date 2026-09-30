// Eagle's sort orders with our names for them, shared by the toolbar's sort menu, the list
// headers, the sidebar's "Sort this folder by" menu and the folder editors.
import { api } from './api';
import type { MenuItem } from './contextMenu.svelte';
import { canEdit, mutate } from './edit';
import type { FolderNode, OrderBy, SortSpec } from '../../shared/types';

/** In menu order. `ascending` is the direction a sort starts in when you pick it. */
export const SORTS: { by: OrderBy; label: string; ascending: boolean; folderOnly?: boolean }[] = [
  { by: 'IMPORT', label: 'Date imported', ascending: false },
  { by: 'BTIME', label: 'Date created', ascending: false },
  { by: 'MTIME', label: 'Date modified', ascending: false },
  { by: 'NAME', label: 'Name', ascending: true },
  { by: 'EXT', label: 'Type', ascending: true },
  { by: 'RESOLUTION', label: 'Dimensions', ascending: false },
  { by: 'FILESIZE', label: 'File size', ascending: false },
  { by: 'RATING', label: 'Rating', ascending: false },
  { by: 'DURATION', label: 'Duration', ascending: false },
  { by: 'TAGS', label: 'Number of tags', ascending: false },
  // Literal direction: the top of the manual order (the highest `order` value) comes first.
  { by: 'MANUAL', label: 'Manual order', ascending: false, folderOnly: true },
  { by: 'RANDOM', label: 'Random', ascending: true },
];

export function sortName(by: OrderBy): string {
  return SORTS.find((s) => s.by === by)?.label ?? 'Date imported';
}

/** Text-like sorts start A to Z; dates, sizes and ratings start with the newest or biggest. */
export function defaultAscending(by: OrderBy): boolean {
  return SORTS.find((s) => s.by === by)?.ascending ?? false;
}

/** "Name, ascending"; manual and random orders have no direction. */
export function sortLabel(s: SortSpec): string {
  const name = sortName(s.by);
  return s.by === 'RANDOM' || s.by === 'MANUAL'
    ? name
    : `${name}, ${s.ascending ? 'ascending' : 'descending'}`;
}

// A folder's `sortIncrease` is Eagle's flag, not "ascending": true means Eagle's own order for that
// sort, and Eagle's own order runs newest first (top first for manual) for these four. SortSpec
// `ascending` is literal. The same rule as the core's (src/core/index/query/sorts.ts).
const NEWEST_FIRST: ReadonlySet<OrderBy> = new Set(['IMPORT', 'BTIME', 'MTIME', 'MANUAL']);

/** Literal direction from Eagle's flag. The mapping is its own inverse, so it also goes back. */
export function ascendingFromSortIncrease(by: OrderBy, sortIncrease: boolean): boolean {
  return NEWEST_FIRST.has(by) ? !sortIncrease : sortIncrease;
}
export const sortIncreaseFromAscending = ascendingFromSortIncrease;

/** A folder's own sort, literal (null: the usual newest imported first). Eagle reverses its order
 *  whenever `sortIncrease` isn't true, so a missing flag means reversed. */
export function folderSortSpec(node: FolderNode): SortSpec | null {
  if (!node.orderBy) return null;
  return {
    by: node.orderBy,
    ascending: ascendingFromSortIncrease(node.orderBy, node.sortIncrease === true),
  };
}

/** A folder's own sort in words. */
export function folderSortLabel(node: FolderNode): string {
  const s = folderSortSpec(node);
  return s ? sortLabel(s) : 'Default (newest imported first)';
}

/** Save a folder's own sort; `ascending` is literal (it is written as Eagle's flag). */
export function setFolderSort(id: string, orderBy: OrderBy, ascending: boolean) {
  if (!canEdit()) return Promise.resolve(null);
  const sortIncrease = sortIncreaseFromAscending(orderBy, ascending);
  return mutate(() => api.updateFolder(id, { orderBy, sortIncrease }));
}

/** "Sort this folder by": direction first so a short window never cuts it off, then the orders. */
export function folderSortMenu(node: FolderNode): MenuItem[] {
  const { by, ascending: up } = folderSortSpec(node) ?? { by: 'IMPORT', ascending: false };
  const fixed = by === 'MANUAL' || by === 'RANDOM';
  return [
    {
      label: 'Ascending',
      checked: up,
      disabled: fixed,
      run: () => void setFolderSort(node.id, by, true),
    },
    {
      label: 'Descending',
      checked: !up,
      disabled: fixed,
      run: () => void setFolderSort(node.id, by, false),
    },
    { separator: true },
    ...SORTS.map((o): MenuItem => ({
      label: o.label,
      checked: by === o.by,
      run: () => void setFolderSort(node.id, o.by, o.by === by ? up : o.ascending),
    })),
  ];
}
