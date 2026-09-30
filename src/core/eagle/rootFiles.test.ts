// tags.json and saved-filters.json: the small library-level files Eagle writes atomically.
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setWritableRoots } from '../safety/writeGuard';
import { LibraryUnreadableError, ReadOnlyError } from './errors';
import { allowTmp, cleanup, copyTemplate, ctx, openLib, readText, writeText } from './testkit';

beforeAll(allowTmp);
afterAll(async () => {
  setWritableRoots([]);
  await cleanup();
});

describe('tags.json', () => {
  it('reads it, and a write re-reads first so an outside change survives', async () => {
    const path = await copyTemplate();
    const { lib, journal } = await openLib(path);
    const doc = await lib.readTagsFile();
    expect(doc?.value.starredTags).toEqual([]);
    // The partner's Eagle (or anyone) wrote it after we read it.
    await writeText(
      join(path, 'tags.json'),
      JSON.stringify({ historyTags: ['Hands'], starredTags: ['Sam'], extra: 1 }),
    );
    const res = await lib.updateTagsFile((t) => {
      t.starredTags.push('Mine');
    }, ctx);
    const after = '{"historyTags":["Hands"],"starredTags":["Sam","Mine"],"extra":1}';
    expect(await readText(join(path, 'tags.json'))).toBe(after);
    expect(res?.after).toBe(after);
    expect(journal.files.at(-1)).toMatchObject({ relPath: 'tags.json', after, itemId: null });
    expect((await readdir(path)).filter((n) => n.startsWith('~$'))).toEqual([]);
    await lib.close();
  });

  it('a missing file starts from Eagle default; an unparseable one is never written over', async () => {
    const path = await copyTemplate();
    const { lib } = await openLib(path);
    await rm(join(path, 'tags.json'));
    expect(await lib.readTagsFile()).toBeNull();
    expect(await lib.updateTagsFile(() => false, ctx)).toBeNull(); // a no-op creates nothing
    await expect(readText(join(path, 'tags.json'))).rejects.toThrow();
    await lib.updateTagsFile((t) => void t.historyTags.push('x'), ctx);
    expect(await readText(join(path, 'tags.json'))).toBe('{"historyTags":["x"],"starredTags":[]}');

    await writeText(join(path, 'tags.json'), '{"historyTags":["x"],"star');
    await expect(lib.readTagsFile()).rejects.toBeInstanceOf(LibraryUnreadableError);
    await expect(
      lib.updateTagsFile((t) => void t.historyTags.push('y'), ctx),
    ).rejects.toBeInstanceOf(LibraryUnreadableError);
    expect(await readText(join(path, 'tags.json'))).toBe('{"historyTags":["x"],"star');
    await lib.close();
  });
});

describe('saved-filters.json', () => {
  it('adds a filter to what is on disk, keeps unknown keys, and refuses read-only', async () => {
    const path = await copyTemplate();
    const { lib, journal } = await openLib(path);
    expect((await lib.readSavedFilters())?.value).toEqual([]);
    await writeText(
      join(path, 'saved-filters.json'),
      JSON.stringify([{ name: 'Sam', rule: { keyword: 'hands' }, x: true }]),
    );
    await lib.updateSavedFilters((list) => {
      list.push({ name: 'Mine', rule: { rating: { '5': true } } });
    }, ctx);
    const text = await readText(join(path, 'saved-filters.json'));
    expect(text).toBe(
      '[{"name":"Sam","rule":{"keyword":"hands"},"x":true},{"name":"Mine","rule":{"rating":{"5":true}}}]',
    );
    expect(journal.files.at(-1)?.relPath).toBe('saved-filters.json');
    expect(await lib.updateSavedFilters((list) => list.length > 5, ctx)).toBeNull();
    await lib.close();

    const ro = await openLib(path, { readOnly: true });
    await expect(ro.lib.updateSavedFilters(() => true, ctx)).rejects.toBeInstanceOf(ReadOnlyError);
    await ro.lib.close();
  });
});
