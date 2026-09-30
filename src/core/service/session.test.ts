import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filePathOf } from './session';

describe("an item's file path from its record", () => {
  const dir = join('/lib', 'images', 'LT24XY3DPJFLK.info');

  it('is <name>.<ext> inside the item folder', () => {
    expect(filePathOf(dir, { name: 'Study (1)', ext: 'jpg' })).toBe(join(dir, 'Study (1).jpg'));
  });

  it("never leaves the folder, whatever a partner's or downloaded record says", () => {
    for (const rec of [
      { name: 'x', ext: 'jpg/../../../escaped' },
      { name: '../../x', ext: 'jpg' },
      { name: 'a\\b', ext: 'png' },
      { name: '.', ext: '' },
    ])
      expect(filePathOf(dir, rec)).toBe(dir);
    expect(filePathOf(dir, null)).toBe(dir);
  });
});
