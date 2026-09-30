import { mkdirSync, readFileSync, renameSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collector, externalWrite, fakeLib, makeLibrary, sleep, waitFor } from './testUtil';
import { createWatcher, type PokeableWatcher, type WatcherOptions } from './watcher';

const FAST: WatcherOptions = { pollMs: 100, itemDebounceMs: 100, rootDebounceMs: 30 };
const A = 'MKG8VYYQTA5SW';
const B = 'MKGA0LUUPY9BM';
const NEW_ID = 'MNEWITEM00001'; // 13 chars, like Eagle's ids

const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((c) => c()),
);

/** A copy of the test library with a watcher started on it and a baseline already taken. */
async function setup(
  opts: WatcherOptions = FAST,
  selfWrites = new Map<string, number>(),
  mtime: Record<string, number> = { [A]: 1000, [B]: 2000, all: 3 },
  raises: string[] = [],
) {
  const lib = makeLibrary();
  cleanups.push(lib.cleanup);
  externalWrite(join(lib.root, 'mtime.json'), JSON.stringify(mtime));
  const c = collector();
  const w: PokeableWatcher = createWatcher(opts);
  cleanups.push(() => w.stop());
  w.start(fakeLib(lib.root, selfWrites, raises), c.events);
  await w.poke(); // waits for the baseline, then one poll
  const writeMtime = (m: Record<string, number>) =>
    externalWrite(join(lib.root, 'mtime.json'), JSON.stringify(m));
  const rootPath = join(lib.root, 'metadata.json');
  const rootText = readFileSync(rootPath, 'utf8');
  const rootMod = JSON.parse(rootText).modificationTime as number;
  const writeRoot = (mod: number, text = rootText) =>
    externalWrite(
      rootPath,
      text.replace(`"modificationTime":${rootMod}}`, `"modificationTime":${mod}}`),
    );
  return { lib, c, w, writeMtime, writeRoot, rootMod, rootText, rootPath, selfWrites };
}

describe('mtime.json', () => {
  it('reports a raised id within 3 s with the default timings', async () => {
    const t = await setup({}); // default pollMs 2000
    const started = Date.now();
    t.writeMtime({ [A]: 1000, [B]: 2500, all: 3 });
    await waitFor(() => t.c.items.length > 0, 3000, 'items event');
    expect(Date.now() - started).toBeLessThan(3000);
    expect(t.c.items).toEqual([{ ids: [B], listDir: false }]);
  });

  it('ignores an unchanged file, a size-0 file, and entries Eagle drops and re-adds', async () => {
    const t = await setup();
    externalWrite(join(t.lib.root, 'mtime.json'), ''); // size 0: ignored
    await t.w.poke();
    t.writeMtime({ [A]: 1000, all: 3 }); // Eagle rebuilt its map without B
    await t.w.poke();
    t.writeMtime({ [A]: 1000, [B]: 2000, all: 3 }); // and put it back, same value
    await t.w.poke();
    expect(t.c.items).toEqual([]);
  });

  it('a new id and a changed item count ask for a listing; a removal alone does too', async () => {
    const t = await setup();
    t.writeMtime({ [A]: 1000, [B]: 2000, [NEW_ID]: 3000, all: 4 });
    await waitFor(() => t.c.items.length === 1);
    expect(t.c.items[0]).toEqual({ ids: [NEW_ID], listDir: true });
    t.writeMtime({ [A]: 1000, [NEW_ID]: 3000, all: 3 }); // the partner deleted B
    await waitFor(() => t.c.items.length === 2);
    expect(t.c.items[1]).toEqual({ ids: [], listDir: true });
  });

  it('a half-written mtime.json is not an event; the finished one is', async () => {
    const t = await setup();
    externalWrite(join(t.lib.root, 'mtime.json'), '{"MKG8VYYQTA5SW":1000,"MKGA0LUU', {
      atomic: false,
    });
    await t.w.poke();
    expect(t.c.items).toEqual([]);
    t.writeMtime({ [A]: 1000, [B]: 2600, all: 3 });
    await waitFor(() => t.c.items.length === 1);
    expect(t.c.items[0]!.ids).toEqual([B]);
  });
});

describe('images/ folders', () => {
  it('reports a new item folder once the burst goes quiet, and ignores temp and oddly named entries', async () => {
    const t = await setup();
    const images = join(t.lib.root, 'images');
    mkdirSync(join(images, 'short.info'));
    externalWrite(join(images, '.DS_Store'), 'x');
    externalWrite(join(images, `~$${NEW_ID}.info.tmp`), 'x');
    await sleep(400);
    expect(t.c.items).toEqual([]);

    mkdirSync(join(images, `${NEW_ID}.info`));
    mkdirSync(join(images, 'MNEWITEM00002.info'));
    await waitFor(() => t.c.items.length > 0, 3000, 'items event for the new folders');
    await sleep(300);
    expect(t.c.items).toHaveLength(1); // one debounced batch, not one call per folder
    expect(t.c.items[0]!.listDir).toBe(true);
    expect([...t.c.items[0]!.ids].sort()).toEqual([NEW_ID, 'MNEWITEM00002']);
  });

  it('follows an images/ folder that was moved away and replaced, and asks for a listing', async () => {
    const t = await setup();
    const images = join(t.lib.root, 'images');
    renameSync(images, `${images}.old`); // no event reaches a watcher of `images/` for this
    mkdirSync(images);
    await t.w.poke(); // sees the new inode: re-opens and asks for a listing
    expect(t.c.items).toEqual([{ ids: [], listDir: true }]);
    mkdirSync(join(`${images}.old`, 'MOLDFOLDER001.info')); // the old folder is not watched any more
    mkdirSync(join(images, `${NEW_ID}.info`));
    await waitFor(() => t.c.items.length > 1, 3000, 'items event from the new folder');
    await sleep(300);
    expect(t.c.items.slice(1)).toEqual([{ ids: [NEW_ID], listDir: true }]);
  });

  it('reports a folder that disappears', async () => {
    const t = await setup();
    rmSync(join(t.lib.root, 'images', `${A}.info`), { recursive: true });
    await waitFor(() => t.c.items.length > 0, 3000, 'items event for the removed folder');
    expect(t.c.items[0]).toEqual({ ids: [A], listDir: true });
  });
});

// Dropbox has no order: a report can arrive before the file it is about.
describe('files that arrive after their report', () => {
  const meta = (root: string, id: string) => join(root, 'images', `${id}.info`, 'metadata.json');

  it('an mtime.json raise that lands before the item file is reported again when the file does', async () => {
    const t = await setup();
    const lm = Date.now() + 5_000; // newer than A's file
    t.writeMtime({ [A]: lm, [B]: 2000, all: 3 });
    await t.w.poke();
    expect(t.c.items).toEqual([{ ids: [A], listDir: false }]); // the index reads the old copy now
    await t.w.poke();
    expect(t.c.items).toHaveLength(1); // nothing new yet
    const rec = JSON.parse(readFileSync(meta(t.lib.root, A), 'utf8'));
    externalWrite(meta(t.lib.root, A), JSON.stringify({ ...rec, tags: ['sam'], lastModified: lm }));
    await t.w.poke();
    expect(t.c.items).toEqual([
      { ids: [A], listDir: false },
      { ids: [A], listDir: false },
    ]);
    await t.w.poke();
    expect(t.c.items).toHaveLength(2); // arrived: no longer watched
  });

  it('a new item folder whose metadata.json comes later is reported again when it does', async () => {
    const t = await setup();
    mkdirSync(join(t.lib.root, 'images', `${NEW_ID}.info`));
    await waitFor(() => t.c.items.length > 0, 3000, 'items event for the new folder');
    externalWrite(meta(t.lib.root, NEW_ID), JSON.stringify({ id: NEW_ID, lastModified: 1 }));
    await waitFor(() => t.c.items.length > 1, 3000, 'items event for its metadata.json');
    expect(t.c.items[1]).toEqual({ ids: [NEW_ID], listDir: false });
  });

  it('a file that never arrives is given up on after recheckMs', async () => {
    const t = await setup({ ...FAST, recheckMs: 200 });
    t.writeMtime({ [A]: Date.now() + 5_000, [B]: 2000, all: 3 });
    await t.w.poke();
    await sleep(300);
    await t.w.poke(); // past the deadline, unchanged: dropped
    const rec = JSON.parse(readFileSync(meta(t.lib.root, A), 'utf8'));
    externalWrite(
      meta(t.lib.root, A),
      JSON.stringify({ ...rec, lastModified: Date.now() + 9_000 }),
    );
    await t.w.poke();
    expect(t.c.items).toHaveLength(1);
  });
});

describe('root metadata.json', () => {
  it('fires only when modificationTime goes up, and treats a truncated file as still syncing', async () => {
    const t = await setup();
    const first = JSON.stringify(JSON.parse(t.rootText).folders[0].name);
    t.writeRoot(t.rootMod, t.rootText.replace(first, '"Renamed"')); // content changed, same time
    await t.w.poke();
    t.writeRoot(t.rootMod - 5000);
    await t.w.poke();
    expect(t.c.roots()).toBe(0);

    externalWrite(t.rootPath, t.rootText.slice(0, 120), { atomic: false }); // cut off mid-write
    await t.w.poke();
    expect(t.c.roots()).toBe(0);

    t.writeRoot(t.rootMod + 1000); // the finished file
    await waitFor(() => t.c.roots() === 1);
    await sleep(300);
    expect(t.c.roots()).toBe(1);
  });
});

describe('our own writes', () => {
  it('skips items, root and folders the adapter just wrote, but not newer changes from someone else', async () => {
    const self = new Map<string, number>();
    const t = await setup(FAST, self);
    const T = Date.now();

    // item: adapter wrote A at T and raised mtime.json to T
    self.set(`images/${A}.info/metadata.json`, T);
    t.writeMtime({ [A]: T, [B]: 2000, all: 3 });
    await t.w.poke();
    expect(t.c.items).toEqual([]);
    // The partner edits it a moment later (value newer than our write): that one must get through
    t.writeMtime({ [A]: T + 4000, [B]: 2000, all: 3 });
    await waitFor(() => t.c.items.length === 1);
    expect(t.c.items[0]).toEqual({ ids: [A], listDir: false });

    // root: adapter wrote it with modificationTime T
    self.set('metadata.json', T + 5);
    t.writeRoot(T);
    await t.w.poke();
    expect(t.c.roots()).toBe(0);
    t.writeRoot(T + 60_000); // someone else, later
    await waitFor(() => t.c.roots() === 1);

    // a new item folder we created (plus its mtime.json entry and item count)
    self.set(`images/${NEW_ID}.info/metadata.json`, T);
    mkdirSync(join(t.lib.root, 'images', `${NEW_ID}.info`));
    t.writeMtime({ [A]: T + 4000, [B]: 2000, [NEW_ID]: T, all: 4 });
    await sleep(500);
    expect(t.c.items).toHaveLength(1); // still only the partner's edit from above

    // a folder we did not create
    mkdirSync(join(t.lib.root, 'images', 'MNEWITEM00002.info'));
    await waitFor(() => t.c.items.length === 2);
    expect(t.c.items[1]).toEqual({ ids: ['MNEWITEM00002'], listDir: true });
  });
});

// Eagle rewrites mtime.json from memory ~3 s after its own saves (test/eagle-proof FINDINGS 2).
describe("a partner's Eagle", () => {
  it('a rewrite that lowers or drops our raises is foreign, and hands over what we raised lately', async () => {
    const self = new Map<string, number>();
    const t = await setup(FAST, self, undefined, [A, NEW_ID]);
    const T = Date.now();
    // Our flush: A raised, a new item added.
    self.set(`images/${A}.info/metadata.json`, T);
    self.set(`images/${NEW_ID}.info/metadata.json`, T);
    self.set('mtime.json', T);
    t.writeMtime({ [A]: T, [B]: 2000, [NEW_ID]: T, all: 4 });
    await t.w.poke();
    expect(t.c.foreign).toEqual([]);
    expect(t.c.items).toEqual([]);
    // Eagle's rewrite from memory: A back to what it knew, our new item dropped. Dropbox keeps
    // the writer's file time, which here is older than our write.
    const eagleText = JSON.stringify({ [A]: 1000, [B]: 2000, all: 3 });
    externalWrite(join(t.lib.root, 'mtime.json'), eagleText);
    utimesSync(join(t.lib.root, 'mtime.json'), new Date(T - 2000), new Date(T - 2000));
    await t.w.poke();
    expect(t.c.foreign).toHaveLength(1);
    expect(t.c.foreign[0]!.raisedByUs).toEqual([A, NEW_ID]);
    expect(t.c.foreign[0]!.at).toBeLessThanOrEqual(T - 1000); // when it was written, not when it arrived
  });

  it("a rewrite with the partner's own raise is foreign even right after ours; ours alone is not", async () => {
    const self = new Map<string, number>();
    const t = await setup(FAST, self);
    const T = Date.now();
    self.set(`images/${A}.info/metadata.json`, T);
    self.set('mtime.json', T);
    t.writeMtime({ [A]: T, [B]: 2000, all: 3 });
    await t.w.poke();
    expect(t.c.foreign).toEqual([]);
    t.writeMtime({ [A]: T, [B]: T + 500, all: 3 }); // the partner saved B
    await t.w.poke();
    expect(t.c.foreign).toHaveLength(1);
    expect(t.c.items).toEqual([{ ids: [B], listDir: false }]);
  });

  it('their raise is theirs even when its value is older than our write of the same item (it arrived late)', async () => {
    const lib = makeLibrary();
    cleanups.push(lib.cleanup);
    externalWrite(join(lib.root, 'mtime.json'), JSON.stringify({ [A]: 1000, all: 3 }));
    const T = Date.now();
    const self = new Map([[`images/${A}.info/metadata.json`, T + 50]]); // we wrote A just now
    const values = new Map<string, number>();
    const c = collector();
    const w = createWatcher(FAST);
    cleanups.push(() => w.stop());
    w.start(fakeLib(lib.root, self, [], values), c.events);
    await w.poke();
    externalWrite(join(lib.root, 'mtime.json'), JSON.stringify({ [A]: T, all: 3 })); // their save, T
    await w.poke();
    expect(c.items).toEqual([{ ids: [A], listDir: false }]);
    values.set(A, T + 60); // then our own flush
    externalWrite(join(lib.root, 'mtime.json'), JSON.stringify({ [A]: T + 60, all: 3 }));
    await w.poke();
    expect(c.items).toHaveLength(1);
  });

  it('any rewrite while we have not written mtime.json lately is foreign; the same bytes are not', async () => {
    const t = await setup();
    const text = readFileSync(join(t.lib.root, 'mtime.json'), 'utf8');
    externalWrite(join(t.lib.root, 'mtime.json'), text); // same content, new file
    await t.w.poke();
    expect(t.c.foreign).toEqual([]);
    t.writeMtime({ [B]: 2000, [A]: 1000, all: 3 }); // Eagle's own key order
    await t.w.poke();
    expect(t.c.foreign).toHaveLength(1);
  });

  it('a value that went down is read again (a save by a partner whose clock is behind ours)', async () => {
    const t = await setup();
    t.writeMtime({ [A]: 5000, [B]: 2000, all: 3 });
    await t.w.poke();
    t.c.items.length = 0;
    t.writeMtime({ [A]: 4000, [B]: 2000, all: 3 });
    await t.w.poke();
    expect(t.c.items).toEqual([{ ids: [A], listDir: false }]);
    expect(t.c.foreign).toHaveLength(2);
  });

  it("another Boogie's flush (only raises, every value marked) is item changes, not the partner's Eagle", async () => {
    const t = await setup();
    const marked = 1_790_000_000_373; // eagle/stamp.ts: Boogie's values end in 373 ms
    t.writeMtime({ [A]: marked, [B]: 2000, all: 3 });
    await t.w.poke();
    expect(t.c.items).toEqual([{ ids: [A], listDir: false }]);
    expect(t.c.foreign).toEqual([]);
    t.writeMtime({ [A]: marked, [B]: 1_790_000_001_120, all: 3 }); // an Eagle save: not marked
    await t.w.poke();
    expect(t.c.foreign).toHaveLength(1);
    expect(t.c.foreign[0]!.byBoogie).toBeUndefined();
  });

  it("an Eagle save that happens to end in the mark is still Eagle's: its stamp is fresh", async () => {
    const t = await setup();
    const fresh = Math.floor(Date.now() / 1000) * 1000 - 1000 + 373; // under 2 s old
    t.writeMtime({ [A]: 1000, [B]: fresh, all: 3 });
    await t.w.poke();
    expect(t.c.foreign).toHaveLength(1);
  });

  it("another Boogie's write that dropped one of ours is reported as such (ours is sent again)", async () => {
    const t = await setup();
    t.writeMtime({ [A]: 1000, [B]: 1_790_000_000_373 }); // dropped nothing yet: B raised, marked
    await t.w.poke();
    expect(t.c.foreign).toEqual([]);
    t.writeMtime({ [B]: 1_790_000_005_373 }); // its older copy of the file lacks A
    await t.w.poke();
    expect(t.c.foreign).toHaveLength(1);
    expect(t.c.foreign[0]!.byBoogie).toBe(true);
  });

  it('tags.json and saved-filters.json changes are reported, our own writes are not', async () => {
    const self = new Map<string, number>();
    const t = await setup(FAST, self);
    self.set('tags.json', Date.now() + 1000);
    externalWrite(join(t.lib.root, 'tags.json'), '{"historyTags":[],"starredTags":["mine"]}');
    await t.w.poke();
    expect(t.c.rootFiles).toEqual([]);
    self.clear();
    externalWrite(join(t.lib.root, 'saved-filters.json'), '[{"name":"x","rule":{}}]');
    externalWrite(join(t.lib.root, 'tags.json'), '{"historyTags":[],"starredTags":["theirs"]}');
    await t.w.poke();
    expect(t.c.rootFiles.sort()).toEqual(['savedFilters', 'tags']);
  });
});

describe('conflicted copies at the root', () => {
  it('reports the full list when one appears, and again when it is gone', async () => {
    const t = await setup();
    const name = "metadata (Sam Lee's conflicted copy 2026-09-28).json";
    externalWrite(join(t.lib.root, name), '{}');
    await waitFor(() => t.c.conflicts.length === 1);
    expect(t.c.conflicts[0]!.map((f) => [f.path, f.kind])).toEqual([[name, 'root']]);
    await t.w.poke();
    expect(t.c.conflicts).toHaveLength(1); // not repeated while nothing changed
    rmSync(join(t.lib.root, name));
    await waitFor(() => t.c.conflicts.length === 2);
    expect(t.c.conflicts[1]).toEqual([]);
  });

  it('reports copies that were already there when the watcher started', async () => {
    const lib = makeLibrary();
    cleanups.push(lib.cleanup);
    externalWrite(join(lib.root, 'mtime (conflicted copy 2026-09-28).json'), '{}');
    const c = collector();
    const w = createWatcher(FAST);
    cleanups.push(() => w.stop());
    w.start(fakeLib(lib.root), c.events);
    await waitFor(() => c.conflicts.length === 1);
    expect(c.conflicts[0]![0]!.kind).toBe('mtime');
  });
});

describe('poke and stop', () => {
  it('poke() checks right away, even with a very slow poll', async () => {
    const t = await setup({ pollMs: 60_000, itemDebounceMs: 100, rootDebounceMs: 60_000 });
    t.writeMtime({ [A]: 1000, [B]: 9999, all: 3 });
    await t.w.poke();
    expect(t.c.items).toEqual([{ ids: [B], listDir: false }]);
  });

  it('stop() leaves no watchers or timers behind and stays quiet', async () => {
    const counts = () => {
      const r = process.getActiveResourcesInfo();
      return {
        fs: r.filter((x) => x === 'FSEventWrap').length,
        timers: r.filter((x) => x === 'Timeout').length,
      };
    };
    const lib = makeLibrary();
    cleanups.push(lib.cleanup);
    await sleep(150); // let handles that earlier tests closed finish closing
    await new Promise((r) => setImmediate(r));
    const before = counts();
    const c = collector();
    const w = createWatcher({ ...FAST, pollMs: 60_000 }); // a timer that would outlive the test if stop() forgot it
    w.start(fakeLib(lib.root), c.events);
    await w.poke();
    expect(counts().timers).toBeGreaterThan(before.timers);
    expect(counts().fs).toBe(before.fs + 2); // root and images/, never one per item
    w.stop();
    await waitFor(
      () => counts().fs === before.fs && counts().timers <= before.timers,
      1000,
      'watchers and timers to be released',
    );

    externalWrite(join(lib.root, 'mtime.json'), JSON.stringify({ [A]: 123456, all: 3 }));
    mkdirSync(join(lib.root, 'images', `${NEW_ID}.info`));
    await sleep(400);
    expect(c.items).toEqual([]);
    w.stop(); // twice is fine
    await w.poke(); // poking a stopped watcher is a no-op
  });
});
