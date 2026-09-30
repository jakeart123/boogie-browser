import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DupeScanStats, DuplicateGroup } from '../../shared/types';
import { dupeFinder, MAX_CLUSTER, planMerge } from './index';
import { fakeMedia, makeSource } from './testkit';
import type { ScanSource } from './scan';

const scratch = resolve('.tmp/dupes');
let dir: string;
let big: string; // 800x600 test image
let small: string; // the same image at half size, re-encoded as a lossy JPEG
let other: string; // an unrelated image

function vips(...args: string[]) {
  execFileSync('vips', args, { stdio: 'ignore' });
}

beforeAll(() => {
  mkdirSync(scratch, { recursive: true });
  dir = mkdtempSync(join(scratch, 'scan-'));
  big = join(dir, 'big.png');
  small = join(dir, 'small.jpg');
  other = join(dir, 'other.png');
  vips('perlin', big, '800', '600', '--cell-size', '30', '--seed', '3', '--uchar');
  vips('perlin', other, '800', '600', '--cell-size', '30', '--seed', '9', '--uchar');
  execFileSync('vipsthumbnail', [big, '-s', '400x300', '-o', `${small}[Q=40]`], {
    stdio: 'ignore',
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const bytes = (n: number, fill: number) => Buffer.alloc(n, fill);
const ids = (g: DuplicateGroup) => g.members.map((m) => m.id);

describe('exact scan', () => {
  it('finds identical bytes under different names, hashes only same-size files, and caches', async () => {
    const lib = makeSource(dir, 'exact');
    const x = bytes(4000, 7);
    const almost = Buffer.from(x);
    almost[100] = 9; // same size, different content
    lib.add({ id: 'A', name: 'photo one', bytes: x, added: 2000 });
    lib.add({ id: 'B', name: 'IMG_0042 downloaded again', bytes: x, added: 1000 });
    lib.add({ id: 'C', name: 'lookalike', bytes: almost });
    lib.add({ id: 'D', name: 'other size', bytes: bytes(123, 1) });

    const media = fakeMedia();
    const progress: { done: number; total: number }[] = [];
    const stats = {} as DupeScanStats;
    const groups = await dupeFinder.scan(
      { mode: 'exact' },
      lib,
      [],
      media,
      (p) => progress.push(p),
      undefined,
      stats,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('exact');
    expect(ids(groups[0])).toEqual(['B', 'A']); // oldest first
    expect(groups[0].members.every((m) => m.distance === 0 && m.libraryName === 'exact')).toBe(
      true,
    );
    expect(groups[0].members[0].thumbUrl).toContain('/B?v=');
    expect(media.md5Calls).toHaveLength(3); // A, B, C. D's size is unique, so it is never read
    expect(progress[0]).toEqual({ done: 0, total: 3 });
    expect(progress.at(-1)).toEqual({ done: 3, total: 3 });

    // Second scan: everything comes from the index, nothing is read.
    const stats2 = {} as DupeScanStats;
    const again = await dupeFinder.scan(
      { mode: 'exact' },
      lib,
      [],
      media,
      undefined,
      undefined,
      stats2,
    );
    expect(media.md5Calls).toHaveLength(3);
    expect(stats2).toMatchObject({ cached: 3, hashed: 0 });
    expect(again).toEqual(groups);
    expect(stats.hashed).toBe(3);
  });

  it('recomputes a hash when the original changed on disk', async () => {
    const lib = makeSource(dir, 'changed');
    const x = bytes(900, 3);
    lib.add({ id: 'A', name: 'a', bytes: x });
    lib.add({ id: 'B', name: 'b', bytes: x });
    const media = fakeMedia();
    expect(await dupeFinder.scan({ mode: 'exact' }, lib, [], media)).toHaveLength(1);
    // Same size, new content, newer mtime: the cached md5 no longer applies.
    const path = join(lib.lib.itemDir('B'), 'b.png');
    writeFileSync(path, bytes(900, 4));
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    expect(await dupeFinder.scan({ mode: 'exact' }, lib, [], media)).toHaveLength(0);
  });

  it('suggests the keeper by folders, then tags, then a note, then age', async () => {
    const lib = makeSource(dir, 'keeper');
    const pair = (n: number, a: object, b: object) => {
      const x = bytes(1000 + n, n);
      lib.add({ id: `a${n}`, name: `a${n}`, bytes: x, added: 5000, ...a });
      lib.add({ id: `b${n}`, name: `b${n}`, bytes: x, added: 6000, ...b });
    };
    pair(1, { folders: ['F1'] }, { folders: ['F1', 'F2'] }); // b: more folders, even though newer
    pair(2, { tags: ['x'] }, { tags: ['x', 'y'] }); // b: more tags
    pair(3, {}, { annotation: 'a note' }); // b: has a note
    pair(4, {}, {}); // tie: oldest is a
    const groups = await dupeFinder.scan({ mode: 'exact' }, lib, [], fakeMedia());
    const keeperOf = (n: number) => groups.find((g) => ids(g).includes(`a${n}`))!.suggestedKeeperId;
    expect([1, 2, 3, 4].map(keeperOf)).toEqual(['b1', 'b2', 'b3', 'a4']);
  });

  it('matches across libraries, keeps the current library first, and merges only same-library copies', async () => {
    const cur = makeSource(dir, 'cur');
    const lib2 = makeSource(dir, 'second');
    const lib3 = makeSource(dir, 'third');
    const x = bytes(2500, 5);
    cur.add({ id: 'S1', name: 'one', bytes: x, added: 3000, tags: ['t1'] });
    cur.add({ id: 'S2', name: 'two', bytes: x, added: 4000, folders: ['F'], tags: ['t2'] });
    lib2.add({ id: 'S1', name: 'copy of one', bytes: x, added: 1 }); // a library copy: same item id, older
    // Only other libraries hold these two: nothing to act on, so no group and no hashing.
    const y = bytes(3300, 2);
    lib2.add({ id: 'Y1', name: 'y1', bytes: y });
    lib3.add({ id: 'Y2', name: 'y2', bytes: y });
    // A trashed copy never counts.
    lib3.add({ id: 'Z', name: 'trashed copy', bytes: x });
    lib3.trash('Z');

    const media = fakeMedia();
    const groups = await dupeFinder.scan({ mode: 'exact' }, cur, [lib2, lib3], media);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.members.map((m) => `${m.libraryName}/${m.id}`)).toEqual([
      'cur/S1',
      'cur/S2',
      'second/S1',
    ]);
    expect(g.suggestedKeeperId).toBe('S2'); // in the current library: more folders
    expect(media.md5Calls.some((p) => p.includes('/y1.') || p.includes('/y2.'))).toBe(false);

    // The service only passes same-library records; the other library's S1 is left alone.
    const rec = (id: string) => cur.index.getRecord(id)!;
    const plan = planMerge(rec('S2'), [rec('S1')], { keeperId: 'S2', otherIds: ['S1'] }, () => []);
    expect(plan.trashIds).toEqual(['S1']);
    const keeper = rec('S2');
    plan.keeper(keeper);
    expect(keeper.tags).toEqual(['t2', 't1']);

    // Listing the current library as its own "other" must not pair every item with itself.
    expect(await dupeFinder.scan({ mode: 'exact' }, cur, [cur], fakeMedia())).toHaveLength(1);
  });

  it('limits the current library by scope (folder, with or without subfolders)', async () => {
    const lib = makeSource(dir, 'scoped');
    const x = bytes(1500, 8);
    lib.add({ id: 'P1', name: 'p1', bytes: x, folders: ['F'] });
    lib.add({ id: 'P2', name: 'p2', bytes: x, folders: ['F'] });
    lib.add({ id: 'P3', name: 'p3', bytes: x, folders: ['G'] }); // a child folder of F
    lib.add({ id: 'P4', name: 'p4', bytes: x }); // unfiled
    lib.db.prepare('INSERT INTO folder_closure VALUES (?,?,?)').run('F', 'F', 0);
    lib.db.prepare('INSERT INTO folder_closure VALUES (?,?,?)').run('F', 'G', 1);
    lib.db.prepare('INSERT INTO folder_closure VALUES (?,?,?)').run('G', 'G', 0);

    const scan = (scope: object) =>
      dupeFinder.scan({ mode: 'exact', scope: scope as never }, lib, [], fakeMedia());
    expect(
      ids((await scan({ kind: 'folder', id: 'F', includeSubfolders: false }))[0]).sort(),
    ).toEqual(['P1', 'P2']);
    expect(
      ids((await scan({ kind: 'folder', id: 'F', includeSubfolders: true }))[0]).sort(),
    ).toEqual(['P1', 'P2', 'P3']);
    expect(await scan({ kind: 'uncategorized' })).toEqual([]); // P4 alone: nothing to pair with
    expect(await scan({ kind: 'trash' })).toEqual([]);
    await expect(scan({ kind: 'smartFolder', id: 'S' })).rejects.toThrow(/smart folder/i);
  });

  it('reads at most 2 whole files at once from a slow drive, 4 elsewhere', async () => {
    const run = async (slow: boolean) => {
      const lib = makeSource(dir, slow ? 'hdd' : 'ssd');
      // 12 files of the same size, all different: every one has to be hashed.
      for (let i = 0; i < 12; i++) lib.add({ id: `H${i}`, name: `h${i}`, bytes: bytes(700, i) });
      const media = fakeMedia({ md5DelayMs: 25 });
      const source: ScanSource = { ...lib, slow }; // service/storage says which drives are slow
      await dupeFinder.scan({ mode: 'exact' }, source, [], media);
      expect(media.md5Calls).toHaveLength(12);
      return media.maxInFlight;
    };
    expect(await run(true)).toBe(2);
    const fast = await run(false);
    expect(fast).toBeGreaterThan(2);
    expect(fast).toBeLessThanOrEqual(4);
  });

  it('stops promptly when aborted', async () => {
    const lib = makeSource(dir, 'abort');
    for (let i = 0; i < 20; i++) lib.add({ id: `Q${i}`, name: `q${i}`, bytes: bytes(600, i) });
    const media = fakeMedia({ md5DelayMs: 100 });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 150);
    const started = Date.now();
    await expect(
      dupeFinder.scan({ mode: 'exact' }, lib, [], media, undefined, ctl.signal),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(media.md5Calls.length).toBeLessThan(20);
    await expect(
      dupeFinder.scan({ mode: 'exact' }, lib, [], media, undefined, ctl.signal),
    ).rejects.toThrow();
  });
});

describe('similar scan', () => {
  it('finds the same picture re-encoded smaller, not an unrelated one, and caches the hashes', async () => {
    const lib = makeSource(dir, 'similar');
    lib.add({ id: 'BIG', name: 'big', ext: 'png', from: big, width: 800, height: 600, added: 2 });
    lib.add({
      id: 'SMALL',
      name: 'small',
      ext: 'jpg',
      from: small,
      thumbFrom: small,
      width: 400,
      height: 300,
      added: 1,
    });
    lib.add({ id: 'OTHER', name: 'other', ext: 'png', from: other, width: 800, height: 600 });
    lib.add({ id: 'DOC', name: 'notes', ext: 'txt', bytes: Buffer.from('not an image') });

    const media = fakeMedia();
    const groups = await dupeFinder.scan({ mode: 'similar', threshold: 6 }, lib, [], media);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.kind).toBe('similar');
    expect(ids(g).sort()).toEqual(['BIG', 'SMALL']);
    expect(g.suggestedKeeperId).toBe('BIG'); // most pixels, even though SMALL is older
    const byId = Object.fromEntries(g.members.map((m) => [m.id, m]));
    expect(byId.BIG.distance).toBe(0);
    expect(byId.SMALL.distance).toBeGreaterThan(0);
    expect(byId.SMALL.distance).toBeLessThanOrEqual(6);
    // The thumbnail is what gets hashed when there is one; the plain text file is skipped.
    expect(media.dhashCalls.filter((p) => p.endsWith('small_thumbnail.png'))).toHaveLength(1);
    expect(media.dhashCalls).toHaveLength(3);

    await dupeFinder.scan({ mode: 'similar' }, lib, [], media);
    expect(media.dhashCalls).toHaveLength(3); // cached

    // A strict threshold no longer accepts the re-encode (its distance is above 0).
    expect(await dupeFinder.scan({ mode: 'similar', threshold: 0 }, lib, [], media)).toEqual([]);
  });

  it('skips clusters over the cap and reports how many', async () => {
    const lib = makeSource(dir, 'crowd');
    for (let i = 0; i < MAX_CLUSTER + 1; i++)
      lib.add({ id: `C${i}`, name: `c${i}`, ext: 'jpg', from: small, width: 400, height: 300 });
    lib.add({ id: 'ONE', name: 'one', ext: 'png', from: other, width: 800, height: 600 });
    lib.add({ id: 'TWO', name: 'two', ext: 'png', from: other, width: 800, height: 600 });
    const stats = {} as DupeScanStats;
    const groups = await dupeFinder.scan(
      { mode: 'similar' },
      lib,
      [],
      fakeMedia(),
      undefined,
      undefined,
      stats,
    );
    expect(stats.skippedClusters).toBe(1);
    expect(groups).toHaveLength(1);
    expect(ids(groups[0]).sort()).toEqual(['ONE', 'TWO']);
  });
});
