// Thumbnails load only for tiles that stay in the grid's window for a moment, and stop loading
// when their tile goes away. Without this, a fling or a scrollbar drag through 85k items asks the
// main process for tens of thousands of thumbnails, and the screen you stop on waits behind all of
// them (68 s on the Master library).

/** How long a tile must stay in the window before its picture is asked for. */
export const SETTLE_MS = 100;

// Pictures that loaded lately are most likely still in Chromium's memory cache, so a tile scrolled
// back into view shows one at once. Kept small: a long fling back over old tiles must not queue
// their requests again.
const recent = new Set<string>();
const RECENT_MAX = 400;

export function markLoaded(url: string | undefined): void {
  if (!url) return;
  recent.delete(url);
  recent.add(url);
  if (recent.size > RECENT_MAX) recent.delete(recent.values().next().value as string);
}

export function loadedLately(url: string | undefined): boolean {
  return !!url && recent.has(url);
}

/** `<img use:dropSrc>`: a removed image keeps downloading unless its src goes with it. */
export function dropSrc(img: HTMLImageElement) {
  return { destroy: () => img.removeAttribute('src') };
}
