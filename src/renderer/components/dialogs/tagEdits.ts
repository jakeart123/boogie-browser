// The tag manager's changes: each one refreshes the tags and the library state, shows the core's
// warning, and reports a failure inline (the dialog keeps its place) instead of as a toast.
import { api } from '../../lib/api';
import { errorText } from '../../lib/edit';
import { library } from '../../lib/stores/library.svelte';
import { ui } from '../../lib/stores/ui.svelte';
import type { TagGroup } from '../../../shared/types';
import { moveTagToGroup } from './tagManager';

export interface TagEdits {
  run<T extends { warning?: string }>(fn: () => Promise<T>): Promise<T | null>;
  /** Save several groups as one step: one refresh, and one warning if the core has one. */
  saveGroups(list: TagGroup[]): Promise<void>;
  /** Put a tag in a group; it leaves its other groups unless `keep` (Alt held). */
  addToGroup(tag: string, groupId: string, keep?: boolean): Promise<void>;
  removeFromGroup(tag: string, g: TagGroup): Promise<void>;
}

export function tagEdits(setError: (message: string | null) => void): TagEdits {
  const groups = () => library.state?.tagGroups ?? [];

  async function run<T extends { warning?: string }>(fn: () => Promise<T>): Promise<T | null> {
    setError(null);
    try {
      const res = await fn();
      if (res.warning) ui.toast(res.warning, { kind: 'warn' });
      await library.reloadMeta();
      const state = await api.getLibraryState();
      if (state) library.state = state;
      return res;
    } catch (e) {
      setError(errorText(e));
      return null;
    }
  }

  async function saveGroups(list: TagGroup[]): Promise<void> {
    await run(async () => {
      let warning: string | undefined;
      for (const g of list) {
        const res = await api.upsertTagGroup({
          id: g.id,
          name: g.name,
          tags: g.tags,
          color: g.color,
          description: g.description,
        });
        warning ??= res.warning;
      }
      return { warning };
    });
  }

  return {
    run,
    saveGroups,
    addToGroup: (tag, groupId, keep = false) =>
      saveGroups(moveTagToGroup(groups(), tag, groupId, keep)),
    removeFromGroup: (tag, g) => saveGroups([{ ...g, tags: g.tags.filter((t) => t !== tag) }]),
  };
}
