// The little thumbnail mosaics on the subfolder cards: the first three items of each subfolder
// (including its own subfolders). One query per folder, fetched only when its card scrolls into
// view. A mosaic is fetched again only when it could have changed: one of its three items changed,
// or the folder's item count moved (something was added, removed or refiled). A one-minute limit
// covers the rest (a new sort order, say). The query API has no limit, so the ids are cached.
import { api, on } from '../../lib/api';
import { items } from '../../lib/stores/items.svelte';
import { library } from '../../lib/stores/library.svelte';

interface Entry {
  ids: string[];
  /** The folder's deep count when fetched. */
  count: number | undefined;
  at: number;
  stale: boolean;
}

const TTL_MS = 60_000;

class Mosaics {
  /** Bumped when entries arrive or go stale; cards re-check through it. */
  version = $state(0);
  private cache = new Map<string, Entry>();
  private loading = new Set<string>();
  private libId = '';
  private subscribed = false;

  /** The first three item ids of a folder, once loaded. */
  ids(folderId: string): string[] | undefined {
    void this.version;
    return this.cache.get(folderId)?.ids;
  }

  /** Fetch (again) if missing or stale. Reactive: call it from an effect. */
  ensure(folderId: string): void {
    void this.version;
    this.subscribe();
    const lib = library.state?.ref.id ?? '';
    if (lib !== this.libId) {
      this.libId = lib;
      this.cache.clear();
    }
    const hit = this.cache.get(folderId);
    if (this.loading.has(folderId) || (hit && !hit.stale && Date.now() - hit.at < TTL_MS)) return;
    this.loading.add(folderId);
    const count = library.counts?.folders[folderId]?.deep;
    api
      .query({
        scope: { kind: 'folder', id: folderId, includeSubfolders: true },
        filter: {},
        sort: null,
      })
      .then((r) => {
        if (lib !== this.libId) return;
        const ids = r.ids.slice(0, 3);
        items.ensure(ids);
        this.cache.set(folderId, { ids, count, at: Date.now(), stale: false });
        this.version++;
      })
      .catch(() => {
        // A card without a picture is fine; try again next time it scrolls into view.
      })
      .finally(() => this.loading.delete(folderId));
  }

  private markStale(test: (id: string, e: Entry) => boolean): void {
    let any = false;
    for (const [id, e] of this.cache)
      if (!e.stale && test(id, e)) {
        e.stale = true;
        any = true;
      }
    if (any) this.version++;
  }

  private subscribe(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    on('itemsChanged', ({ ids }) => {
      const changed = new Set(ids);
      this.markStale((_, e) => e.ids.some((id) => changed.has(id)));
    });
    on('counts', (c) => this.markStale((id, e) => c.folders[id]?.deep !== e.count));
  }
}

export const mosaics = new Mosaics();
