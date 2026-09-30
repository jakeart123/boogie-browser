import { describe, expect, it } from 'vitest';
import { expandRenameTemplate } from '../../../core/service/rename';
import { regexError, renamePreview } from './renameTemplate';

const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) =>
  new Date(y, mo - 1, d, h, mi, s).getTime();
const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    name: `IMG_${i}`,
    tags: ['oil', 'study'],
    importedAt: at(2026, 1, 16, 15, 1, 9),
  }));

describe('renamePreview', () => {
  it('pads %N to the width of the last number', () => {
    const out = renamePreview(items(12), 'Study %N');
    expect(out[0]).toBe('Study 01');
    expect(out[11]).toBe('Study 12');
    expect(renamePreview(items(3), '%N', { start: 8 })).toEqual(['08', '09', '10']);
    // a preview of the first 2 of 12 still pads for 12
    expect(renamePreview(items(2), '%N', { total: 12 })).toEqual(['01', '02']);
  });

  it('expands the date and tag tokens, longest token first', () => {
    const [n] = renamePreview(items(1), '%DDD | %DD | %D | %T | *');
    expect(n).toBe('2026-01-16 15.01.09 | 2026-01-16 | 20260116 | oil, study | IMG_0');
  });

  it('runs find/replace after the template, literal or regex', () => {
    expect(renamePreview(items(1), '* copy', { find: 'IMG_', replace: '' })).toEqual(['0 copy']);
    expect(renamePreview(items(1), '*', { find: '[0-9]+', replace: 'N', regex: true })).toEqual([
      'IMG_N',
    ]);
    // a regex that does not compile leaves the name alone instead of throwing
    expect(renamePreview(items(1), '*', { find: '(', replace: 'x', regex: true })).toEqual([
      'IMG_0',
    ]);
    expect(regexError('(')).not.toBeNull();
    expect(regexError('a+')).toBeNull();
  });

  it('falls back to 1 for a start number the service would refuse', () => {
    expect(renamePreview(items(2), '%N', { start: -4 })).toEqual(['1', '2']);
    expect(renamePreview(items(2), '%N', { start: 2.5 })).toEqual(['1', '2']);
    expect(renamePreview(items(2), '%N', { start: 0 })).toEqual(['0', '1']);
  });

  it('treats an empty template as keep-the-name', () => {
    expect(renamePreview(items(2), '')).toEqual(['IMG_0', 'IMG_1']);
  });
});

describe('the preview and the service', () => {
  it('give the same names (the service is src/core/service/rename.ts)', () => {
    const cases: [string, Parameters<typeof renamePreview>[2]][] = [
      ['Study %N - *', { start: 7 }],
      ['%DDD | %DD | %D | %T', {}],
      ['* copy', { find: 'IMG_', replace: 'Pic ' }],
      ['*', { find: '_(\\d)', replace: '-$1', regex: true }],
    ];
    for (const [tpl, opts] of cases)
      expect(renamePreview(items(12), tpl, opts)).toEqual(
        expandRenameTemplate(tpl, items(12), opts),
      );
  });
});
