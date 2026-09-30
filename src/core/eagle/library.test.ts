import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EagleItemRecord } from '../../shared/types';
import type { NewItemInit } from '../contracts';
import { WriteBlockedError, setWritableRoots } from '../safety/writeGuard';
import { tempNameFor, writeFileAtomic } from './atomic';
import { addTags, removeTags, restore, setStar, trash } from './edits';
import {
  ItemNotFoundError,
  ItemUnreadableError,
  LibraryUnreadableError,
  PartialWriteError,
  ReadOnlyError,
  UnsupportedVersionError,
} from './errors';
import { openLibrary } from './library';
import { buildItemRecord } from './newItem';
import { isBlankOrNul } from './json';
import { addFolder, renameFolder } from './root';
import { SKEW_MARGIN_MS, isBoogieStamp } from './stamp';
import {
  FakeJournal,
  TMP,
  allowTmp,
  cleanup,
  copyTemplate,
  ctx,
  openLib,
  readJson,
  readText,
  scratch,
  writeText,
} from './testkit';

const A = 'LT24XY3DPJFLK'; // 0051.jpg, has manual `order` and a tag
const B = 'MKG8VYYQTA5SW';
const C = 'MKGA0LUUPY9BM';

beforeAll(allowTmp);
afterAll(async () => {
  setWritableRoots([]);
  await cleanup();
});

const metaPath = (lib: string, id: string) => join(lib, 'images', `${id}.info`, 'metadata.json');

describe('editing an item', () => {
  it('adds a tag with exact bytes, bumps lastModified, raises mtime.json, and journals before/after', async () => {
    const path = await copyTemplate();
    const { lib, journal } = await openLib(path);
    const beforeText = await readText(metaPath(path, A));
    const t0 = Date.now();
    const w = await lib.updateItem(
      A,
      (rec) => addTags(rec, ['  new tag  ', 'Atelier Gerome']),
      ctx,
    );
    expect(w).not.toBeNull();
    const expected = JSON.parse(beforeText);
    expected.tags.push('new tag'); // trimmed; the duplicate is ignored; existing order kept
    expected.lastModified = w!.lastModified; // it already had the key, so it keeps its slot
    expect(await readText(metaPath(path, A))).toBe(JSON.stringify(expected));
    // A minute in the past (a partner Eagle whose clock is behind ours still re-reads it), marked.
    expect(w!.lastModified).toBeGreaterThanOrEqual(t0 - SKEW_MARGIN_MS);
    expect(w!.lastModified).toBeLessThan(Date.now() - SKEW_MARGIN_MS + 1000);
    expect(isBoogieStamp(w!.lastModified)).toBe(true);
    expect(w!.before).toBe(beforeText);
    expect(w!.after).toBe(JSON.stringify(expected));
    expect(journal.files).toEqual([
      {
        relPath: `images/${A}.info/metadata.json`,
        before: beforeText,
        after: JSON.stringify(expected),
        itemId: A,
      },
    ]);

    await lib.flushMtime();
    const mtimeText = await readText(join(path, 'mtime.json'));
    expect(mtimeText).toBe(JSON.stringify({ [A]: w!.lastModified, all: 3 }));
    expect(Object.keys(JSON.parse(mtimeText)).at(-1)).toBe('all');
    expect(lib.recentSelfWrites().has(`images/${A}.info/metadata.json`)).toBe(true);
    expect(lib.recentSelfWrites().has('mtime.json')).toBe(true);
    await lib.close();
  });

  it('appends lastModified when the record had none, and never lets it go backwards', async () => {
    const path = await copyTemplate();
    const rec = await readJson<EagleItemRecord>(metaPath(path, B));
    delete rec.lastModified;
    await writeText(metaPath(path, B), JSON.stringify(rec));
    const future = Date.now() + 3_600_000; // this machine's clock is behind whoever wrote it
    const recC = await readJson<EagleItemRecord>(metaPath(path, C));
    recC.lastModified = future;
    await writeText(metaPath(path, C), JSON.stringify(recC));
    const { lib } = await openLib(path);
    const wB = await lib.updateItem(B, (r) => setStar(r, 3), ctx);
    expect(Object.keys(JSON.parse(wB!.after!)).at(-1)).toBe('lastModified');
    const wC = await lib.updateItem(C, (r) => setStar(r, 2), ctx);
    expect(wC!.lastModified).toBe(future + 1); // plain: marking would push it further ahead
    await lib.close();
  });

  it("stays newer than the root it follows (Eagle unfiles an older item whose folder it doesn't know)", async () => {
    const path = await copyTemplate();
    const { lib } = await openLib(path);
    const root = await lib.updateRoot(
      (r) => void addFolder(r, { name: 'New', parentId: null }),
      ctx,
    );
    const rootTime = JSON.parse(root!.after).modificationTime as number;
    expect(isBoogieStamp(rootTime)).toBe(true);
    expect(rootTime).toBeLessThan(Date.now() - SKEW_MARGIN_MS + 1000); // backdated like items
    const w1 = await lib.updateItem(A, (r) => addTags(r, ['x']), ctx);
    expect(w1!.lastModified).toBeGreaterThan(rootTime);
    // A root saved by a partner whose clock is ahead of ours: the next item still goes above it.
    const rootRec = await readJson<Record<string, unknown>>(join(path, 'metadata.json'));
    const ahead = Date.now() + 30_000;
    await writeText(
      join(path, 'metadata.json'),
      JSON.stringify({ ...rootRec, modificationTime: ahead }),
    );
    const w2 = await lib.updateItem(B, (r) => addTags(r, ['x']), ctx);
    expect(w2!.lastModified).toBe(ahead + 1);
    await lib.close();
  });

  it('skips when nothing changes: no write, no journal entry, no mtime entry', async () => {
    const path = await copyTemplate();
    const { lib, journal } = await openLib(path);
    const before = await readText(metaPath(path, A));
    expect(await lib.updateItem(A, () => false, ctx)).toBeNull();
    expect(await lib.updateItem(A, (r) => addTags(r, ['Atelier Gerome']), ctx)).toBeNull();
    expect(await lib.updateItem(A, (r) => void (r.tags = [...r.tags]), ctx)).toBeNull();
    await expect(lib.updateItem(A, (async () => true) as never, ctx)).rejects.toThrow(
      /synchronous/,
    );
    expect(await readText(metaPath(path, A))).toBe(before);
    expect(journal.files).toEqual([]);
    await lib.flushMtime();
    expect(await readText(join(path, 'mtime.json'))).toBe('{}');
    await lib.close();
  });

  it('unrate deletes star, trash appends deletedTime, restore deletes it', async () => {
    const path = await copyTemplate();
    const { lib } = await openLib(path);
    await lib.updateItem(A, (r) => setStar(r, 4), ctx);
    let rec = await readJson(metaPath(path, A));
    expect(rec.star).toBe(4);
    expect(Object.keys(rec).at(-1)).toBe('star'); // appended after lastModified
    await lib.updateItem(A, (r) => setStar(r, 0), ctx);
    rec = await readJson(metaPath(path, A));
    expect('star' in rec).toBe(false);

    const now = Date.now();
    await lib.updateItem(A, (r) => trash(r, now), ctx);
    rec = await readJson(metaPath(path, A));
    expect(rec).toMatchObject({ isDeleted: true, deletedTime: now });
    expect(Object.keys(rec).at(-1)).toBe('deletedTime');
    expect(await lib.updateItem(A, (r) => trash(r, now + 5), ctx)).toBeNull(); // already in the trash

    await lib.updateItem(A, restore, ctx);
    rec = await readJson(metaPath(path, A));
    expect(rec.isDeleted).toBe(false);
    expect('deletedTime' in rec).toBe(false);
    await lib.close();
  });

  it('refuses to write over a file it cannot parse, and leaves it untouched', async () => {
    const path = await copyTemplate();
    const { lib, journal } = await openLib(path);
    await writeText(metaPath(path, A), '{"id":"LT24XY3DPJFLK","name":"0051","tags":["a"');
    const damaged = await readText(metaPath(path, A));
    await expect(lib.updateItem(A, (r) => addTags(r, ['x']), ctx)).rejects.toBeInstanceOf(
      ItemUnreadableError,
    );
    expect(await readText(metaPath(path, A))).toBe(damaged);
    expect(await lib.readItem(A)).toBeNull();

    await writeText(metaPath(path, B), '\0'.repeat(575)); // zero-filled, like 380 files in the Art library
    await expect(lib.updateItem(B, (r) => addTags(r, ['x']), ctx)).rejects.toBeInstanceOf(
      ItemUnreadableError,
    );
    expect(isBlankOrNul(await readText(metaPath(path, B)))).toBe(true);
    await expect(
      lib.updateItem('AAAAAAAAAAAAA', (r) => addTags(r, ['x']), ctx),
    ).rejects.toBeInstanceOf(ItemNotFoundError);
    expect(journal.files).toEqual([]);
    await lib.close();
  });

  it('refuses to write a file whose bytes are not valid UTF-8 (a write would bake in U+FFFD)', async () => {
    const path = await copyTemplate();
    const bad = Buffer.concat([
      Buffer.from('{"id":"LT24XY3DPJFLK","name":"caf'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('","tags":[]}'),
    ]);
    await writeFile(metaPath(path, A), bad);
    const rootBad = Buffer.concat([
      Buffer.from('{"applicationVersion":"4.0.0","folders":[],"note":"'),
      Buffer.from([0xc3]),
      Buffer.from('","smartFolders":[],"quickAccess":[],"tagsGroups":[],"modificationTime":1}'),
    ]);
    await writeFile(join(path, 'metadata.json'), rootBad);
    const { lib } = await openLib(path);
    await expect(lib.updateItem(A, (r) => addTags(r, ['x']), ctx)).rejects.toBeInstanceOf(
      ItemUnreadableError,
    );
    await expect(
      lib.updateRoot((r) => void addFolder(r, { name: 'x' }), ctx),
    ).rejects.toBeInstanceOf(LibraryUnreadableError);
    expect(await readFile(metaPath(path, A))).toEqual(bad);
    expect(await readFile(join(path, 'metadata.json'))).toEqual(rootBad);
    await lib.close();
  });

  it('waits out an empty file (Eagle empties a file before filling it) instead of giving up', async () => {
    const path = await copyTemplate();
    const good = await readText(metaPath(path, A));
    await writeFile(metaPath(path, A), '');
    const { lib } = await openLib(path, { retryDelayMs: 150 });
    setTimeout(() => void writeFile(metaPath(path, A), good), 40);
    const w = await lib.updateItem(A, (r) => addTags(r, ['x']), ctx);
    expect(w).not.toBeNull();
    expect((await readJson(metaPath(path, A))).tags).toContain('x');
    await lib.close();
  });

  it('never writes an id that is not the folder name, and puts id first', async () => {
    const path = await copyTemplate();
    const { lib } = await openLib(path);
    await lib.updateItem(
      A,
      (r) => {
        const { id, ...rest } = r;
        for (const k of Object.keys(r)) delete (r as any)[k];
        Object.assign(r, rest, { id: 'SOMETHINGELSE' });
        return true;
      },
      ctx,
    );
    const rec = await readJson(metaPath(path, A));
    expect(Object.keys(rec)[0]).toBe('id');
    expect(rec.id).toBe(A);
    await lib.close();
  });

  it('two edits of the same item at once both land (no lost update)', async () => {
    const path = await copyTemplate();
    const { lib } = await openLib(path);
    await Promise.all(
      ['one', 'two', 'three', 'four'].map((t) => lib.updateItem(A, (r) => addTags(r, [t]), ctx)),
    );
    const rec = await readJson(metaPath(path, A));
    expect(rec.tags.sort()).toEqual(['Atelier Gerome', 'four', 'one', 'three', 'two']);
    await lib.close();
  });

  it('tolerates a string modificationTime, trailing whitespace, and unknown keys, and keeps them', async () => {
    const path = await copyTemplate();
    const rec = await readJson(metaPath(path, A));
    rec.modificationTime = '1779741123280.51';
    rec.xNative = { keep: 'me' };
    await writeText(metaPath(path, A), JSON.stringify(rec) + '\n');
    const { lib } = await openLib(path);
    const doc = await lib.readItem(A);
    expect(doc!.value.modificationTime).toBe('1779741123280.51');
    await lib.updateItem(A, (r) => removeTags(r, ['Atelier Gerome']), ctx);
    const after = await readJson(metaPath(path, A));
    expect(after.modificationTime).toBe('1779741123280.51');
    expect(after.xNative).toEqual({ keep: 'me' });
    expect(after.tags).toEqual([]);
    expect((await readText(metaPath(path, A))).endsWith('\n')).toBe(false); // no trailing newline, ever
    await lib.close();
  });
});

describe('updateItems', () => {
  it('writes each item once, in input order, skips missing ones, and reports why', async () => {
    const path = await copyTemplate();
    const { lib } = await openLib(path);
    const skipped: [string, string][] = [];
    const writes = await lib.updateItems(
      [C, A, 'ZZZZZZZZZZZZZ', A, 'nope', B],
      (r) => addTags(r, ['batch']),
      ctx,
      (id, why) => skipped.push([id, why]),
    );
    expect(writes.map((w) => w.id)).toEqual([C, A, B]);
    expect(skipped.map(([id]) => id).sort()).toEqual(['ZZZZZZZZZZZZZ', 'nope']);
    for (const id of [A, B, C])
      expect((await readJson(metaPath(path, id))).tags).toContain('batch');
    await lib.flushMtime();
    const mtime = await readJson(join(path, 'mtime.json'));
    expect(Object.keys(mtime).sort()).toEqual([A, B, C, 'all'].sort());
    await lib.close();
  });

  it('a hard failure after some writes throws PartialWriteError with the writes that landed', async () => {
    const path = await copyTemplate();
    const { lib } = await openLib(path);
    await chmod(join(path, 'images', `${C}.info`), 0o555); // no temp file can be made in C's folder
    let err: unknown;
    try {
      await lib.updateItems([A, B, C], (r) => addTags(r, ['x']), ctx);
    } catch (e) {
      err = e;
    } finally {
      await chmod(join(path, 'images', `${C}.info`), 0o755);
    }
    expect(err).toBeInstanceOf(PartialWriteError);
    const landed = (err as PartialWriteError).writes.map((w) => w.id);
    expect(landed).toEqual([A, B]);
    expect(((err as PartialWriteError).cause as NodeJS.ErrnoException).code).toBe('EACCES');
    for (const id of landed) expect((await readJson(metaPath(path, id))).tags).toContain('x');
    expect((await readJson(metaPath(path, C))).tags).not.toContain('x');
    await lib.close();
  });
});

describe('the write guard and read-only mode', () => {
  it('a library outside the writable roots: every write throws WriteBlockedError and changes nothing', async () => {
    const path = await copyTemplate();
    const { lib } = await openLib(path);
    setWritableRoots([join(TMP, 'not-this-one')]);
    try {
      const before = await readText(metaPath(path, A));
      const rootBefore = await readText(join(path, 'metadata.json'));
      await expect(lib.updateItem(A, (r) => addTags(r, ['x']), ctx)).rejects.toBeInstanceOf(
        WriteBlockedError,
      );
      await expect(lib.updateItems([A, B], (r) => addTags(r, ['x']), ctx)).rejects.toBeInstanceOf(
        WriteBlockedError,
      );
      await expect(
        lib.updateRoot((r) => void addFolder(r, { name: 'x' }), ctx),
      ).rejects.toBeInstanceOf(WriteBlockedError);
      await expect(lib.renameItem(A, 'other', ctx)).rejects.toBeInstanceOf(WriteBlockedError);
      await expect(lib.moveItemOut(A, join(TMP, 'store'), ctx)).rejects.toBeInstanceOf(
        WriteBlockedError,
      );
      const rec = (await lib.readItem(A))!.value;
      await expect(lib.writeThumbnail(A, rec, new Uint8Array([1]), ctx)).rejects.toBeInstanceOf(
        WriteBlockedError,
      );
      await expect(writeFileAtomic(join(path, 'tags.json'), '{}')).rejects.toBeInstanceOf(
        WriteBlockedError,
      );
      const src = join(await scratch(), 'x.jpg');
      await writeFile(src, 'x');
      await expect(
        lib.createItem(
          { sourcePath: src, name: 'x', ext: 'jpg', size: 1, btime: 0, mtime: 0 },
          ctx,
        ),
      ).rejects.toBeInstanceOf(WriteBlockedError);
      expect(await readText(metaPath(path, A))).toBe(before);
      expect(await readText(join(path, 'metadata.json'))).toBe(rootBefore);
      expect((await readdir(join(path, 'images'))).sort()).toEqual([
        A + '.info',
        B + '.info',
        C + '.info',
      ]);
    } finally {
      allowTmp();
    }
    await lib.close();
  });

  it('a read-only library refuses every write but reads fine', async () => {
    const path = await copyTemplate();
    const { lib } = await openLib(path, { readOnly: true });
    expect(lib.readOnly).toBe(true);
    await expect(lib.updateItem(A, (r) => addTags(r, ['x']), ctx)).rejects.toBeInstanceOf(
      ReadOnlyError,
    );
    await expect(lib.updateItems([A], (r) => addTags(r, ['x']), ctx)).rejects.toBeInstanceOf(
      ReadOnlyError,
    );
    await expect(lib.updateRoot(() => true, ctx)).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(lib.renameItem(A, 'y', ctx)).rejects.toBeInstanceOf(ReadOnlyError);
    expect((await lib.readItem(A))!.value.id).toBe(A);
    expect((await lib.listItemIds()).sort()).toEqual([A, B, C]);
    await lib.close();
  });

  it('opening something that is not a library fails clearly', async () => {
    await expect(openLib(await scratch())).rejects.toBeInstanceOf(LibraryUnreadableError);
  });
});

describe('root metadata.json', () => {
  it('adds a folder: bumps modificationTime, leaves other records byte-identical, backs up', async () => {
    const path = await copyTemplate();
    const { lib, journal } = await openLib(path);
    const beforeText = await readText(join(path, 'metadata.json'));
    const before = JSON.parse(beforeText);
    const t0 = Date.now();
    let newId = '';
    const res = await lib.updateRoot((root) => {
      newId = addFolder(root, { name: 'New: Folder.', iconColor: 'blue' });
    }, ctx);
    const afterText = await readText(join(path, 'metadata.json'));
    expect(res).toEqual({ before: beforeText, after: afterText });
    const after = JSON.parse(afterText);
    expect(Object.keys(after)).toEqual(Object.keys(before)); // applicationVersion still first
    expect(after.applicationVersion).toBe('4.0.0');
    expect(after.modificationTime).toBeGreaterThanOrEqual(t0 - SKEW_MARGIN_MS); // stamp.ts
    expect(after.modificationTime).toBeGreaterThan(before.modificationTime);
    // the existing folder record is untouched, even its extendTags and pinyin
    expect(JSON.stringify(after.folders[0])).toBe(JSON.stringify(before.folders[0]));
    expect(Object.keys(after.folders[1])).toEqual([
      'id',
      'name',
      'description',
      'children',
      'modificationTime',
      'tags',
      'iconColor',
      'password',
      'passwordTips',
    ]);
    expect(after.folders[1]).toMatchObject({
      id: newId,
      name: 'New Folder',
      description: '',
      children: [],
      tags: [],
      iconColor: 'blue',
      password: '',
      passwordTips: '',
    });
    expect(journal.files).toEqual([
      { relPath: 'metadata.json', before: beforeText, after: afterText, itemId: null },
    ]);
    // Eagle-style backup of the new file
    const backups = (await readdir(join(path, 'backup'))).filter((n) =>
      /^backup-\d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\.\d{3}\.json$/.test(n),
    );
    expect(backups).toHaveLength(3);
    const newest = backups.sort().at(-1)!;
    expect(await readText(join(path, 'backup', newest))).toBe(afterText);
    // a second write with the same size does not add another backup
    await lib.updateRoot(
      (root) =>
        renameFolder(root, newId, 'Other Folder'.padEnd('New Folder'.length, 'x').slice(0, 10)),
      ctx,
    );
    expect(
      (await readdir(join(path, 'backup'))).filter((n) => n.startsWith('backup-')),
    ).toHaveLength(3);
    await lib.close();
  });

  it('strips extendTags and pinyin only from the folder records it changes', async () => {
    const path = await copyTemplate();
    const firstName = (await readJson(join(path, 'metadata.json'))).folders[0].name;
    const { lib } = await openLib(path);
    await lib.updateRoot((root) => {
      root.folders.push({
        ...root.folders[0],
        id: 'OTHERFOLDER01',
        name: 'Copy',
        extendTags: [],
        pinyin: 'Copy',
        isExpand: true,
      } as any);
    }, ctx);
    let root = await readJson(join(path, 'metadata.json'));
    expect(root.folders[0].pinyin).toBe(firstName); // untouched, still there
    expect('pinyin' in root.folders[1]).toBe(false);
    expect('extendTags' in root.folders[1]).toBe(false);
    expect('isExpand' in root.folders[1]).toBe(false);
    await lib.updateRoot((r) => renameFolder(r, 'MCMAU0FCY6HY9', 'Class 2026'), ctx);
    root = await readJson(join(path, 'metadata.json'));
    expect(root.folders[0].name).toBe('Class 2026');
    expect('pinyin' in root.folders[0]).toBe(false);
    expect('extendTags' in root.folders[0]).toBe(false);
    await lib.close();
  });

  it('keeps 100 backups, never deletes the new one or a file that is not backup-*.json', async () => {
    const path = await copyTemplate();
    const dir = join(path, 'backup');
    for (let i = 0; i < 105; i++)
      await writeFile(
        join(dir, `backup-2030-01-01 00.00.00.${String(i).padStart(3, '0')}.json`),
        'x'.repeat(i + 1),
      );
    await writeFile(join(dir, 'metadata.json.damaged-123'), 'keep me');
    const { lib } = await openLib(path);
    const res = await lib.updateRoot((r) => void addFolder(r, { name: 'f' }), ctx); // this machine's clock sorts BEFORE the 2030 names
    const names = (await readdir(dir)).sort();
    const backups = names.filter((n) => /^backup-.*\.json$/.test(n));
    expect(backups).toHaveLength(100);
    expect(names).toContain('metadata.json.damaged-123');
    const mine = backups.filter(
      (n) => !n.startsWith('backup-2030-') && !n.startsWith('backup-2026-01-15'),
    );
    expect(mine).toHaveLength(1); // the new one survived although it sorts oldest
    expect(await readText(join(dir, mine[0]))).toBe(res!.after);
    expect(backups.filter((n) => n.startsWith('backup-2026-01-15'))).toHaveLength(0); // the oldest went first
    await lib.close();
  });

  it('refuses a newer or missing applicationVersion and leaves the file alone', async () => {
    for (const change of [
      '"applicationVersion":"4.0.1"',
      '"applicationVersion":"4.10.0"',
      '"x":1',
    ]) {
      const path = await copyTemplate();
      const before = (await readText(join(path, 'metadata.json'))).replace(
        '"applicationVersion":"4.0.0"',
        change,
      );
      await writeText(join(path, 'metadata.json'), before);
      const { lib } = await openLib(path);
      await expect(
        lib.updateRoot((r) => void addFolder(r, { name: 'f' }), ctx),
      ).rejects.toBeInstanceOf(UnsupportedVersionError);
      expect(await readText(join(path, 'metadata.json'))).toBe(before);
      await lib.close();
    }
  });

  it('never overwrites a root file it cannot parse', async () => {
    const path = await copyTemplate();
    await writeText(join(path, 'metadata.json'), '{"applicationVersion":"4.0.0","folders":[');
    const { lib } = await openLib(path);
    await expect(
      lib.updateRoot((r) => void addFolder(r, { name: 'f' }), ctx),
    ).rejects.toBeInstanceOf(LibraryUnreadableError);
    expect(await readText(join(path, 'metadata.json'))).toBe(
      '{"applicationVersion":"4.0.0","folders":[',
    );
    await lib.close();
  });

  it('a no-op mutate writes nothing, and mutate cannot change applicationVersion', async () => {
    const path = await copyTemplate();
    const { lib, journal } = await openLib(path);
    const before = await readText(join(path, 'metadata.json'));
    expect(await lib.updateRoot(() => {}, ctx)).toBeNull();
    expect(await lib.updateRoot(() => false, ctx)).toBeNull();
    expect(await readText(join(path, 'metadata.json'))).toBe(before);
    expect(journal.files).toEqual([]);
    await expect(lib.updateRoot((r) => void (r.applicationVersion = '9.9.9'), ctx)).rejects.toThrow(
      /applicationVersion/,
    );
    expect(await readText(join(path, 'metadata.json'))).toBe(before);
    await lib.close();
  });
});

describe('mtime.json', () => {
  it('keeps existing entries in place, inserts new ones before all, always raises, fixes all', async () => {
    const path = await copyTemplate();
    await writeText(
      join(path, 'mtime.json'),
      JSON.stringify({ [B]: 5_000_000_000_000, OLDID00000001: 7, [A]: 1, all: 99 }),
    );
    const { lib } = await openLib(path);
    const wC = await lib.updateItem(C, (r) => addTags(r, ['x']), ctx);
    // B's entry is already far ahead (say Dropbox delivered the partner's mtime.json first): our
    // lastModified goes above it, or their Eagle would never see the value go up.
    const wB = await lib.updateItem(B, (r) => addTags(r, ['x']), ctx);
    expect(wB!.lastModified).toBe(5_000_000_000_001);
    await lib.flushMtime();
    const text = await readText(join(path, 'mtime.json'));
    expect(text).toBe(
      JSON.stringify({
        [B]: 5_000_000_000_001,
        OLDID00000001: 7,
        [A]: 1,
        [C]: wC!.lastModified,
        all: 3,
      }),
    );
    await lib.close();
  });

  it('never writes over an mtime.json it cannot parse; the raises wait until it reads again', async () => {
    const path = await copyTemplate();
    const full = JSON.stringify({ OTHERID000001: 1_790_000_000_000, OTHERID000002: 7, all: 3 });
    await writeText(join(path, 'mtime.json'), full.slice(0, 30)); // caught half-written
    const { lib } = await openLib(path);
    const w = await lib.updateItem(A, (r) => addTags(r, ['x']), ctx);
    await expect(lib.flushMtime()).rejects.toBeInstanceOf(LibraryUnreadableError);
    expect(await readText(join(path, 'mtime.json'))).toBe(full.slice(0, 30));
    await writeText(join(path, 'mtime.json'), full); // the download finished
    await lib.flushMtime();
    expect(await readJson(join(path, 'mtime.json'))).toEqual({
      OTHERID000001: 1_790_000_000_000,
      OTHERID000002: 7,
      [A]: w!.lastModified,
      all: 3,
    });
    await lib.close();
  });

  it('flushes by itself about a second after the last write, and on close', async () => {
    const path = await copyTemplate();
    const { lib } = await openLib(path); // mtimeDelayMs is 20 in tests
    const w = await lib.updateItem(A, (r) => addTags(r, ['x']), ctx);
    await new Promise((r) => setTimeout(r, 300));
    expect((await readJson(join(path, 'mtime.json')))[A]).toBe(w!.lastModified);
    const w2 = await lib.updateItem(B, (r) => addTags(r, ['x']), ctx);
    await lib.close(); // must not lose the queued raise
    expect((await readJson(join(path, 'mtime.json')))[B]).toBe(w2!.lastModified);
  });

  it('keeps queued raises when the write fails, and writes them on the next flush', async () => {
    const path = await copyTemplate();
    const errors: unknown[] = [];
    const journal = new FakeJournal();
    const lib = await openLibrary(path, {
      readOnly: false,
      journal,
      nameMaxChars: 120,
      retryDelayMs: 10,
      mtimeDelayMs: 60_000, // no timer during this test
      onError: (e) => errors.push(e),
    });
    const w = await lib.updateItem(A, (r) => addTags(r, ['x']), ctx);
    setWritableRoots([join(TMP, 'not-this-one')]);
    try {
      await expect(lib.flushMtime()).rejects.toBeInstanceOf(WriteBlockedError);
    } finally {
      allowTmp();
    }
    expect(await readText(join(path, 'mtime.json'))).toBe('{}');
    await lib.flushMtime();
    expect((await readJson(join(path, 'mtime.json')))[A]).toBe(w!.lastModified);
    await lib.close();
  });

  it('creates mtime.json when it is missing, and its temp files never contain "mtime"', async () => {
    const path = await copyTemplate();
    const { rm } = await import('node:fs/promises');
    await rm(join(path, 'mtime.json'));
    const { lib } = await openLib(path);
    expect(await lib.readMtimeIndex()).toEqual({});
    const w = await lib.updateItem(A, (r) => addTags(r, ['x']), ctx);
    await lib.flushMtime();
    expect(await readJson(join(path, 'mtime.json'))).toEqual({ [A]: w!.lastModified, all: 3 });
    expect(tempNameFor(join(path, 'mtime.json'))).not.toMatch(/mtime/i);
    expect(tempNameFor(join(path, 'metadata.json'))).toMatch(
      /^~\$metadata\.json\.[0-9a-f]{8}\.tmp$/,
    );
    expect(tempNameFor(join(path, 'metadata.json'))).not.toBe('~$metadata.json.tmp');
    expect(await readdir(path)).not.toContain('~$mt.json');
    expect((await readdir(path)).filter((n) => n.startsWith('~$'))).toEqual([]); // no temp file left behind
    await lib.close();
  });
});

describe('touching an item so a partner Eagle re-reads it', () => {
  it("raises lastModified and mtime.json above an Eagle revert, changes nothing else, and isn't journaled", async () => {
    const path = await copyTemplate();
    const { lib, journal } = await openLib(path);
    const w = await lib.updateItem(A, (r) => addTags(r, ['mine']), ctx);
    await lib.flushMtime();
    expect(lib.recentRaises(20_000)).toEqual([A]);
    // The partner's Eagle rewrites mtime.json from memory ~3 s after its own save, putting A back
    // to the value it knew (eagle-proof finding 2).
    await writeText(join(path, 'mtime.json'), JSON.stringify({ [A]: 1_000, all: 3 }));
    const before = await readJson(metaPath(path, A));
    const t = await lib.touchItem(A);
    await lib.flushMtime();
    const after = await readJson(metaPath(path, A));
    expect(t!.lastModified).toBeGreaterThan(w!.lastModified);
    expect(after).toEqual({ ...before, lastModified: t!.lastModified });
    expect(await readJson(join(path, 'mtime.json'))).toEqual({ [A]: t!.lastModified, all: 3 });
    expect(journal.files).toHaveLength(1); // only the tag edit
    await lib.close();
  });

  it('goes above an mtime.json value that is ahead of the clock', async () => {
    const path = await copyTemplate();
    const { lib } = await openLib(path);
    const ahead = Date.now() + 60_000; // a partner whose clock runs ahead
    await writeText(join(path, 'mtime.json'), JSON.stringify({ [B]: ahead, all: 3 }));
    const t = await lib.touchItem(B);
    expect(t!.lastModified).toBe(ahead + 1);
    await expect(lib.touchItem('MISSINGITEM01')).rejects.toBeInstanceOf(ItemNotFoundError);
    await lib.close();
    await expect(lib.touchItem(B)).rejects.toThrow(/closed/);
  });

  it('reannounce puts our value back in mtime.json without rewriting the item', async () => {
    const path = await copyTemplate();
    const { lib } = await openLib(path);
    const w = await lib.updateItem(A, (r) => addTags(r, ['mine']), ctx);
    await lib.flushMtime();
    const text = await readText(metaPath(path, A));
    // Their rewrite from memory dropped it.
    await writeText(join(path, 'mtime.json'), JSON.stringify({ all: 3 }));
    expect(await lib.reannounce(A)).toBe(w!.lastModified);
    await lib.flushMtime();
    expect((await readJson(join(path, 'mtime.json')))[A]).toBe(w!.lastModified);
    expect(await readText(metaPath(path, A))).toBe(text);
    await lib.close();
  });

  it('never touches a file that changed since the caller read it (a partner save landing)', async () => {
    const path = await copyTemplate();
    const { lib } = await openLib(path);
    const seen = (await lib.readItem(A))!.text;
    const theirs = { ...JSON.parse(seen), tags: ['sam'] };
    await writeText(metaPath(path, A), JSON.stringify(theirs));
    expect(await lib.touchItem(A, { ifText: seen })).toBeNull();
    expect(await readJson(metaPath(path, A))).toEqual(theirs);
    expect(await lib.touchItem(A, { ifText: JSON.stringify(theirs) })).not.toBeNull();
    await lib.close();
  });

  it('recentRaises only lists raises that reached the file, within the window asked for', async () => {
    const path = await copyTemplate();
    const { lib } = await openLib(path);
    await lib.updateItem(A, (r) => addTags(r, ['x']), ctx);
    expect(lib.recentRaises(20_000)).toEqual([]); // still queued
    await lib.flushMtime();
    await new Promise((r) => setTimeout(r, 400));
    await lib.updateItem(B, (r) => addTags(r, ['x']), ctx);
    await lib.flushMtime();
    expect(lib.recentRaises(20_000).sort()).toEqual([A, B].sort());
    expect(lib.recentRaises(300)).toEqual([B]);
    expect(lib.raisedValue(B)).toBe((await readJson(join(path, 'mtime.json')))[B]);
    await lib.close();
  });

  it('writeProblem says so while the background mtime.json write keeps failing, and clears when it works', async () => {
    const path = await copyTemplate();
    const errors: unknown[] = [];
    const lib = await openLibrary(path, {
      readOnly: false,
      journal: new FakeJournal(),
      nameMaxChars: 120,
      retryDelayMs: 10,
      mtimeDelayMs: 10,
      mtimeReportAfterMs: 0,
      onError: (e) => errors.push(e),
    });
    const good = await readText(join(path, 'mtime.json'));
    await writeText(join(path, 'mtime.json'), '{"OTHERID000001":17900'); // cut off
    await lib.updateItem(A, (r) => addTags(r, ['x']), ctx);
    for (let i = 0; i < 100 && !lib.writeProblem(); i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(lib.writeProblem()).toMatch(/can't update mtime\.json.*won't see your edits/);
    expect(errors).toHaveLength(1);
    await writeText(join(path, 'mtime.json'), good);
    await lib.flushMtime();
    expect(lib.writeProblem()).toBeNull();
    await lib.close();
  });
});

describe('createItem', () => {
  async function source(name = 'src.jpg', bytes = 'JPEGBYTES'): Promise<string> {
    const p = join(await scratch(), name);
    await writeFile(p, bytes);
    await utimes(p, 1_700_000_000.789, 1_700_000_000.789);
    return p;
  }

  it('builds the folder, the key order, the sanitized name, whole-second times, and the mtime entry', async () => {
    const path = await copyTemplate();
    const { lib, journal } = await openLib(path);
    const src = await source();
    const thumb = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);
    const { id, record } = await lib.createItem(
      {
        sourcePath: src,
        name: 'Café \u{1F600} shot.',
        ext: 'JPG',
        size: 9,
        btime: 1_700_000_000_123,
        mtime: 1_700_000_000_789,
        width: 800,
        height: 600,
        tags: ['b', ' a ', 'b'],
        folders: ['F1'],
        url: 'https://x.test/p',
        annotation: 'hi',
        star: 3,
        palettes: [{ color: [1, 2, 3], ratio: 60 }],
        thumbnailBytes: thumb,
        modificationTime: 1_790_000_000_000,
      },
      ctx,
    );
    expect(id).toMatch(/^[0-9A-Z]{13}$/);
    const dir = join(path, 'images', `${id}.info`);
    expect((await readdir(dir)).sort()).toEqual(
      ['Café  shot.jpg', 'Café  shot_thumbnail.png', 'metadata.json'].sort(),
    );
    expect(await readFile(join(dir, 'Café  shot.jpg'), 'utf8')).toBe('JPEGBYTES');
    expect(new Uint8Array(await readFile(join(dir, 'Café  shot_thumbnail.png')))).toEqual(thumb);
    expect(Math.trunc((await stat(join(dir, 'Café  shot.jpg'))).mtimeMs)).toBe(1_700_000_000_000); // whole second, matches the record
    const text = await readText(join(dir, 'metadata.json'));
    expect(text).toBe(JSON.stringify(record));
    expect(Object.keys(JSON.parse(text))).toEqual([
      'id',
      'name',
      'size',
      'btime',
      'mtime',
      'ext',
      'tags',
      'folders',
      'isDeleted',
      'url',
      'annotation',
      'modificationTime',
      'star',
      'height',
      'width',
      'lastModified',
      'palettes',
    ]);
    expect(record).toMatchObject({
      id,
      name: 'Café  shot',
      size: 9,
      btime: 1_700_000_000_000,
      mtime: 1_700_000_000_000,
      ext: 'jpg',
      tags: ['b', 'a'],
      folders: ['F1'],
      isDeleted: false,
      url: 'https://x.test/p',
      annotation: 'hi',
      modificationTime: 1_790_000_000_000,
      star: 3,
      height: 600,
      width: 800,
    });
    expect(journal.files).toEqual([
      { relPath: `images/${id}.info/metadata.json`, before: null, after: text, itemId: id },
    ]);
    await lib.flushMtime();
    const mtime = await readJson(join(path, 'mtime.json'));
    expect(mtime[id]).toBe(record.lastModified);
    expect(Object.keys(mtime).at(-1)).toBe('all');
    expect(mtime.all).toBe(4);
    expect(await lib.readItem(id)).not.toBeNull();
    expect(await lib.locateOriginal(id, record)).toBe(join(dir, 'Café  shot.jpg'));
    expect(await lib.locateThumbnail(id, record)).toBe(join(dir, 'Café  shot_thumbnail.png'));
    expect(lib.recentSelfWrites().has(`images/${id}.info/metadata.json`)).toBe(true);
    await lib.close();
  });

  it("with no palette it writes processingPalette before lastModified; video keeps Eagle's key order; noThumbnail skips the file", async () => {
    const path = await copyTemplate();
    const { lib } = await openLib(path);
    const src = await source('clip.mp4');
    const { id, record } = await lib.createItem(
      {
        sourcePath: src,
        name: 'clip',
        ext: 'mp4',
        size: 9,
        btime: 1_700_000_000_000,
        mtime: 1_700_000_000_000,
        width: 1920,
        height: 1080,
        duration: 12.5,
        extra: { resolutionWidth: 1920, resolutionHeight: 1080, tags: 'ignored' },
        noThumbnail: true,
        thumbnailBytes: new Uint8Array([1]),
      },
      ctx,
    );
    expect(Object.keys(record).slice(11)).toEqual([
      'modificationTime',
      'noThumbnail', // width-first types put it before the size, like Eagle's webp records
      'width',
      'height',
      'resolutionWidth',
      'resolutionHeight',
      'duration',
      'processingPalette',
      'lastModified',
    ]);
    expect(record.tags).toEqual([]);
    expect(await readdir(join(path, 'images', `${id}.info`))).toEqual([
      'clip.mp4',
      'metadata.json',
    ]);
    await lib.close();
  });

  it('asks Eagle for a palette only where its analyzer can make one; SVG flags come before the size', () => {
    const base = { sourcePath: '', name: 'x', size: 1, btime: 0, mtime: 0 };
    const keysOf = (ext: string, init: Partial<NewItemInit>) =>
      Object.keys(buildItemRecord('ID', 'x', ext, { ...base, ext, ...init })).slice(12);
    expect(keysOf('txt', { extra: { text: 'hello' } })).toEqual(['text', 'lastModified']);
    expect(keysOf('png', { width: 10, height: 2000 })).toEqual(['height', 'width', 'lastModified']); // too tall
    expect(keysOf('png', { width: 10, height: 10 })).toEqual([
      'height',
      'width',
      'processingPalette',
      'lastModified',
    ]);
    expect(
      keysOf('svg', {
        width: 10,
        height: 10,
        noThumbnail: true,
        extra: { removeThumbnail: true },
        palettes: [{ color: [1, 2, 3], ratio: 100 }],
      }),
    ).toEqual(['removeThumbnail', 'noThumbnail', 'height', 'width', 'lastModified', 'palettes']);
    // Eagle's own webp import (eagle-proof d-bytes.md "Import webp"): noThumbnail, width, height.
    expect(keysOf('webp', { width: 900, height: 560, noThumbnail: true })).toEqual([
      'noThumbnail',
      'width',
      'height',
      'processingPalette',
      'lastModified',
    ]);
  });

  it('moveSource moves our own temp file; a failed copy leaves no half-made item folder', async () => {
    const path = await copyTemplate();
    const { lib, journal } = await openLib(path);
    const src = await source('temp-download');
    const { id } = await lib.createItem(
      { sourcePath: src, moveSource: true, name: 'pic', ext: 'png', size: 9, btime: 0, mtime: 0 },
      ctx,
    );
    await expect(stat(src)).rejects.toThrow();
    expect(await readdir(join(path, 'images', `${id}.info`))).toContain('pic.png');

    const dirsBefore = (await readdir(join(path, 'images'))).sort();
    await expect(
      lib.createItem(
        {
          sourcePath: join(TMP, 'does-not-exist.jpg'),
          name: 'ghost',
          ext: 'jpg',
          size: 1,
          btime: 0,
          mtime: 0,
        },
        ctx,
      ),
    ).rejects.toThrow();
    expect((await readdir(join(path, 'images'))).sort()).toEqual(dirsBefore);
    expect(journal.files).toHaveLength(1); // only the good item
    await expect(
      lib.createItem(
        {
          sourcePath: join(path, 'images', `${A}.info`, '0051.jpg'),
          moveSource: true,
          name: 'steal',
          ext: 'jpg',
          size: 1,
          btime: 0,
          mtime: 0,
        },
        ctx,
      ),
    ).rejects.toThrow(/temp files/);
    expect((await readdir(join(path, 'images', `${A}.info`))).sort()).toEqual([
      '0051.jpg',
      '0051_thumbnail.png',
      'metadata.json',
    ]);
    await lib.close();
  });

  it('a failed moveSource import puts the file back where it came from, never deletes it', async () => {
    const path = await copyTemplate();
    const { lib, journal } = await openLib(path);
    const src = await source('pasted.png', 'ONLY COPY');
    journal.failNextRecordFile = true; // fails after the file was moved in
    await expect(
      lib.createItem(
        { sourcePath: src, moveSource: true, name: 'p', ext: 'png', size: 9, btime: 0, mtime: 0 },
        ctx,
      ),
    ).rejects.toThrow(/journal/);
    expect(await readText(src)).toBe('ONLY COPY');
    expect((await readdir(join(path, 'images'))).length).toBe(3);
    await lib.close();
  });

  it('a metadata write that fails rolls the new folder back completely', async () => {
    const path = await copyTemplate();
    const { lib, journal } = await openLib(path);
    journal.failNextRecordFile = true; // the journal runs before the metadata write
    const src = await source();
    await expect(
      lib.createItem(
        {
          sourcePath: src,
          name: 'x',
          ext: 'jpg',
          size: 9,
          btime: 0,
          mtime: 0,
          thumbnailBytes: new Uint8Array([1]),
        },
        ctx,
      ),
    ).rejects.toThrow(/journal/);
    expect((await readdir(join(path, 'images'))).sort()).toEqual([
      A + '.info',
      B + '.info',
      C + '.info',
    ]);
    await lib.close();
  });
});

describe('renameItem', () => {
  it('renames the original and thumbnail, then the record, journaling only metadata.json', async () => {
    const path = await copyTemplate();
    const { lib, journal } = await openLib(path);
    const w = await lib.renameItem(A, 'Renamed: item?', ctx);
    expect(w).not.toBeNull();
    const dir = join(path, 'images', `${A}.info`);
    expect((await readdir(dir)).sort()).toEqual([
      'Renamed item.jpg',
      'Renamed item_thumbnail.png',
      'metadata.json',
    ]);
    const rec = await readJson(metaPath(path, A));
    expect(rec.name).toBe('Renamed item');
    expect(rec.lastModified).toBe(w!.lastModified);
    expect(journal.files).toHaveLength(1);
    expect(journal.files[0].relPath).toBe(`images/${A}.info/metadata.json`);
    expect(await lib.renameItem(A, 'Renamed: item?', ctx)).toBeNull(); // same sanitized name
    await lib.flushMtime();
    expect((await readJson(join(path, 'mtime.json')))[A]).toBe(w!.lastModified);
    await lib.close();
  });

  it('puts the files back when the record cannot be written', async () => {
    const path = await copyTemplate();
    const { lib, journal } = await openLib(path);
    journal.failNextRecordFile = true;
    await expect(lib.renameItem(A, 'Never happens', ctx)).rejects.toThrow(/journal/);
    expect((await readdir(join(path, 'images', `${A}.info`))).sort()).toEqual([
      '0051.jpg',
      '0051_thumbnail.png',
      'metadata.json',
    ]);
    expect((await readJson(metaPath(path, A))).name).toBe('0051');
    await lib.close();
  });

  it('leaves a lone file with a different extension alone', async () => {
    const path = await copyTemplate();
    const dir = join(path, 'images', `${A}.info`);
    const { rename } = await import('node:fs/promises');
    await rename(join(dir, '0051.jpg'), join(dir, 'mystery.bin'));
    const { lib } = await openLib(path);
    await lib.renameItem(A, 'New name', ctx);
    expect((await readdir(dir)).sort()).toEqual([
      'New name_thumbnail.png',
      'metadata.json',
      'mystery.bin',
    ]);
    expect((await readJson(metaPath(path, A))).name).toBe('New name');
    await lib.close();
  });

  it('refuses to overwrite a file that is already there', async () => {
    const path = await copyTemplate();
    await writeFile(join(path, 'images', `${A}.info`, 'taken.jpg'), 'other');
    const { lib } = await openLib(path);
    await expect(lib.renameItem(A, 'taken', ctx)).rejects.toThrow(/already exists/);
    expect((await readdir(join(path, 'images', `${A}.info`))).sort()).toEqual([
      '0051.jpg',
      '0051_thumbnail.png',
      'metadata.json',
      'taken.jpg',
    ]);
    await lib.close();
  });
});

describe('finding the files', () => {
  it('matches an NFD record name to an NFC file, a leading space to a trimmed file, and ignores conflicted copies', async () => {
    const path = await copyTemplate();
    const dir = join(path, 'images', `${A}.info`);
    const { rm, rename } = await import('node:fs/promises');
    await rename(join(dir, '0051.jpg'), join(dir, 'Café.JPG'));
    await writeFile(join(dir, "0051 (Sam Lee's conflicted copy 2026-05-25).jpg"), 'dup');
    await writeFile(join(dir, 'x.jpg.bk'), 'bk');
    const { lib } = await openLib(path);
    const rec = (await lib.readItem(A))!.value;
    expect(await lib.locateOriginal(A, { ...rec, name: 'Café' })).toBe(join(dir, 'Café.JPG')); // NFD vs NFC, ext case
    expect(await lib.locateOriginal(A, { ...rec, name: ' Café' })).toBe(join(dir, 'Café.JPG')); // leading space
    expect(await lib.locateOriginal(A, { ...rec, name: 'totally different' })).toBe(
      join(dir, 'Café.JPG'),
    ); // the only candidate
    await writeFile(join(dir, 'second.png'), 'x');
    expect(
      await lib.locateOriginal(A, { ...rec, name: 'totally different', lastModified: 1 }),
    ).toBeNull(); // ambiguous
    await rm(join(dir, '0051_thumbnail.png'));
    expect(await lib.locateThumbnail(A, rec)).toBeNull();
    await writeFile(join(dir, 'Old Name_thumbnail.png'), 't');
    await writeFile(join(dir, "0051_thumbnail (Sam Lee's conflicted copy 2026-05-25).png"), 't');
    expect(await lib.locateThumbnail(A, rec)).toBe(join(dir, 'Old Name_thumbnail.png'));
    await lib.close();
  });

  it('lists only <13 or 36 char id>.info entries', async () => {
    const path = await copyTemplate();
    const images = join(path, 'images');
    await mkdir(join(images, 'SHORT.info'));
    await mkdir(join(images, 'LT24XY3DPJFLK.info (conflicted copy)'));
    await mkdir(join(images, '123e4567-e89b-12d3-a456-426614174000.info'));
    await writeFile(join(images, 'notes.txt'), 'x');
    const { lib } = await openLib(path);
    expect((await lib.listItemIds()).sort()).toEqual(
      ['123e4567-e89b-12d3-a456-426614174000', A, B, C].sort(),
    );
    expect(await lib.readItem('123e4567-e89b-12d3-a456-426614174000')).toBeNull(); // no metadata.json: not an item yet
    await lib.close();
  });

  it('readMtimeIndex reads {} and real maps', async () => {
    const path = await copyTemplate();
    const { lib } = await openLib(path);
    expect(await lib.readMtimeIndex()).toEqual({});
    await writeText(join(path, 'mtime.json'), '{"A":1,"all":1}');
    expect(await lib.readMtimeIndex()).toEqual({ A: 1, all: 1 });
    await lib.close();
  });
});

describe('moving an item folder out and back in', () => {
  it('moves the whole folder to the store, lowers all, and puts it back with the mtime raised', async () => {
    const path = await copyTemplate();
    const store = join(await scratch(), 'store', 'g1');
    // Like the real app: only the library's folder is writable, the journal store is not.
    setWritableRoots([dirname(path)]);
    try {
      const { lib, journal } = await openLib(path);
      await lib.moveItemOut(B, store, ctx);
      expect(journal.moves).toEqual([{ itemId: B, storedAt: join(store, `${B}.info`) }]);
      expect((await readdir(join(path, 'images'))).sort()).toEqual([A + '.info', C + '.info']);
      expect((await readdir(join(store, `${B}.info`))).sort()).toEqual([
        "Shirley Fox prank at gerome's.jpg",
        "Shirley Fox prank at gerome's_thumbnail.png",
        'metadata.json',
      ]);
      await lib.flushMtime();
      expect((await readJson(join(path, 'mtime.json'))).all).toBe(2);

      await lib.moveItemIn(B, join(store, `${B}.info`), ctx); // the parent folder works too
      expect((await readdir(join(path, 'images'))).sort()).toEqual([
        A + '.info',
        B + '.info',
        C + '.info',
      ]);
      expect(journal.files.at(-1)).toMatchObject({
        relPath: `images/${B}.info/metadata.json`,
        before: null,
        itemId: B,
      });
      await lib.flushMtime();
      const mtime = await readJson(join(path, 'mtime.json'));
      expect(mtime.all).toBe(3);
      // Back with a fresh stamp of ours above its own old value, file and mtime.json alike.
      const back = await readJson<EagleItemRecord>(metaPath(path, B));
      expect(back.lastModified).toBeGreaterThan(1768535175732);
      expect(isBoogieStamp(back.lastModified)).toBe(true);
      expect(mtime[B]).toBe(back.lastModified);
      expect(journal.files.at(-1)?.after).toBe(JSON.stringify(back));
      await expect(lib.moveItemIn(B, store, ctx)).rejects.toThrow();
      await lib.close();
    } finally {
      allowTmp();
    }
  });

  it('refuses a store folder inside a library, an unknown id, and an id that is already stored', async () => {
    const path = await copyTemplate();
    const { lib } = await openLib(path);
    await expect(lib.moveItemOut(B, join(path, 'backup'), ctx)).rejects.toThrow(/store/);
    await expect(
      lib.moveItemOut('ZZZZZZZZZZZZZ', join(await scratch(), 's'), ctx),
    ).rejects.toBeInstanceOf(ItemNotFoundError);
    expect((await readdir(join(path, 'images'))).length).toBe(3);
    await lib.close();
  });
});

describe('writeThumbnail', () => {
  it('replaces <name>_thumbnail.png atomically, keeping the old picture in the journal', async () => {
    const path = await copyTemplate();
    const { lib, journal } = await openLib(path);
    const rec = (await lib.readItem(A))!.value;
    const old = await readFile(join(path, 'images', `${A}.info`, '0051_thumbnail.png'));
    await lib.writeThumbnail(A, rec, new Uint8Array([9, 9, 9]), ctx, { keepOld: true });
    expect(journal.files).toEqual([
      {
        relPath: `images/${A}.info/thumbnail`,
        before: old.toString('base64'),
        after: Buffer.from([9, 9, 9]).toString('base64'),
        itemId: A,
      },
    ]);
    expect(
      new Uint8Array(await readFile(join(path, 'images', `${A}.info`, '0051_thumbnail.png'))),
    ).toEqual(new Uint8Array([9, 9, 9]));
    expect(
      (await readdir(join(path, 'images', `${A}.info`))).filter((n) => n.startsWith('~$')),
    ).toEqual([]);
    await lib.close();
  });

  it('a refresh keeps old pictures up to its budget, then records the rest as not kept', async () => {
    const path = await copyTemplate();
    const journal = new FakeJournal();
    const oldA = await readFile(join(path, 'images', `${A}.info`, '0051_thumbnail.png'));
    const lib = await openLibrary(path, {
      readOnly: false,
      journal,
      nameMaxChars: 120,
      retryDelayMs: 10,
      thumbJournalBudget: oldA.length + 1,
    });
    await lib.writeThumbnail(A, (await lib.readItem(A))!.value, new Uint8Array([1]), ctx);
    await lib.writeThumbnail(B, (await lib.readItem(B))!.value, new Uint8Array([2]), ctx);
    expect(journal.files.map((f) => [f.itemId, !!f.before, f.after])).toEqual([
      [A, true, Buffer.from([1]).toString('base64')],
      [B, false, ''], // over the budget: undo will say it wasn't kept
    ]);
    // A custom thumbnail (keepOld) is always kept.
    await lib.writeThumbnail(B, (await lib.readItem(B))!.value, new Uint8Array([3]), ctx, {
      keepOld: true,
    });
    expect(journal.files.at(-1)?.before).toBe(Buffer.from([2]).toString('base64'));
    await lib.close();
  });

  it('writes under the name on disk, not the name in a record read before a rename', async () => {
    const path = await copyTemplate();
    const { lib } = await openLib(path);
    const stale = (await lib.readItem(A))!.value;
    await lib.renameItem(A, 'renamed', ctx);
    await lib.writeThumbnail(A, stale, new Uint8Array([7]), ctx);
    expect((await readdir(join(path, 'images', `${A}.info`))).sort()).toEqual([
      'metadata.json',
      'renamed.jpg',
      'renamed_thumbnail.png',
    ]);
    await lib.close();
  });
});

// The journal store (~/.local/share) and a library (Dropbox, a USB drive) are often on different
// filesystems, where rename fails with EXDEV and the adapter copies instead.
const shm = await mkdtemp('/dev/shm/boogie-eagle-').catch(() => null);
describe.skipIf(!shm)('across filesystems (store on /dev/shm)', () => {
  afterAll(() => rm(shm!, { recursive: true, force: true }));

  it('moves an item folder out to the other filesystem and back in, whole', async () => {
    const path = await copyTemplate();
    const { lib } = await openLib(path);
    const files = (await readdir(join(path, 'images', `${B}.info`))).sort();
    const store = join(shm!, 'store');
    await lib.moveItemOut(B, store, ctx);
    expect((await readdir(join(store, `${B}.info`))).sort()).toEqual(files);
    expect(await readdir(join(path, 'images'))).not.toContain(`${B}.info`);
    await lib.moveItemIn(B, store, ctx);
    expect((await readdir(join(path, 'images', `${B}.info`))).sort()).toEqual(files);
    expect(await readdir(store)).toEqual([]);
    await lib.close();
  });

  it('moveSource from the other filesystem moves in, and a failure copies it back', async () => {
    const path = await copyTemplate();
    const { lib, journal } = await openLib(path);
    const src = join(shm!, 'download.png');
    await writeFile(src, 'PIXELS');
    const { id } = await lib.createItem(
      { sourcePath: src, moveSource: true, name: 'dl', ext: 'png', size: 6, btime: 0, mtime: 0 },
      ctx,
    );
    await expect(stat(src)).rejects.toThrow();
    expect(await readText(join(path, 'images', `${id}.info`, 'dl.png'))).toBe('PIXELS');

    await writeFile(src, 'PIXELS 2');
    journal.failNextRecordFile = true;
    await expect(
      lib.createItem(
        { sourcePath: src, moveSource: true, name: 'd2', ext: 'png', size: 8, btime: 0, mtime: 0 },
        ctx,
      ),
    ).rejects.toThrow(/journal/);
    expect(await readText(src)).toBe('PIXELS 2');
    expect((await readdir(join(path, 'images'))).length).toBe(4);
    await lib.close();
  });
});
