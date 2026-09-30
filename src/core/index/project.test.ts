import { describe, expect, it } from 'vitest';
import { projectRecord } from './project';
import { makeItem } from './testHelpers';

const tree = new Map([
  ['F1', { name: 'Portraits', description: 'faces' }],
  ['F2', { name: 'Landscapes', description: '' }],
]);

describe('projectRecord', () => {
  it('projects the item row, tags, folders (with order keys) and the FTS row', () => {
    const rec = makeItem('ABC1234567890', {
      name: 'Shirley Fox',
      tags: ['Gerome', 'oil', 'oil'],
      folders: ['F1', 'F2', 'GONE'],
      order: { F1: '1708727558963.56655092592592592596' },
      annotation: 'a note',
      url: 'https://example.com/x',
      star: 4,
      modificationTime: 1779741123280,
      comments: [
        { id: 'c1', annotation: 'left hand', lastModified: 1, x: 0, y: 0, width: 5, height: 5 },
        { id: 'c2', annotation: 'at 0:12', lastModified: 2, duration: 12 },
      ],
    });
    const text = JSON.stringify(rec);
    const p = projectRecord(rec, text, tree);

    expect(p.item).toMatchObject({
      star: 4,
      tag_count: 2,
      imported_at: 1779741123280,
      imported_at_str: '1779741123280',
      record_json: text,
      is_deleted: 0,
    });
    // A folder id that isn't in the tree stays on the record but doesn't count.
    expect(p.item.folder_count).toBe(2);
    expect(p.folders).toEqual([
      { folderId: 'F1', ord: '1708727558963.56655092592592592596' },
      { folderId: 'F2', ord: null },
      { folderId: 'GONE', ord: null },
    ]);
    expect(p.tags).toEqual(['Gerome', 'oil']);
    // Lists are joined with newlines so a quoted phrase can't run from one tag into the next.
    expect(p.fts).toEqual({
      name: 'Shirley Fox',
      tags: 'Gerome\noil',
      annotation: 'a note',
      url: 'https://example.com/x',
      folder_names: 'Portraits\nLandscapes',
      ext: 'jpg',
      comments: 'left hand\nat 0:12',
      folder_descriptions: 'faces',
    });
    expect(p.item.comments).toBe('left hand\nat 0:12');
  });

  it('keeps a string modificationTime exactly, and defaults an absent star to 0', () => {
    const p = projectRecord(makeItem('X', { modificationTime: '1779741123280.51' }), '{}', tree);
    expect(p.item.imported_at).toBe(1779741123280.51);
    expect(p.item.imported_at_str).toBe('1779741123280.51');
    expect(p.item.star).toBe(0);
  });

  it('turns palettes into rounded Lab rows and survives junk entries', () => {
    const rec = makeItem('P', {
      palettes: [
        { color: [255, 0, 0], ratio: 40, $$hashKey: 'object:1' },
        { color: 'not a color' as unknown as [number, number, number], ratio: 10 },
        { color: [239, 241, 234], ratio: 1.92 },
      ],
    });
    const p = projectRecord(rec, '{}', tree);
    expect(p.palette).toHaveLength(2);
    expect(p.palette[0]).toEqual({
      idx: 0,
      r: 255,
      g: 0,
      b: 0,
      l: 53.24,
      a: 80.09,
      bb: 67.2,
      ratio: 40,
    });
    expect(p.palette[1].idx).toBe(1);
  });
});
