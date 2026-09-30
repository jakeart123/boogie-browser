import { describe, expect, it } from 'vitest';
import type { FolderNode } from '../../shared/types';
import { folderSortSpec, sortIncreaseFromAscending } from './sorts';

const folder = (orderBy: FolderNode['orderBy'], sortIncrease: boolean | null) =>
  ({ orderBy, sortIncrease }) as FolderNode;

// A folder's sortIncrease is Eagle's flag ("Eagle's own order"), which is newest / top first for
// dates and manual order. Mixing it up with "ascending" reversed folders in the real app.
describe('folder sort flags', () => {
  it('reads Eagle flags as literal directions', () => {
    expect(folderSortSpec(folder('MANUAL', true))).toEqual({ by: 'MANUAL', ascending: false });
    expect(folderSortSpec(folder('IMPORT', true))).toEqual({ by: 'IMPORT', ascending: false });
    expect(folderSortSpec(folder('NAME', true))).toEqual({ by: 'NAME', ascending: true });
    expect(folderSortSpec(folder('RESOLUTION', null))?.ascending).toBe(false); // missing = reversed
    expect(folderSortSpec(folder(null, null))).toBeNull();
  });

  it('writes literal directions back as Eagle flags', () => {
    expect(sortIncreaseFromAscending('IMPORT', false)).toBe(true);
    expect(sortIncreaseFromAscending('MANUAL', false)).toBe(true);
    expect(sortIncreaseFromAscending('NAME', false)).toBe(false);
  });
});
