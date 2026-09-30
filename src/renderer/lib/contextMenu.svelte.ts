// A single right-click menu for the whole app, rendered by lib/ui/ContextMenu.svelte.
//   openContextMenu(e, [{ label: 'Rename', keys: 'F2', run: () => ... }, { separator: true }, ...])
//   openMenuBelow(button, items)   // a menu that hangs from a button
export interface MenuItem {
  label?: string;
  keys?: string; // shown on the right, e.g. 'F2'
  icon?: string; // lucide icon name (optional)
  danger?: boolean;
  disabled?: boolean;
  /** Tooltip, e.g. why the item is disabled ("Read-only: ..."). */
  title?: string;
  /** A CSS color drawn as a small dot before the label (folder colors). */
  swatch?: string;
  separator?: boolean;
  checked?: boolean;
  submenu?: MenuItem[];
  run?: () => unknown;
}

class ContextMenuStore {
  open = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
}

export const contextMenu = new ContextMenuStore();

export function openContextMenu(e: MouseEvent, items: MenuItem[]): void {
  e.preventDefault();
  e.stopPropagation();
  openContextMenuAt(e.clientX, e.clientY, items);
}

/** Open at a point in the window (the menu keeps itself on screen). */
export function openContextMenuAt(x: number, y: number, items: MenuItem[]): void {
  contextMenu.open = { x, y, items };
}

/** Open just under an element, left-aligned with it (toolbar and header buttons). */
export function openMenuBelow(el: Element | null, items: MenuItem[]): void {
  const r = el?.getBoundingClientRect();
  openContextMenuAt(r ? r.left : 200, r ? r.bottom + 4 : 56, items);
}

export function closeContextMenu(): void {
  contextMenu.open = null;
}
