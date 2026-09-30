// The full record of one item, following the shared cache. Keeps showing the same item while an
// edit refreshes it (no flash), but never shows the previous item's record under a new id.
import { untrack } from 'svelte';
import { items } from '../../lib/stores/items.svelte';
import type { Item } from '../../../shared/types';

/** Call during component setup. `.value`: undefined while loading, null when the item is gone. */
export function useItem(getId: () => string | undefined) {
  let item = $state.raw<Item | null | undefined>(undefined);

  $effect(() => {
    const id = getId();
    void items.version; // re-check after the cache changes (a fetch landed, an edit invalidated it)
    if (!id) {
      item = undefined;
      return;
    }
    const cached = items.full(id);
    if (cached) {
      item = cached; // after an edit, the old record stays up while the new one loads
      if (!items.stale(id)) return;
    } else {
      const held = untrack(() => item);
      if (held && held.id !== id) item = undefined;
    }
    let live = true;
    items.loadFull(id).then(
      (it) => live && (item = it),
      () => live && (item = null),
    );
    return () => {
      live = false;
    };
  });

  return {
    get value() {
      // Right after the id changes, and before the effect above catches up, `item` is still the
      // previous record. Callers render in that gap, so hide it here rather than trusting timing.
      return item && item.id !== getId() ? undefined : item;
    },
  };
}
