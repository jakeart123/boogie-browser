// Timing for an 85k-item library (Master's size), built in memory. Prints the numbers; asserts loose ceilings.
import { rmSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import type { EagleFolderRecord, EagleItemRecord } from '../../shared/types';
import { openIndex } from './open';
import { MemoryLibrary, scratchDir, testRef, makeItem } from './testHelpers';

const N = 85_000;

/** Small deterministic PRNG so runs are comparable. */
function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

function buildLibrary(): MemoryLibrary {
  const rand = rng(42);
  const pick = <T>(list: T[]): T => list[Math.floor(rand() * list.length)];

  // ~2000 folders, up to 8 deep.
  const flat: EagleFolderRecord[] = [];
  const top: EagleFolderRecord[] = [];
  for (let i = 0; i < 2000; i++) {
    const f: EagleFolderRecord = {
      id: `F${String(i).padStart(12, '0')}`,
      name: `Folder ${i}`,
      description: '',
      children: [],
      modificationTime: 1,
      tags: [],
      password: '',
      passwordTips: '',
    };
    const parent = i < 60 || rand() < 0.15 ? null : pick(flat);
    (parent ? parent.children : top).push(f);
    flat.push(f);
  }
  const tagVocab = Array.from({ length: 400 }, (_, i) => `tag ${i}`);
  const lib = new MemoryLibrary({ folders: top });

  for (let i = 0; i < N; i++) {
    const id = `I${String(i).padStart(12, '0')}`;
    const nFolders = rand() < 0.46 ? 1 : rand() < 0.85 ? 2 : 3; // over half in several folders, like Master
    const w = 400 + Math.floor(rand() * 4000);
    const h = 400 + Math.floor(rand() * 4000);
    const rec: EagleItemRecord = makeItem(id, {
      name: `Artist ${i % 900} - Study ${i} (${1850 + (i % 60)})`,
      size: 50_000 + Math.floor(rand() * 9_000_000),
      tags: Array.from({ length: Math.floor(rand() * 6) }, () => pick(tagVocab)),
      folders: Array.from({ length: nFolders }, () => pick(flat).id),
      isDeleted: rand() < 0.02,
      url: rand() < 0.19 ? `https://example.com/pieces/${i}` : '',
      annotation: rand() < 0.24 ? `Date: ${1850 + (i % 60)}\nStudent of: Somebody ${i % 40}` : '',
      modificationTime: 1700000000000 + i,
      lastModified: 1700000000000 + i,
      width: w,
      height: h,
      star: rand() < 0.1 ? 1 + Math.floor(rand() * 5) : undefined,
      palettes: Array.from({ length: 10 }, () => ({
        color: [Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256)] as [
          number,
          number,
          number,
        ],
        ratio: rand() * 30,
      })),
    });
    if (rec.star === undefined) delete rec.star;
    lib.records.set(id, rec);
  }
  return lib;
}

describe('85k-item library', () => {
  it('scans, counts and re-syncs fast enough', async () => {
    const lib = buildLibrary();
    const dir = scratchDir('perf');
    const ix = openIndex(testRef('perf85k'), { dir, fs: lib.fs() });
    try {
      // The scan runs on Electron's main thread: how long is the event loop stuck at a stretch?
      lib.yieldOnRead = true;
      const loop = monitorEventLoopDelay({ resolution: 5 });
      loop.enable();
      const t0 = performance.now();
      const delta = await ix.sync(lib);
      const scanMs = performance.now() - t0;
      loop.disable();
      lib.yieldOnRead = false;
      expect(delta.added).toHaveLength(N);

      const time = (fn: () => unknown, runs = 5) => {
        const times: number[] = [];
        for (let i = 0; i < runs; i++) {
          const t = performance.now();
          fn();
          times.push(performance.now() - t);
        }
        return Math.round(times.sort((a, b) => a - b)[Math.floor(runs / 2)] * 10) / 10;
      };
      const countsMs = time(() => ix.counts());
      const tagsMs = time(() => ix.tags());
      const recordMs = time(() => ix.getRecord('I000000042000'));

      lib.readIds = [];
      const t1 = performance.now();
      await ix.sync(lib);
      const idleSyncMs = performance.now() - t1;
      expect(lib.readIds).toEqual([]); // nothing changed: no item file read

      // The everyday cases: a watcher hint for a handful of ids, and one write of our own.
      const hinted = [
        'I000000000010',
        'I000000000011',
        'I000000000012',
        'I000000000013',
        'I000000000014',
      ];
      for (const id of hinted)
        lib.records.set(id, { ...lib.records.get(id)!, star: 5, lastModified: 1800000000000 });
      const t2 = performance.now();
      const hint = await ix.refresh(lib, { ids: hinted });
      const refreshMs = performance.now() - t2;
      expect(hint.changed.sort()).toEqual(hinted);
      const one = { ...lib.records.get(hinted[0])!, star: 2, lastModified: 1800000000001 };
      const upsertMs = time(() => ix.upsertRecords([one]), 1);

      console.log(
        `[index] 85k synthetic: scan ${Math.round(scanMs)} ms (longest event-loop stall ${Math.round(loop.max / 1e6)} ms, p99 ${Math.round(loop.percentile(99) / 1e6)} ms), counts() ${countsMs} ms (median of 5), tags() ${tagsMs} ms, getRecord ${recordMs} ms, sync with nothing changed ${Math.round(idleSyncMs)} ms, refresh of 5 ids ${Math.round(refreshMs)} ms, upsert of 1 record ${upsertMs} ms`,
      );
      expect(ix.counts().all).toBe(
        ix.db.prepare('SELECT count(*) FROM items WHERE is_deleted = 0').pluck().get(),
      );
      // Loose ceilings: 17 other builds share this machine, the spec target for counts() is 150 ms.
      expect(countsMs).toBeLessThan(400);
      expect(scanMs).toBeLessThan(90_000);
    } finally {
      ix.close();
      rmSync(dir, { recursive: true, force: true }); // 250 MB of sqlite
    }
  }, 240_000);
});
