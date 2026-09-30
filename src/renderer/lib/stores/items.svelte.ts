// Cache of item briefs (for tiles) and full items (for the inspector/viewer).
// Components read `items.brief(id)`; it is reactive through `version`.
// An edit marks the records stale and fetches them again, but keeps the old record on screen until
// the new one arrives, so tiles and panels never blink on a rating or a tag.
// Both caches are bounded (least recently used goes first), so scrolling through 85k items doesn't
// keep 85k records: every read or ensure() marks a record as used, and what is selected or open in
// the viewer is never dropped.
import { api, on } from '../api';
import type { Item, ItemBrief } from '../../../shared/types';
import { selection } from './selection.svelte';
import { ui } from './ui.svelte';

/** Briefs are about 1.6 KB each; the grid's window is a few hundred of them. */
export const MAX_BRIEFS = 8000;
/** Full records: the list layout's window, the inspector, the viewer and its neighbours. */
export const MAX_FULLS = 2000;

/** Move a key to the most recently used end (a Map iterates in insertion order). */
function touch<V>(map: Map<string, V>, id: string, v: V): void {
  map.delete(id);
  map.set(id, v);
}

class ItemCache {
  /** Bumped whenever cached data changes; reading brief()/full() subscribes to it. */
  version = $state(0);
  private briefs = new Map<string, ItemBrief>();
  private fulls = new Map<string, Item>();
  private staleBriefs = new Set<string>();
  private staleFulls = new Set<string>();
  private want = new Set<string>();
  private inflight = new Set<string>();
  private fullInflight = new Map<string, Promise<Item | null>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private subscribed = false;
  /** Bumped by clear(), so answers that were on their way for the old library are dropped. */
  private generation = 0;

  brief(id: string): ItemBrief | undefined {
    void this.version;
    const b = this.briefs.get(id);
    if (b) touch(this.briefs, id, b);
    return b;
  }

  /** The full record, possibly stale (see `stale`): fine to show while a fresh one loads. */
  full(id: string): Item | undefined {
    void this.version;
    const f = this.fulls.get(id);
    if (f) touch(this.fulls, id, f);
    return f;
  }

  /** The cached full record changed on disk and needs loadFull/loadFulls to fetch it again. */
  stale(id: string): boolean {
    void this.version;
    return this.staleFulls.has(id);
  }

  /** Ask for briefs (batched). Call with the visible window plus overscan. */
  ensure(ids: string[]): void {
    for (const id of ids) {
      const b = this.briefs.get(id);
      if (b) touch(this.briefs, id, b);
      if ((!b || this.staleBriefs.has(id)) && !this.inflight.has(id)) this.want.add(id);
    }
    this.schedule();
  }

  /** The full record, fetched unless a fresh one is cached (or `force`). One request per id at a time. */
  loadFull(id: string, force = false): Promise<Item | null> {
    const have = this.fulls.get(id);
    if (have && !force && !this.staleFulls.has(id)) return Promise.resolve(have);
    let p = this.fullInflight.get(id);
    if (!p) {
      const gen = this.generation;
      const req: Promise<Item | null> = api
        .getItem(id)
        .then((item) => {
          if (gen !== this.generation) return null; // another library opened meanwhile
          if (item) this.putFull(item);
          return item;
        })
        .finally(() => {
          if (this.fullInflight.get(id) === req) this.fullInflight.delete(id);
        });
      this.fullInflight.set(id, (p = req));
    }
    return p;
  }

  /**
   * Full records for `ids`, all of them even when there are more than the cache keeps (tags for a
   * big selection, an export). A batch that big is answered without filling the cache with it.
   */
  async loadFulls(ids: string[]): Promise<Item[]> {
    const fresh = new Map<string, Item>();
    for (const id of ids) {
      const f = this.fulls.get(id);
      if (f && !this.staleFulls.has(id)) fresh.set(id, f);
    }
    const missing = ids.filter((id) => !fresh.has(id));
    if (missing.length) {
      const gen = this.generation;
      const got = await api.getItems(missing);
      if (gen !== this.generation) return []; // another library opened meanwhile
      const keep = missing.length <= MAX_FULLS / 2;
      for (const it of got) {
        fresh.set(it.id, it);
        if (keep) this.putFull(it, false);
      }
      if (keep) this.trim(this.fulls, MAX_FULLS, this.staleFulls);
      this.version++;
    }
    // One the core no longer has (deleted meanwhile) keeps its last known record, as before.
    return ids.map((id) => fresh.get(id) ?? this.fulls.get(id)).filter((x): x is Item => !!x);
  }

  /** Forget everything (another library opened; its ids may even repeat, with other files). */
  clear(): void {
    this.briefs.clear();
    this.fulls.clear();
    this.staleBriefs.clear();
    this.staleFulls.clear();
    this.want.clear();
    // Requests still out belong to the old library; the new one must be able to ask again.
    this.inflight.clear();
    this.fullInflight.clear();
    this.generation++;
    this.version++;
  }

  /** Records changed on disk: fetch them again, showing the old ones until the new ones arrive. */
  invalidate(ids: string[]): void {
    for (const id of ids) {
      if (this.briefs.has(id) || this.inflight.has(id)) {
        this.staleBriefs.add(id);
        this.want.add(id); // even when a request is on its way: it may carry the old record
      }
      if (this.fulls.has(id)) this.staleFulls.add(id);
    }
    this.version++;
    this.schedule();
  }

  /** Items that left the library (deleted permanently): nothing to fetch. */
  private drop(ids: string[]): void {
    for (const id of ids) {
      this.briefs.delete(id);
      this.fulls.delete(id);
      this.staleBriefs.delete(id);
      this.staleFulls.delete(id);
    }
    this.version++;
  }

  private putFull(item: Item, bump = true): void {
    touch(this.fulls, item.id, item);
    this.staleFulls.delete(item.id);
    if (bump) {
      this.trim(this.fulls, MAX_FULLS, this.staleFulls);
      this.version++;
    }
  }

  /**
   * Over the limit: drop least recently used records down to 80% of it (so this runs once per
   * few hundred new records, not on every one), never one that is selected or open in the viewer.
   * Everything on screen was read on the last render, so it is among the most recently used.
   */
  private trim<V>(map: Map<string, V>, max: number, stale: Set<string>): void {
    if (map.size <= max) return;
    const keep = keepers();
    const target = Math.floor(max * 0.8);
    for (const id of map.keys()) {
      if (map.size <= target) break;
      if (keep.has(id)) continue;
      map.delete(id);
      stale.delete(id);
    }
  }

  private schedule(): void {
    if (this.want.size && !this.timer) this.timer = setTimeout(() => void this.flush(), 16);
  }

  private async flush(): Promise<void> {
    this.timer = undefined;
    const batch = [...this.want].slice(0, 1000);
    batch.forEach((id) => (this.want.delete(id), this.inflight.add(id)));
    const gen = this.generation;
    try {
      const got = await api.getBriefs(batch);
      if (gen !== this.generation) return;
      for (const b of got) touch(this.briefs, b.id, b);
      this.trim(this.briefs, MAX_BRIEFS, this.staleBriefs);
      // Asked for again while this request was out: stay stale until that answer is in.
      for (const id of batch) if (!this.want.has(id)) this.staleBriefs.delete(id);
      this.version++;
    } finally {
      if (gen === this.generation) batch.forEach((id) => this.inflight.delete(id));
      if (this.want.size && !this.timer) this.timer = setTimeout(() => void this.flush(), 0);
    }
  }

  subscribe(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    on('itemsChanged', ({ ids }) => this.invalidate(ids));
    on('itemsRemoved', ({ ids }) => this.drop(ids));
  }
}

/** Records that must stay cached: the selection (unless it's huge) and what the viewer shows. */
function keepers(): Set<string> {
  const keep = new Set<string>(selection.count <= MAX_FULLS / 2 ? selection.ids : []);
  if (selection.primary) keep.add(selection.primary);
  const v = ui.viewer;
  if (v) for (const id of v.ids.slice(Math.max(0, v.index - 3), v.index + 4)) keep.add(id);
  return keep;
}

export const items = new ItemCache();
