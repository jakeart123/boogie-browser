import { cpSync, existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { EagleFolderRecord, EagleItemRecord, EagleRootRecord } from '../../shared/types';
import { indexes } from './index';
import { openIndex, SCHEMA_VERSION } from './open';
import type { SqliteLibraryIndex } from './libraryIndex';
import {
  bruteCounts,
  copyLibrary,
  DiskLibrary,
  makeItem,
  MemoryLibrary,
  scratchDir,
  testRef,
  TEMPLATES,
} from './testHelpers';

const open: SqliteLibraryIndex[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
});
function track(ix: SqliteLibraryIndex): SqliteLibraryIndex {
  open.push(ix);
  return ix;
}

const folder = (
  id: string,
  name: string,
  children: EagleFolderRecord[] = [],
  tags: string[] = [],
): EagleFolderRecord => ({
  id,
  name,
  description: '',
  children,
  modificationTime: 1,
  tags,
  password: '',
  passwordTips: '',
});

describe('incremental sync on a copy of sample', () => {
  const haveTemplate = existsSync(join(TEMPLATES, 'sample.library'));
  it.skipIf(!haveTemplate)(
    'reads nothing when unchanged, then picks up exactly the edited, removed and added ids',
    async () => {
      const dir = scratchDir('incremental');
      const libDir = copyLibrary('sample.library', join(dir, 'lib.library'));
      const lib = new DiskLibrary(libDir);
      const ix = track(openIndex(testRef('sample', libDir), { dir }));

      const first = await ix.sync(lib);
      expect(first.added).toHaveLength(3);
      expect(first.firstScan).toBe(true);
      expect(first.changedText).toEqual([]); // a first scan doesn't collect 85k texts
      const [a, b, c] = first.added.sort();

      // Nothing changed: trust the db, read no item files.
      lib.readIds = [];
      expect(await ix.sync(lib)).toMatchObject({
        added: [],
        changed: [],
        removed: [],
        rootChanged: false,
        firstScan: false,
      });
      expect(lib.readIds).toEqual([]);

      // Edit item b on disk and raise its mtime.json entry: exactly b is re-read.
      const metaPath = join(lib.itemDir(b), 'metadata.json');
      const before = readFileSync(metaPath, 'utf8');
      const rec = JSON.parse(before) as EagleItemRecord;
      const edited = {
        ...rec,
        tags: [...rec.tags, 'edited'],
        lastModified: rec.lastModified! + 5000,
      };
      writeFileSync(metaPath, JSON.stringify(edited));
      writeFileSync(join(libDir, 'mtime.json'), JSON.stringify({ [b]: edited.lastModified }));
      const changed = await ix.sync(lib);
      expect(changed.changed).toEqual([b]);
      expect(changed.added).toEqual([]);
      expect(lib.readIds).toEqual([b]);
      expect(changed.changedText).toEqual([{ id: b, before, after: JSON.stringify(edited) }]);
      expect(ix.getRecord(b)?.tags).toContain('edited');
      expect(ix.tags().find((t) => t.name === 'edited')?.count).toBe(1);

      // An edit that never raised mtime.json is invisible to sync (like Eagle) ...
      const c1 = JSON.parse(
        readFileSync(join(lib.itemDir(c), 'metadata.json'), 'utf8'),
      ) as EagleItemRecord;
      writeFileSync(
        join(lib.itemDir(c), 'metadata.json'),
        JSON.stringify({ ...c1, annotation: 'sneaky' }),
      );
      lib.readIds = [];
      expect((await ix.sync(lib)).changed).toEqual([]);
      expect(lib.readIds).toEqual([]);
      // ... and the slow verify pass finds it.
      const verified = await ix.verify(lib, { pauseMs: 0 });
      expect(verified.changed).toEqual([c]);
      expect(ix.getRecord(c)?.annotation).toBe('sneaky');
      // Everything is up to date now, so a second verify re-reads nothing.
      lib.readIds = [];
      expect((await ix.verify(lib, { pauseMs: 0 })).changed).toEqual([]);
      expect(lib.readIds).toEqual([]);

      // Delete a folder: removed.
      rmSync(lib.itemDir(a), { recursive: true });
      const removed = await ix.sync(lib);
      expect(removed.removed).toEqual([a]);
      expect(removed.changedText.map((t) => [t.id, t.after])).toEqual([[a, null]]);
      expect(ix.getRecord(a)).toBeNull();
      expect(ix.counts().all).toBe(2);

      // Add one: added, with its text in changedText.
      const newId = 'ZZZZZZZZZZZZZ';
      const cloneDir = lib.itemDir(newId);
      const { cpSync } = await import('node:fs');
      cpSync(lib.itemDir(c), cloneDir, { recursive: true });
      writeFileSync(join(cloneDir, 'metadata.json'), JSON.stringify({ ...c1, id: newId }));
      const added = await ix.sync(lib);
      expect(added.added).toEqual([newId]);
      expect(added.changedText).toHaveLength(1);
      expect(added.changedText[0]).toMatchObject({ id: newId, before: null });
      expect(ix.counts().all).toBe(3);
    },
  );
});

describe('listing images/ only when it may have changed', () => {
  const haveTemplate = existsSync(join(TEMPLATES, 'sample.library'));
  it.skipIf(!haveTemplate)(
    'skips the listing while images/ and mtime.json are unchanged, and lists again after either changes',
    async () => {
      const dir = scratchDir('listskip');
      const libDir = copyLibrary('sample.library', join(dir, 'lib.library'));
      const lib = new DiskLibrary(libDir);
      let listings = 0;
      const list = lib.listItemIds.bind(lib);
      lib.listItemIds = () => (listings++, list());
      const images = join(libDir, 'images');
      const hourAgo = new Date(Date.now() - 3600_000);
      utimesSync(images, hourAgo, hourAgo); // a folder touched just now can't prove anything
      const ix = track(openIndex(testRef('ls', libDir), { dir }));

      await ix.sync(lib); // first scan: always lists
      expect(listings).toBe(1);
      expect((await ix.sync(lib)).added).toEqual([]);
      expect(listings).toBe(1); // nothing changed: the known ids stand in for the listing

      // A new item folder moves images/'s mtime: listed again, and found.
      const [someId] = await list();
      const newId = 'ZZZZZZZZZZZZZ';
      cpSync(lib.itemDir(someId), lib.itemDir(newId), { recursive: true });
      const rec = JSON.parse(readFileSync(join(lib.itemDir(newId), 'metadata.json'), 'utf8'));
      writeFileSync(
        join(lib.itemDir(newId), 'metadata.json'),
        JSON.stringify({ ...rec, id: newId }),
      );
      expect((await ix.sync(lib)).added).toEqual([newId]);
      expect(listings).toBe(2);

      // mtime.json changing (another Eagle wrote) is enough to list again too.
      utimesSync(images, hourAgo, hourAgo);
      await ix.sync(lib); // stores the old-enough stamp
      const n = listings;
      await ix.sync(lib);
      expect(listings).toBe(n);
      writeFileSync(join(libDir, 'mtime.json'), JSON.stringify({ [newId]: 1 }));
      await ix.sync(lib);
      expect(listings).toBe(n + 1);
    },
  );
});

describe('folders, counts and search rows', () => {
  it('counts deep folder membership once per item and ignores folder ids that are not in the tree', async () => {
    const lib = new MemoryLibrary({
      folders: [
        folder('A', 'Artists', [
          folder('A1', 'Bouguereau'),
          folder('A2', 'Gerome', [folder('A2x', 'Sketches')]),
        ]),
        folder('B', 'Books'),
      ],
    });
    const items = [
      makeItem('i1', { folders: ['A1', 'A2'] }), // two sibling folders: counted once in A
      makeItem('i2', { folders: ['A', 'A2x'] }), // parent and grandchild: counted once in A
      makeItem('i3', { folders: ['A2x'] }),
      makeItem('i4', { folders: ['GHOST'] }), // unknown folder id: uncategorized
      makeItem('i5', { folders: [], tags: ['t'] }),
      makeItem('i6', { folders: ['B'], isDeleted: true, deletedTime: 5 }), // trash counts nowhere else
    ];
    for (const r of items) lib.records.set(r.id, r);
    const ix = track(openIndex(testRef(), { dir: scratchDir('counts'), fs: lib.fs() }));
    await ix.sync(lib);

    const counts = ix.counts();
    expect(counts).toMatchObject({
      all: 5,
      uncategorized: 2,
      untagged: 4,
      trash: 1,
      smartFolders: {},
      totalSize: 5 * 1000, // live items only (makeItem's size is 1000)
    });
    expect(counts.folders.A).toEqual({ own: 1, deep: 3 });
    expect(counts.folders.A1).toEqual({ own: 1, deep: 1 });
    expect(counts.folders.A2).toEqual({ own: 1, deep: 3 });
    expect(counts.folders.A2x).toEqual({ own: 2, deep: 2 });
    expect(counts.folders.B).toEqual({ own: 0, deep: 0 });
    // And it agrees with the plain brute-force computation.
    expect(counts).toMatchObject(bruteCounts(items, lib.rootRecord));
  });

  it('rebuilds folder_count and the FTS folder names when the tree changes', async () => {
    const lib = new MemoryLibrary({
      folders: [folder('P', 'Portraits'), folder('L', 'Landscapes')],
    });
    lib.records.set('i1', makeItem('i1', { folders: ['P', 'L'] }));
    lib.records.set('i2', makeItem('i2', { folders: ['L'] }));
    lib.records.set('i3', makeItem('i3', { folders: [] }));
    const ix = track(openIndex(testRef(), { dir: scratchDir('root-change'), fs: lib.fs() }));
    await ix.sync(lib);
    const hits = (q: string) =>
      (
        ix.db
          .prepare('SELECT rowid FROM items_fts WHERE items_fts MATCH ?')
          .all(`"${q}"`) as unknown[]
      ).length;
    expect(hits('Portraits')).toBe(1);
    expect(hits('Landscapes')).toBe(2);

    // Rename Landscapes, delete Portraits (all in the root only; no item file is touched).
    lib.rootRecord = { ...lib.rootRecord, modificationTime: 2, folders: [folder('L', 'Vistas')] };
    lib.readIds = [];
    const delta = await ix.sync(lib);
    expect(delta.rootChanged).toBe(true);
    expect(lib.readIds).toEqual([]);
    expect(hits('Portraits')).toBe(0);
    expect(hits('Landscapes')).toBe(0);
    expect(hits('Vistas')).toBe(2);
    const fc = (id: string) =>
      ix.db.prepare('SELECT folder_count FROM items WHERE id = ?').pluck().get(id);
    expect([fc('i1'), fc('i2'), fc('i3')]).toEqual([1, 1, 0]);
    expect(ix.getRoot()?.folders.map((f) => f.name)).toEqual(['Vistas']);
    expect(ix.db.prepare('SELECT path FROM folders').pluck().all()).toEqual(['Vistas']);

    // A new folder description is searchable too (Eagle's keyword search covers it).
    lib.rootRecord = {
      ...lib.rootRecord,
      modificationTime: 3,
      folders: [{ ...folder('L', 'Vistas'), description: 'wide mountain views' }],
    };
    await ix.sync(lib);
    expect(hits('mountain')).toBe(2);
  });

  it('flattens nested folders with paths, closure rows and duplicate sibling names', () => {
    const ix = track(openIndex(testRef(), { dir: scratchDir('flatten') }));
    const root: EagleRootRecord = {
      folders: [
        folder('A', 'Artists', [
          folder('A1', 'Downloads'),
          folder('A2', 'Downloads', [folder('A2x', 'Deep')]),
        ]),
      ],
      smartFolders: [],
      quickAccess: [],
      tagsGroups: [],
      modificationTime: 1,
      applicationVersion: '4.0.0',
    };
    ix.setRoot(root);
    expect(
      ix.db.prepare('SELECT id, parent_id, path, depth, position FROM folders ORDER BY id').all(),
    ).toEqual([
      { id: 'A', parent_id: null, path: 'Artists', depth: 0, position: 0 },
      { id: 'A1', parent_id: 'A', path: 'Artists / Downloads', depth: 1, position: 0 },
      { id: 'A2', parent_id: 'A', path: 'Artists / Downloads', depth: 1, position: 1 },
      { id: 'A2x', parent_id: 'A2', path: 'Artists / Downloads / Deep', depth: 2, position: 0 },
    ]);
    expect(
      ix.db
        .prepare(
          "SELECT ancestor_id FROM folder_closure WHERE descendant_id = 'A2x' ORDER BY distance",
        )
        .pluck()
        .all(),
    ).toEqual(['A2x', 'A2', 'A']);
    expect(ix.getRoot()).toEqual(root);
  });

  it('indexes palette colors and cleans every table when an item goes away', async () => {
    const lib = new MemoryLibrary();
    lib.records.set(
      'p1',
      makeItem('p1', {
        tags: ['x'],
        folders: [],
        palettes: [
          { color: [255, 0, 0], ratio: 50 },
          { color: [0, 0, 255], ratio: 5 },
        ],
      }),
    );
    const ix = track(openIndex(testRef(), { dir: scratchDir('palette'), fs: lib.fs() }));
    await ix.sync(lib);
    expect(ix.db.prepare('SELECT l FROM palette ORDER BY idx').pluck().all()).toEqual([
      53.24, 32.3,
    ]); // red, then blue, in CIELAB

    ix.removeItems(['p1']);
    const rows = (sql: string) => ix.db.prepare(sql).pluck().get();
    expect([
      rows('SELECT count(*) FROM items'),
      rows('SELECT count(*) FROM item_tags'),
      rows('SELECT count(*) FROM palette'),
      rows('SELECT count(*) FROM items_fts'),
    ]).toEqual([0, 0, 0, 0]);
  });
});

describe('refresh, upsert and the unreadable list', () => {
  it('refresh re-reads only the hinted ids, and our own upsert produces no external-change echo', async () => {
    const lib = new MemoryLibrary();
    for (const id of ['a', 'b', 'c']) lib.records.set(id, makeItem(id));
    const ix = track(openIndex(testRef(), { dir: scratchDir('refresh'), fs: lib.fs() }));
    await ix.sync(lib);

    // We write item a ourselves: upsert, and the file (as the adapter writes it) matches JSON.stringify.
    const a2 = makeItem('a', { tags: ['ours'], lastModified: 1700000009999 });
    lib.records.set('a', a2);
    ix.upsertRecords([a2]);
    lib.readIds = [];
    expect(await ix.refresh(lib, { ids: ['a'] })).toMatchObject({
      added: [],
      changed: [],
      removed: [],
    });

    // The partner edits b; c vanishes; d arrives. One refresh with the hint the watcher would send.
    lib.records.set('b', makeItem('b', { star: 3, lastModified: 1700000005000 }));
    lib.records.delete('c');
    lib.records.set('d', makeItem('d'));
    lib.readIds = [];
    const delta = await ix.refresh(lib, { ids: ['b'], listDir: true });
    expect(delta.changed).toEqual(['b']);
    expect(delta.added).toEqual(['d']);
    expect(delta.removed).toEqual(['c']);
    expect(lib.readIds.sort()).toEqual(['b', 'd']);
    expect(ix.db.prepare("SELECT star FROM items WHERE id = 'b'").pluck().get()).toBe(3);

    // A hinted id whose folder is gone is removed; one that's merely unreadable is kept.
    lib.records.delete('d');
    expect((await ix.refresh(lib, { ids: ['d'] })).removed).toEqual(['d']);
    const keep = lib.records.get('b')!;
    lib.records.delete('b');
    lib.records.set('b', keep);
    const orig = lib.readItem.bind(lib);
    lib.readItem = async (id) => (id === 'b' ? null : orig(id)); // half-synced file
    expect(await ix.refresh(lib, { ids: ['b'] })).toMatchObject({ removed: [] });
    expect(ix.getRecord('b')).not.toBeNull();
    lib.readItem = orig;

    // The whole library gone (drive unplugged, folder renamed away) is not "every item deleted".
    const all = new Map(lib.records);
    lib.records.clear();
    await expect(ix.refresh(lib, { ids: [...all.keys()] })).rejects.toThrow(/looks empty/);
    expect(ix.counts().all).toBe(all.size);
  });

  it('does not retry an unreadable item until its metadata.json changes', async () => {
    const lib = new MemoryLibrary();
    lib.records.set('good', makeItem('good'));
    lib.records.set('bad', makeItem('bad'));
    const orig = lib.readItem.bind(lib);
    let badReadable = false;
    lib.readItem = async (id) =>
      id === 'bad' && !badReadable ? (lib.readIds.push(id), null) : orig(id); // zero-filled file
    lib.mtimes.set('bad', 100);
    const ix = track(openIndex(testRef(), { dir: scratchDir('unreadable'), fs: lib.fs() }));

    const first = await ix.sync(lib);
    expect(first.added).toEqual(['good']);
    expect(ix.unreadableIds()).toEqual(['bad']);
    expect(lib.readIds).toEqual(['good', 'bad']);

    lib.readIds = [];
    await ix.sync(lib);
    expect(lib.readIds).toEqual([]); // same mtime, still broken: skipped

    // A refresh that changes nothing writes nothing (not even the unreadable list again).
    const changes = () => ix.db.prepare('SELECT total_changes()').pluck().get() as number;
    const before = changes();
    await ix.refresh(lib, { ids: ['good'] });
    await ix.refresh(lib, { ids: ['bad'] });
    expect(changes()).toBe(before);
    expect(ix.unreadableIds()).toEqual(['bad']);

    badReadable = true;
    lib.mtimes.set('bad', 200); // Dropbox delivered a new file
    const third = await ix.sync(lib);
    expect(third.added).toEqual(['bad']);
    expect(ix.unreadableIds()).toEqual([]);
  });

  it('keeps checking an item that mtime.json says is newer until its file arrives', async () => {
    // Dropbox has no order: the partner's mtime.json can land before their item file. Until the file
    // catches up, this mtime.json is not "handled", or a restart would never look again.
    const lib = new MemoryLibrary();
    lib.records.set('a', makeItem('a', { lastModified: 1000 }));
    lib.records.set('b', makeItem('b', { lastModified: 1000 }));
    lib.mtimeIndex = { a: 1000, b: 1000 };
    const ix = track(openIndex(testRef(), { dir: scratchDir('stale-hint'), fs: lib.fs() }));
    await ix.sync(lib);
    lib.mtimeIndex = { a: 5000, b: 1000 };
    lib.readIds = [];
    await ix.sync(lib); // reads the old copy of 'a'
    expect(lib.readIds).toEqual(['a']);
    lib.readIds = [];
    await ix.sync(lib);
    expect(lib.readIds).toEqual(['a']); // still behind: looked at again
    lib.records.set('a', makeItem('a', { lastModified: 5000, tags: ['from Sam'] }));
    const caught = await ix.sync(lib);
    expect(caught.changed).toEqual(['a']);
    lib.readIds = [];
    await ix.sync(lib);
    expect(lib.readIds).toEqual([]); // handled now: trusted until mtime.json changes again
  });

  it('verify stops when aborted, and after some of the throttled rounds', async () => {
    const lib = new MemoryLibrary();
    for (let i = 0; i < 500; i++)
      lib.records.set(`v${String(i).padStart(4, '0')}`, makeItem(`v${String(i).padStart(4, '0')}`));
    let stats = 0;
    const ctl = new AbortController();
    const fs = lib.fs();
    const ix = track(
      openIndex(testRef(), {
        dir: scratchDir('verify-abort'),
        fs: { ...fs, metaMtime: async (d) => (stats++, fs.metaMtime(d)) },
      }),
    );
    await ix.sync(lib);
    stats = 0;
    const run = ix.verify(lib, { chunk: 50, pauseMs: 5, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 20);
    await run;
    expect(stats).toBeGreaterThan(0);
    expect(stats).toBeLessThan(500);
  });

  it('refuses to treat an empty listing as "everything was deleted"', async () => {
    const lib = new MemoryLibrary();
    lib.records.set('a', makeItem('a'));
    const ix = track(openIndex(testRef(), { dir: scratchDir('empty-listing'), fs: lib.fs() }));
    await ix.sync(lib);
    lib.records.clear();
    await expect(ix.sync(lib)).rejects.toThrow(/looks empty/);
    expect(ix.counts().all).toBe(1);
  });

  it('stops on abort, keeps what it wrote, and finishes only the rest next time', async () => {
    const lib = new MemoryLibrary();
    for (let i = 0; i < 300; i++) {
      const id = `item${String(i).padStart(4, '0')}`;
      lib.records.set(
        id,
        makeItem(id, {
          palettes: [
            { color: [i % 256, 40, 90], ratio: 30 },
            { color: [200, i % 256, 10], ratio: 5 },
          ],
        }),
      );
    }
    const ix = track(
      openIndex(testRef(), {
        dir: scratchDir('abort'),
        fs: lib.fs(),
        concurrency: 4,
        batchSize: 25,
      }),
    );

    const ctl = new AbortController();
    const orig = lib.readItem.bind(lib);
    lib.readItem = async (id) => {
      if (lib.readIds.length >= 100) ctl.abort();
      return orig(id);
    };
    await expect(ix.sync(lib, undefined, ctl.signal)).rejects.toThrow();
    const kept = ix.counts().all;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(300);
    // Newest ids first (they start with the creation time), so the default view fills from the top.
    expect(lib.readIds[0]).toBe('item0299');
    // Anything read before the scan finishes is part of it, not an outside change.
    expect((await ix.refresh(lib, { ids: ['item0299'] })).firstScan).toBe(true);

    lib.readItem = orig;
    lib.readIds = [];
    const rest = await ix.sync(lib);
    expect(rest.firstScan).toBe(true); // the interrupted scan was never finished
    expect(rest.added).toHaveLength(300 - kept);
    expect(lib.readIds).toHaveLength(300 - kept);
    expect(ix.counts().all).toBe(300);
    expect(ix.db.prepare('SELECT count(*) FROM palette').pluck().get()).toBe(600);
    expect((await ix.refresh(lib, { ids: ['item0000'] })).firstScan).toBe(false);
  });

  it('reports scan progress', async () => {
    const lib = new MemoryLibrary();
    for (let i = 0; i < 40; i++)
      lib.records.set(`p${i}`.padEnd(13, '_'), makeItem(`p${i}`.padEnd(13, '_')));
    const ix = track(openIndex(testRef(), { dir: scratchDir('progress'), fs: lib.fs() }));
    const seen: { done: number; total: number }[] = [];
    await ix.sync(lib, (p) => seen.push({ ...p }));
    expect(seen[0]).toEqual({ done: 0, total: 40 });
    expect(seen.at(-1)).toEqual({ done: 40, total: 40 });
  });
});

describe('tags and hashes', () => {
  it('counts live items per tag and adds tags that exist only in a group', async () => {
    const lib = new MemoryLibrary({
      tagsGroups: [
        { id: 'G1', name: 'Subjects', tags: ['oil', 'unused'] },
        { id: 'G2', name: 'More', tags: ['oil'] },
      ],
    });
    lib.records.set('a', makeItem('a', { tags: ['oil', 'sketch'] }));
    lib.records.set('b', makeItem('b', { tags: ['oil'] }));
    lib.records.set('c', makeItem('c', { tags: ['oil', 'trashed-only'], isDeleted: true }));
    const ix = track(openIndex(testRef(), { dir: scratchDir('tags'), fs: lib.fs() }));
    await ix.sync(lib);
    expect(ix.tags()).toEqual([
      { name: 'oil', count: 2, groupIds: ['G1', 'G2'] },
      { name: 'sketch', count: 1, groupIds: [] },
      { name: 'unused', count: 0, groupIds: ['G1'] },
    ]);
  });

  it('keeps hashes valid only for the same size and file mtime', () => {
    const ix = track(openIndex(testRef(), { dir: scratchDir('hashes') }));
    ix.setHash('x', { size: 10, fileMtime: 100, md5: 'aaa' });
    ix.setHash('x', { size: 10, fileMtime: 100, dhash: 'ffff' }); // same file: both hashes known
    expect(ix.getHashes(['x'])[0]).toMatchObject({
      id: 'x',
      size: 10,
      fileMtime: 100,
      md5: 'aaa',
      dhash: 'ffff',
    });
    ix.setHash('x', { size: 11, fileMtime: 200, md5: 'bbb' }); // the file changed: old hashes are dropped
    expect(ix.getHashes(['x'])[0]).toMatchObject({
      size: 11,
      fileMtime: 200,
      md5: 'bbb',
      dhash: null,
    });
    ix.setHash('y', { size: 1, fileMtime: 1 });
    expect(
      ix
        .getHashes()
        .map((h) => h.id)
        .sort(),
    ).toEqual(['x', 'y']);
    expect(ix.getHashes(['nope'])).toEqual([]);
  });
});

describe('opening the database', () => {
  it('a big load runs with syncs off; if it never finished cleanly the index is rebuilt', async () => {
    const dir = scratchDir('unsynced');
    const lib = new MemoryLibrary();
    for (let i = 0; i < 1200; i++) lib.records.set(`u${i}`, makeItem(`u${i}`));
    const ref = testRef('big');
    const ix = openIndex(ref, { dir, fs: lib.fs() });
    await ix.sync(lib);
    expect(ix.db.pragma('synchronous', { simple: true })).toBe(1); // NORMAL again
    expect(ix.db.prepare("SELECT count(*) FROM meta WHERE key = 'unsynced'").pluck().get()).toBe(0);
    ix.close();

    // A crash or power cut during such a load leaves the flag behind: the file may be torn.
    const crashed = new Database(join(dir, 'big.sqlite'));
    crashed.prepare("INSERT INTO meta (key, value) VALUES ('unsynced', '1')").run();
    crashed.close();
    const reopened = openIndex(ref, { dir, fs: lib.fs() });
    expect(reopened.counts().all).toBe(0);
    reopened.close();
  });

  it('starts over when the schema version changed, the file is damaged, or the library path differs', async () => {
    const dir = scratchDir('open');
    const lib = new MemoryLibrary();
    lib.records.set('a', makeItem('a'));
    const ref = testRef('lib1');

    const one = openIndex(ref, { dir, fs: lib.fs() });
    await one.sync(lib);
    one.close();
    const reopened = openIndex(ref, { dir, fs: lib.fs() });
    expect(reopened.counts().all).toBe(1); // a real cache: still there
    reopened.close();

    const tamper = new Database(join(dir, 'lib1.sqlite'));
    tamper.prepare("UPDATE meta SET value = 'old' WHERE key = 'schema_version'").run();
    tamper.close();
    const rebuilt = openIndex(ref, { dir, fs: lib.fs() });
    expect(rebuilt.counts().all).toBe(0);
    expect(
      rebuilt.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").pluck().get(),
    ).toBe(SCHEMA_VERSION);
    await rebuilt.sync(lib);
    rebuilt.close();

    writeFileSync(
      join(dir, 'lib1.sqlite'),
      'this is not a database, it is a zero-filled Dropbox accident'.repeat(50),
    );
    const fromGarbage = openIndex(ref, { dir, fs: lib.fs() });
    expect(fromGarbage.counts().all).toBe(0);
    await fromGarbage.sync(lib);
    fromGarbage.close();

    const moved = openIndex({ ...ref, path: '/somewhere/else.library' }, { dir, fs: lib.fs() });
    expect(moved.counts().all).toBe(0);
    moved.close();
  });

  it('upgrades a version 3 index in place (no rescan): covering index and short-keyword table', async () => {
    const dir = scratchDir('migrate3');
    const lib = new MemoryLibrary();
    lib.records.set('a', makeItem('a', { name: 'Élan', tags: ['Oil'] }));
    const ref = testRef('v3');
    const ix = openIndex(ref, { dir, fs: lib.fs() });
    await ix.sync(lib);
    ix.close();
    // Make it look like a v3 file: no item_search, the old index instead of items_all.
    const old = new Database(join(dir, 'v3.sqlite'));
    old.exec(`DROP TABLE item_search; DROP INDEX items_all;
      CREATE INDEX items_imported ON items(is_deleted, imported_at);
      UPDATE meta SET value = '3' WHERE key = 'schema_version';`);
    old.close();

    const up = track(openIndex(ref, { dir, fs: lib.fs() }));
    expect(up.counts().all).toBe(1); // kept, not rebuilt
    const names = up.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .pluck()
      .all();
    expect(names).toContain('items_all');
    expect(names).not.toContain('items_imported');
    expect(up.db.prepare('SELECT text FROM item_search').pluck().all()).toEqual([
      ['élan', 'oil', '', '', '', 'jpg', '', ''].join('\n'),
    ]);
    expect(up.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").pluck().get()).toBe(
      SCHEMA_VERSION,
    );
  });

  it('defaults to <cache>/index under BOOGIE_HOME', () => {
    const home = scratchDir('home');
    const prev = process.env.BOOGIE_HOME;
    process.env.BOOGIE_HOME = home;
    try {
      const ix = indexes.open(testRef('defaultdir')) as SqliteLibraryIndex;
      ix.close();
      expect(existsSync(join(home, 'cache', 'index', 'defaultdir.sqlite'))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.BOOGIE_HOME;
      else process.env.BOOGIE_HOME = prev;
    }
  });
});
