// Moving through the list the viewer was opened on (`ui.viewer.ids`).
import { items } from '../../lib/stores/items.svelte';
import { ui } from '../../lib/stores/ui.svelte';
import { viewKind } from '../../lib/fileKinds';

export function currentId(): string | undefined {
  const v = ui.viewer;
  return v ? v.ids[v.index] : undefined;
}

/** Step by `delta`, stopping at the ends. Returns whether it moved. */
export function step(delta: number): boolean {
  const v = ui.viewer;
  if (!v) return false;
  const next = Math.min(v.ids.length - 1, Math.max(0, v.index + delta));
  if (next === v.index) return false;
  ui.viewer = { ...v, index: next };
  return true;
}

export function goTo(index: number): void {
  const v = ui.viewer;
  if (!v) return;
  const next = Math.min(v.ids.length - 1, Math.max(0, index));
  if (next !== v.index) ui.viewer = { ...v, index: next };
}

// Neighbours load ahead so the arrow keys feel instant. Kept referenced so the browser doesn't drop them.
const warm: HTMLImageElement[] = [];

/** The next `ahead` items and the previous one: their records, and their pictures decoded. */
export async function preloadAround(
  index: number,
  ids: readonly string[],
  ahead = 2,
): Promise<void> {
  const at = [index + 1, index - 1];
  for (let k = 2; k <= ahead; k++) at.push(index + k);
  const want = at.map((i) => ids[i]).filter((x): x is string => !!x);
  if (!want.length) return;
  const list = await items.loadFulls(want);
  for (const it of list) {
    if (viewKind(it.ext) !== 'image') continue; // videos, PDFs and fonts have no picture to warm
    const img = new Image();
    img.decoding = 'async';
    // Also for icon-only items (Krita, Illustrator...): that starts Boogie drawing the preview.
    img.src = it.previewUrl;
    warm.push(img);
  }
  // A dropped picture stops downloading (a skipped 40 MB original shouldn't finish in the background).
  while (warm.length > 8) warm.shift()!.removeAttribute('src');
}
