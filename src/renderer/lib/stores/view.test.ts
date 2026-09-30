import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryState, QueryResult } from '../../../shared/types';

// The core, faked: the index grows by 1,000 items per query while a scan runs.
const handlers = new Map<string, (payload: unknown) => void>();
let indexed = 0;
let queries = 0;
vi.mock('../api', () => ({
  on: (name: string, fn: (payload: unknown) => void) => (handlers.set(name, fn), () => {}),
  api: {
    query: async () => {
      queries++;
      const ids = Array.from({ length: indexed }, (_, i) => `I${i}`);
      return { total: ids.length, ids, aspects: ids.map(() => 1) } as unknown as QueryResult;
    },
  },
}));

const { view } = await import('./view.svelte');
view.subscribe();
const libraryEvent = (indexing: LibraryState['indexing']) =>
  handlers.get('library')!({ indexing } as LibraryState);

describe('view refresh while the library changes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    indexed = 0;
    queries = 0;
  });
  afterEach(() => vi.useRealTimers());

  it('fills in during a first scan instead of waiting for its end, then catches up at once', async () => {
    view.reset('lib');
    await vi.advanceTimersByTimeAsync(10);
    expect(view.result?.total).toBe(0);
    // A scan sends news every 250 ms for 10 s.
    const seen: number[] = [];
    for (let t = 0; t < 10_000; t += 250) {
      indexed += 25;
      libraryEvent({ done: indexed, total: 1000 });
      await vi.advanceTimersByTimeAsync(250);
      seen.push(view.result?.total ?? 0);
    }
    // The grid refreshed every ~1.5 s: never more than 1.75 s behind (7 events).
    const firstShown = seen.findIndex((n) => n > 0);
    expect(firstShown).toBeGreaterThanOrEqual(0);
    expect(firstShown).toBeLessThanOrEqual(7);
    expect(queries).toBeGreaterThanOrEqual(6);
    expect(queries).toBeLessThanOrEqual(10);
    expect(view.partial).toBe(true); // asked for mid-scan: empty would not mean empty
    // The scan ends: the full result comes right away, not after another wait.
    libraryEvent(null);
    await vi.advanceTimersByTimeAsync(5);
    expect(view.result?.total).toBe(1000);
    expect(view.partial).toBe(false);
  });

  it('merges a short burst of edits into one query', async () => {
    view.reset('lib');
    await vi.advanceTimersByTimeAsync(10);
    queries = 0;
    for (let i = 0; i < 4; i++) {
      handlers.get('itemsChanged')!({ ids: ['I1'] });
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(queries).toBe(1);
  });
});
