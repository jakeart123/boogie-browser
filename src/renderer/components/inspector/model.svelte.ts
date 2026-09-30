// The items the inspector shows: the current selection, loaded in full.
import { untrack } from 'svelte';
import { api, on } from '../../lib/api';
import { errorText } from '../../lib/edit';
import { items } from '../../lib/stores/items.svelte';
import type { Item } from '../../../shared/types';

/** Selecting all of a big library must not pull 85k full records into the inspector. */
export const MAX_LOADED = 1000;

class SelectedItems {
  /** Loaded items, in selection order (at most MAX_LOADED). */
  list = $state.raw<Item[]>([]);
  /** The selection `list` belongs to. Anything rendered from `list` must check it matches `selection.ids`. */
  forIds = $state.raw<string[] | null>(null);
  truncated = $state(false);
  error = $state<string | null>(null);

  private seq = 0;

  /** Follow a new selection. Uses the shared item cache when it has everything, so paging with the arrow keys doesn't flash. */
  async load(ids: string[]): Promise<void> {
    const seq = ++this.seq;
    const want = ids.slice(0, MAX_LOADED);
    this.truncated = ids.length > MAX_LOADED;
    const cached = untrack(() => want.map((id) => (items.stale(id) ? undefined : items.full(id))));
    if (cached.every((x): x is Item => !!x)) {
      this.list = cached;
      this.forIds = ids;
      this.error = null;
      return;
    }
    try {
      const got = await items.loadFulls(want);
      if (seq !== this.seq) return;
      this.list = got;
      this.error = null;
    } catch (e) {
      if (seq !== this.seq) return;
      this.list = [];
      this.error = errorText(e);
    }
    this.forIds = ids;
  }

  /** Re-read the loaded items among `changed` (an edit, or news from disk). Items that are gone drop out. */
  async refresh(changed: string[]): Promise<void> {
    const have = new Set(this.list.map((i) => i.id));
    const mine = changed.filter((id) => have.has(id));
    if (!mine.length) return;
    const seq = this.seq;
    try {
      const fresh = new Map((await api.getItems(mine)).map((i) => [i.id, i]));
      if (seq !== this.seq) return;
      const asked = new Set(mine);
      this.list = this.list.flatMap((it) =>
        asked.has(it.id) ? (fresh.has(it.id) ? [fresh.get(it.id)!] : []) : [it],
      );
    } catch {
      /* keep showing what we have */
    }
  }

  /** Listen for changes while the inspector is mounted. Returns the stop function. */
  start(): () => void {
    const offs = [
      on('itemsChanged', (p) => void this.refresh(p.ids)),
      on('itemsRemoved', (p) => void this.refresh(p.ids)),
    ];
    return () => offs.forEach((off) => off());
  }
}

export const selected = new SelectedItems();
