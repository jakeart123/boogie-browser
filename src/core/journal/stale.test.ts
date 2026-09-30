import { describe, expect, it } from 'vitest';
import { staleRevert } from './stale';

const base = {
  id: 'A',
  name: 'Study',
  tags: ['a', 'b'],
  folders: ['F1'],
  isDeleted: false,
  star: 2,
  order: { F1: '100' },
  lastModified: 1,
};

describe('staleRevert: did the outside write put an old copy back over your change?', () => {
  it('no: the partner had your version and changed something else', () => {
    const ours = { ...base, tags: ['a', 'b', 'mine'], lastModified: 2 };
    const theirs = { ...ours, star: 5, lastModified: 3 };
    expect(staleRevert(base, ours, theirs)).toBeNull();
  });

  it('yes: every field you changed that is back to the old value, and only those', () => {
    const ours = {
      ...base,
      name: 'Renamed',
      tags: ['a', 'mine'], // +mine, -b
      folders: ['F1', 'F2'],
      star: 4,
      order: { F1: '50' },
      lastModified: 2,
    };
    const theirs = { ...base, tags: ['a', 'b', 'sam'], annotation: 'theirs', lastModified: 3 };
    expect(staleRevert(base, ours, theirs)).toEqual({
      ...ours,
      name: 'Study',
      tags: ['a', 'b'], // mine lost, b back (their new tag is not part of this)
      folders: ['F1'],
      star: 2,
      order: { F1: '100' },
    });
  });

  it('trash is one unit, and a deletedTime Eagle re-adds from memory is not a revert', () => {
    const trashed = { ...base, isDeleted: true, deletedTime: 5, lastModified: 2 };
    expect(staleRevert(base, trashed, { ...base, lastModified: 3 })).toMatchObject({
      isDeleted: false,
    });
    const restoredBase = { ...base, isDeleted: true, deletedTime: 5 };
    const restored = { ...base, lastModified: 2 };
    const eagleSave = { ...base, deletedTime: 5, star: 3, lastModified: 3 };
    expect(staleRevert(restoredBase, restored, eagleSave)).toBeNull();
  });

  it('a field you cleared that the old copy still has counts, and $$hashKey noise does not', () => {
    const ours = { ...base, lastModified: 2 } as Record<string, unknown>;
    delete ours.star;
    expect(staleRevert(base, ours, { ...base, lastModified: 3 })).toMatchObject({ star: 2 });
    const pal = [{ color: [1, 2, 3], ratio: 100 }];
    const withPal = { ...base, palettes: pal, tags: ['a', 'b', 'x'] };
    const eagleCopy = {
      ...base,
      palettes: [{ ...pal[0], $$hashKey: 'object:1' }],
      tags: ['a', 'b', 'x'],
    };
    expect(staleRevert({ ...base, palettes: pal }, withPal, eagleCopy)).toBeNull();
  });
});
