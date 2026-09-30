import { describe, expect, it } from 'vitest';
import { refAction, stepList } from './keys';

describe('reference window keys', () => {
  it('uses the detail view keys and keeps its own single keys', () => {
    for (const k of ['Shift+H', 'Shift+F', 'H']) expect(refAction(k)).toBe('flip');
    for (const k of ['Ctrl+Alt+G', 'G']) expect(refAction(k)).toBe('gray');
    for (const k of ['Shift+R', 'R']) expect(refAction(k)).toBe('rotate');
    expect([
      refAction('ArrowLeft'),
      refAction('A'),
      refAction('ArrowRight'),
      refAction('D'),
    ]).toEqual(['prev', 'prev', 'next', 'next']);
    expect([refAction('3'), refAction('0'), refAction('Ctrl+0')]).toEqual([
      { opacity: 0.3 },
      { opacity: 1 },
      'actual',
    ]);
    expect(refAction('Q')).toBeNull();
  });

  it('steps through the app list, else the page URL, always including the opened item', () => {
    expect(stepList('b', ['a', 'b', 'c'], '')).toEqual(['a', 'b', 'c']);
    expect(stepList('b', undefined, '?window=reference&item=b&items=a,b,c')).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(stepList('z', [], '?items=a,b')).toEqual(['z', 'a', 'b']);
    expect(stepList('z', undefined, '')).toEqual(['z']);
  });
});
