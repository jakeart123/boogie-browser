import { expect, it, vi } from 'vitest';

vi.mock('./api', () => ({ api: {}, on: () => () => {}, inElectron: false }));

import { safeLink } from './files';

it('only opens web links', () => {
  expect(safeLink('https://x.org/a?b=1')).toBe('https://x.org/a?b=1');
  expect(safeLink('example.com/page')).toBe('https://example.com/page');
  expect(safeLink('javascript:alert(1)')).toBeNull();
  expect(safeLink('file:///etc/passwd')).toBeNull();
  expect(safeLink('  ')).toBeNull();
});
