// View preferences you change as you browse (zoom, layout, names...). They're app settings, so
// each change is saved. Only these user actions save; nothing saves on its own at startup, so a
// slow first load can never write the defaults over your settings.
import { writeJSON } from './storage';
import { library } from './stores/library.svelte';
import { view } from './stores/view.svelte';
import type { AppSettings } from '../../shared/types';

export const ZOOM_MIN = 80;
export const ZOOM_MAX = 400;

function save(patch: Partial<AppSettings>): void {
  void library
    .updateSettings(patch)
    .catch((e) => console.warn('Could not save the view setting', e));
}

let zoomTimer: ReturnType<typeof setTimeout> | undefined;

/** The slider, Ctrl+wheel and Ctrl+= / Ctrl+-. Saved once you stop (500 ms). */
export function setThumbSize(size: number): void {
  const next = Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, size)));
  if (next === view.thumbSize) return;
  view.thumbSize = next;
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => save({ thumbSize: next }), 500);
}

export const zoomBy = (delta: number) => setThumbSize(view.thumbSize + delta);

export const LAYOUTS: { id: AppSettings['layout']; label: string }[] = [
  { id: 'justified', label: 'Justified' },
  { id: 'masonry', label: 'Waterfall' },
  { id: 'grid', label: 'Grid' },
  { id: 'list', label: 'List' },
];

export function setLayout(layout: AppSettings['layout']): void {
  view.layout = layout;
  save({ layout });
}

export function toggleNames(): void {
  view.showNames = !view.showNames;
  save({ showNames: view.showNames });
}

export function toggleMeta(): void {
  view.showMeta = !view.showMeta;
  save({ showMeta: view.showMeta });
}

export function toggleSubfolders(): void {
  const on = !view.showSubfolderContents;
  view.showSubfolderContents = on;
  save({ showSubfolderContents: on });
  // A folder already on screen switches over without becoming a new step in the back list.
  if (view.scope.kind === 'folder') {
    view.scope = { ...view.scope, includeSubfolders: on };
    view.run(0);
  }
}

export function toggleChecker(): void {
  view.checker = !view.checker;
  writeJSON('gridChecker', view.checker);
}
