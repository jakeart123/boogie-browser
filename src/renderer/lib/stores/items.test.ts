import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Item, ItemBrief } from '../../../shared/types';

// The core, faked: every id exists and answers with a small record.
vi.mock('../api', () => ({
  on: () => () => {},
  api: {
    getBriefs: async (ids: string[]) => ids.map((id) => ({ id }) as ItemBrief),
    getItems: async (ids: string[]) => ids.map((id) => ({ id, tags: [] }) as unknown as Item),
    getItem: async (id: string) => ({ id, tags: [] }) as unknown as Item,
  },
}));

const { items, MAX_BRIEFS, MAX_FULLS } = await import('./items.svelte');
const { selection } = await import('./selection.svelte');
const { ui } = await import('./ui.svelte');

const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => `I${from + i}`);
const settle = () => new Promise((r) => setTimeout(r, 40));

/** What the grid does while scrolling: ask for a window of briefs, wait for them, move on. */
async function scrollThrough(total: number, window = 300) {
  for (let at = 0; at < total; at += window) {
    items.ensure(ids(at, window));
    await settle();
  }
}

describe('item cache limits', () => {
  beforeEach(() => {
    items.clear();
    selection.clear();
    ui.viewer = null;
  });

  it('keeps briefs bounded over a long scroll, but never drops the window, the selection or the viewer', async () => {
    selection.setMany(['I5', 'I7'], 'I7');
    ui.viewer = { mode: 'detail', ids: ids(0, 20_000), index: 100 };
    await scrollThrough(20_000);
    const kept = ids(0, 20_000).filter((id) => items.brief(id));
    expect(kept.length).toBeLessThanOrEqual(MAX_BRIEFS);
    // The last window is on screen; the selection and the viewer's item were far up the list.
    for (const id of ids(19_700, 300)) expect(items.brief(id)).toBeDefined();
    for (const id of ['I5', 'I7', 'I100', 'I101']) expect(items.brief(id)).toBeDefined();
  });

  it('keeps a record that keeps being read (the inspector, a tile) while others churn', async () => {
    items.ensure(['I0']);
    await settle();
    for (let at = 1; at < 20_000; at += 500) {
      items.brief('I0'); // a component re-reads it on every cache update
      items.ensure(ids(at, 500));
      await settle();
    }
    expect(items.brief('I0')).toBeDefined();
  });

  it('answers a batch bigger than the full cache in full, without filling the cache with it', async () => {
    const want = ids(0, MAX_FULLS * 3);
    const got = await items.loadFulls(want);
    expect(got.map((it) => it.id)).toEqual(want);
    // Small batches are cached, and stay under the limit however many there are.
    for (let at = 0; at < MAX_FULLS * 3; at += 200) await items.loadFulls(ids(at, 200));
    const cached = want.filter((id) => items.full(id));
    expect(cached.length).toBeGreaterThan(0);
    expect(cached.length).toBeLessThanOrEqual(MAX_FULLS);
  });
});
