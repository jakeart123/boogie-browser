import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { conflictBaseName, findConflictFiles, scanItemConflicts } from './conflicts';
import { externalWrite, makeLibrary } from './testUtil';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

describe('conflicted copy names', () => {
  it.each([
    ["metadata (Sam Lee's conflicted copy 2026-05-25).json", 'metadata.json'],
    ['metadata (conflicted copy 2026-05-25).json', 'metadata.json'],
    ["mtime (Sam's conflicted copy 2026-09-28).json", 'mtime.json'],
    ["tags (Sam Lee's conflicted copy 2026-09-28) (1).json", 'tags.json'],
    ["tags (Sam Lee's conflicted copy 2026-09-28 (2)).json", 'tags.json'],
    ["Wolf_thumbnail (Sam Lee's conflicted copy 2026-05-25).png", 'Wolf_thumbnail.png'],
    ['metadata (Sam’s conflicted copy 2026-05-25).json', 'metadata.json'],
    ['Photo (Case Conflict).jpg', 'Photo.jpg'], // Dropbox's name clash that differs only in case
    ['Photo (Case Conflict 1).jpg', 'Photo.jpg'],
  ])('%s is a conflicted copy of %s', (name, base) => {
    expect(conflictBaseName(name)).toBe(base);
  });

  it.each([
    'metadata.json',
    'mtime.json',
    'tags.json.620480326',
    'my (conflicted) copy.png',
    'photo (2026-05-25).jpg',
    'conflicted copy 2026-05-25.txt',
  ])('%s is not', (name) => {
    expect(conflictBaseName(name)).toBeNull();
  });
});

describe('findConflictFiles / scanItemConflicts', () => {
  it('classifies root-level copies, and looks inside item folders only when asked', async () => {
    const lib = makeLibrary();
    cleanups.push(lib.cleanup);
    const stamp = "(Sam Lee's conflicted copy 2026-09-28)";
    for (const name of [
      `metadata ${stamp}.json`,
      `mtime ${stamp}.json`,
      `tags ${stamp}.json`,
      `saved-filters ${stamp}.json`,
    ]) {
      externalWrite(join(lib.root, name), '{}');
    }
    // Item folders: use a real id from the copy. The copy also has a plain metadata.json we must not report.
    const id = 'MKG8VYYQTA5SW';
    externalWrite(join(lib.root, 'images', `${id}.info`, `metadata ${stamp}.json`), '{}');
    externalWrite(join(lib.root, 'images', `${id}.info`, `Some name_thumbnail ${stamp}.png`), 'x');
    externalWrite(join(lib.root, 'images', `${id}.info`, `Some name ${stamp}.jpg`), 'x');
    externalWrite(join(lib.root, 'images', `${id}.info`, 'tags.json.620480326'), 'x'); // Eagle temp file, not a conflict

    const rootOnly = await findConflictFiles(lib.root);
    expect(rootOnly.map((f) => [f.path, f.kind, f.itemId])).toEqual([
      [`metadata ${stamp}.json`, 'root', null],
      [`mtime ${stamp}.json`, 'mtime', null],
      [`saved-filters ${stamp}.json`, 'other', null],
      [`tags ${stamp}.json`, 'tags', null],
    ]);

    const inItem = await scanItemConflicts(lib.root, [id]);
    expect(inItem.map((f) => [f.path.replace(`images/${id}.info/`, ''), f.kind, f.itemId])).toEqual(
      [
        [`Some name ${stamp}.jpg`, 'other', id],
        [`Some name_thumbnail ${stamp}.png`, 'thumbnail', id],
        [`metadata ${stamp}.json`, 'item', id],
      ],
    );

    const all = await findConflictFiles(lib.root, { items: true });
    expect(all).toHaveLength(rootOnly.length + inItem.length);
  });

  it('returns nothing for a clean or missing library and ignores hostile ids', async () => {
    const lib = makeLibrary();
    cleanups.push(lib.cleanup);
    expect(await findConflictFiles(lib.root, { items: true })).toEqual([]);
    expect(await findConflictFiles(join(lib.dir, 'nope.library'))).toEqual([]);
    mkdirSync(join(lib.dir, 'outside'));
    writeFileSync(join(lib.dir, 'outside', 'metadata (conflicted copy 2026-05-25).json'), '{}');
    expect(await scanItemConflicts(lib.root, ['../../outside', '..'])).toEqual([]);
  });
});
