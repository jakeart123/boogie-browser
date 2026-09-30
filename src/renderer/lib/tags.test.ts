// Typed tags must land on the library's spelling (Eagle tags are case-sensitive, so a case
// variant would be a second tag in the partner's Eagle).
import { describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({ api: {}, on: () => () => {}, inElectron: false }));

import { canonicalTag, renameTarget, splitTags } from './tags';
import { library } from './stores/library.svelte';

library.tags = [
  { name: 'Flesh Tones', count: 12, groupIds: [] },
  { name: 'Color Poetry', count: 3, groupIds: [] },
];

describe('typed tags', () => {
  it('reuse the library spelling ignoring case, and keep new ones as typed', () => {
    expect(canonicalTag('flesh tones')).toBe('Flesh Tones');
    expect(canonicalTag('  Color poetry ')).toBe('Color Poetry');
    expect(canonicalTag('brand new')).toBe('brand new');
    expect(splitTags(' flesh tones, b ,,FLESH TONES,  c ')).toEqual(['Flesh Tones', 'b', 'c']);
  });
  it('rename onto another tag in any case merges into it, but a case fix of itself stays', () => {
    expect(renameTarget('Color Poetry', 'flesh tones')).toBe('Flesh Tones');
    expect(renameTarget('Color Poetry', 'color poetry')).toBe('color poetry');
  });
});
