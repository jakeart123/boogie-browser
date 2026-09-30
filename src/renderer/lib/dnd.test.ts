import { describe, expect, it } from 'vitest';
import { itemIdFromPath } from './dnd';

describe('itemIdFromPath', () => {
  const root = '/home/user/Dropbox/Art Archive/Art Archive.library';
  it('maps an original inside the library to its id', () => {
    expect(itemIdFromPath(`${root}/images/MTPWLI04YP6TN.info/Some Name.jpg`, root)).toBe(
      'MTPWLI04YP6TN',
    );
  });
  it('ignores files outside the library', () => {
    expect(itemIdFromPath('/home/user/Pictures/a.jpg', root)).toBeNull();
    expect(
      itemIdFromPath(
        '/home/user/Dropbox/Art Archive/Other.library/images/MTPWLI04YP6TN.info/a.jpg',
        root,
      ),
    ).toBeNull();
  });
});
