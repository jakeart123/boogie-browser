import { describe, expect, it } from 'vitest';
import { expandRenameTemplate, type RenameSource } from './rename';

const day = new Date(2026, 8, 5, 14, 7, 9).getTime(); // local time: 2026-09-05 14:07:09
const src = (name: string, tags: string[] = []): RenameSource => ({ name, tags, importedAt: day });

describe('expandRenameTemplate', () => {
  it('numbers with %N from start, padded to the width of the last number', () => {
    const many = Array.from({ length: 12 }, (_, i) => src(`p${i}`));
    const out = expandRenameTemplate('Study %N', many);
    expect(out[0]).toBe('Study 01');
    expect(out[11]).toBe('Study 12');
    expect(expandRenameTemplate('%N', [src('a'), src('b')], { start: 99 })).toEqual(['099', '100']);
  });

  it('keeps the original name with * and fills date and tag tokens', () => {
    const [out] = expandRenameTemplate('* %D | %DD | %DDD | %T', [
      src('Sketch', ['oil', 'gerome']),
    ]);
    expect(out).toBe('Sketch 20260905 | 2026-09-05 | 2026-09-05 14.07.09 | oil, gerome');
  });

  it('runs find/replace after the template, as plain text or a regex', () => {
    expect(expandRenameTemplate('* copy', [src('a_b')], { find: '_', replace: ' ' })).toEqual([
      'a b copy',
    ]);
    // Plain text: regex characters and $ patterns mean nothing.
    expect(expandRenameTemplate('*', [src('a.b')], { find: '.', replace: '$&' })).toEqual(['a$&b']);
    expect(
      expandRenameTemplate('*', [src('IMG_0042')], {
        find: '^IMG_0*',
        replace: 'Photo ',
        regex: true,
      }),
    ).toEqual(['Photo 42']);
    expect(() => expandRenameTemplate('*', [src('a')], { find: '(', regex: true })).toThrow(
      /not a valid/,
    );
  });

  it('leaves unknown tokens alone', () => {
    expect(expandRenameTemplate('100% %X', [src('a')])).toEqual(['100% %X']);
  });
});
