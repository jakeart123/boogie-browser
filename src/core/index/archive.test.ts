// Full scan of a real library (the Art Archive template), read-only, indexed into .tmp/index.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EagleItemRecord } from '../../shared/types';
import { openIndex } from './open';
import { bruteCounts, DiskLibrary, scratchDir, testRef, TEMPLATES } from './testHelpers';

const libPath = join(TEMPLATES, 'art-archive.library');

describe.skipIf(!existsSync(libPath))('full scan of the Art Archive template', () => {
  it('indexes every readable item, matches a brute-force count, and a rescan reads nothing', async () => {
    const dir = scratchDir('archive');
    const lib = new DiskLibrary(libPath);

    // Independent ground truth: every <id>.info dir whose metadata.json parses.
    const records: EagleItemRecord[] = [];
    for (const name of readdirSync(join(libPath, 'images'))) {
      if (!name.endsWith('.info')) continue;
      try {
        records.push(
          JSON.parse(readFileSync(join(libPath, 'images', name, 'metadata.json'), 'utf8')),
        );
      } catch {
        /* unreadable: not expected to be indexed */
      }
    }
    const root = (await lib.readRoot()).value;

    const ref = testRef('archive', libPath);
    let ix = openIndex(ref, { dir });
    const progress: number[] = [];
    const t0 = performance.now();
    const delta = await ix.sync(lib, (p) => progress.push(p.done));
    console.log(
      `[index] Art Archive scan: ${records.length} items in ${Math.round(performance.now() - t0)} ms`,
    );

    expect(records.length).toBeGreaterThan(5000);
    expect(delta.added).toHaveLength(records.length);
    expect(ix.db.prepare('SELECT count(*) FROM items').pluck().get()).toBe(records.length);
    expect(progress.at(-1)).toBe(records.length);

    const counts = ix.counts();
    expect(counts).toMatchObject(bruteCounts(records, root));
    const rows = (t: string) => ix.db.prepare(`SELECT count(*) FROM ${t}`).pluck().get();
    expect(rows('items_fts')).toBe(records.length);

    // Tag counts (live items) agree too.
    const brute = new Map<string, number>();
    for (const r of records)
      if (!r.isDeleted) for (const t of new Set(r.tags)) brute.set(t, (brute.get(t) ?? 0) + 1);
    expect(new Map(ix.tags().map((t) => [t.name, t.count]))).toEqual(brute);

    // Odd real values survive: the string dates and the record text itself.
    const stringDated = records.find((r) => typeof r.modificationTime === 'string');
    if (stringDated)
      expect(
        ix.db.prepare('SELECT imported_at_str FROM items WHERE id = ?').pluck().get(stringDated.id),
      ).toBe(stringDated.modificationTime);
    const sample = records[Math.floor(records.length / 2)];
    expect(ix.getRecord(sample.id)).toEqual(sample);
    expect(ix.getRoot()).toEqual(root);

    // Same process: nothing to do.
    lib.readIds = [];
    expect((await ix.sync(lib)).added).toEqual([]);
    expect(lib.readIds).toEqual([]);

    // App restart: reopen the cached db from disk, still nothing to read.
    ix.close();
    ix = openIndex(ref, { dir });
    const t1 = performance.now();
    const again = await ix.sync(lib);
    console.log(
      `[index] Art Archive reopen + sync with nothing changed: ${Math.round(performance.now() - t1)} ms`,
    );
    expect(again).toMatchObject({ added: [], changed: [], removed: [], rootChanged: false });
    expect(lib.readIds).toEqual([]);
    expect(ix.counts()).toEqual(counts);
    ix.close();
  }, 120_000);
});
