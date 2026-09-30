// The reference window's keys. It has no command registry (it is its own small page), so the keys
// live here. They mean what they mean in the detail view (Shift+H or Shift+F flip, Ctrl+Alt+G gray,
// Shift+R rotate, the Ctrl zoom keys, Left/Right or A/D step), and the window's older single keys
// (H, G, R, 1-9 and 0 for opacity) stay as shortcuts.

export type RefAction =
  | 'close'
  | 'zoomIn'
  | 'zoomOut'
  | 'actual'
  | 'fit'
  | 'flip'
  | 'gray'
  | 'rotate'
  | 'prev'
  | 'next'
  | 'first'
  | 'last'
  | { opacity: number };

const KEYS: Record<string, RefAction> = {
  Escape: 'close',
  'Ctrl+=': 'zoomIn',
  'Ctrl++': 'zoomIn',
  'Ctrl+Shift++': 'zoomIn',
  'Ctrl+-': 'zoomOut',
  'Ctrl+0': 'actual',
  'Ctrl+9': 'fit',
  'Shift+H': 'flip',
  'Shift+F': 'flip',
  H: 'flip',
  'Ctrl+Alt+G': 'gray',
  G: 'gray',
  'Shift+R': 'rotate',
  R: 'rotate',
  ArrowLeft: 'prev',
  A: 'prev',
  ArrowRight: 'next',
  D: 'next',
  Home: 'first',
  End: 'last',
};

/** What a key string (lib/commands keyString) does here, or null for nothing. */
export function refAction(key: string): RefAction | null {
  if (/^[1-9]$/.test(key)) return { opacity: Number(key) / 10 };
  if (key === '0') return { opacity: 1 };
  return KEYS[key] ?? null;
}

/**
 * The ids the window steps through, the opened one included: the app's list (Electron's preload
 * reads it from the window URL), else the page's own `items` parameter (the web dev server).
 */
export function stepList(
  itemId: string | null,
  fromApp: string[] | undefined,
  search: string,
): string[] {
  const list = fromApp?.length
    ? fromApp
    : (new URLSearchParams(search).get('items')?.split(',').filter(Boolean) ?? []);
  if (!itemId) return list;
  return list.includes(itemId) ? list : [itemId, ...list];
}
