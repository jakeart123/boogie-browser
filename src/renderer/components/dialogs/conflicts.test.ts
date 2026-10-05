import { describe, expect, it } from 'vitest';
import type { ConflictFile, ConflictQuestion } from '../../../shared/types';
import {
  copyName,
  removalNote,
  settledText,
  settleLabel,
  splitQuestions,
  whyListed,
} from './conflicts';

const q = (id: string, copy = 'x'): ConflictQuestion => ({ id, label: id, live: 'live', copy });
const file = (kind: ConflictFile['kind']): ConflictFile => ({
  path: 'a',
  kind,
  itemId: null,
  detectedAt: 0,
});

describe('conflicted copies dialog words', () => {
  it('sets removals apart only when there are enough to bury the rest', () => {
    // A few removals stay in the list with everything else.
    const few = [q('a'), q('b', '(none)'), q('c', '(none)'), q('d', '(none)')];
    expect(splitQuestions(few)).toEqual({ main: few, removals: [] });
    // A folder list that lacks dozens of folders: they become one block, the changes stay on top.
    const many = [q('rename'), ...Array.from({ length: 38 }, (_, i) => q(`f${i}`, '(none)'))];
    const split = splitQuestions(many);
    expect(split.main.map((x) => x.id)).toEqual(['rename']);
    expect(split.removals).toHaveLength(38);
  });

  it('says what the Settle button will do, and when a pick removes something', () => {
    expect(settleLabel(0)).toBe('Keep the library as it is');
    expect(settleLabel(2)).toBe('Take 2 from the copy');
    expect(removalNote(0)).toBeNull();
    expect(removalNote(1)).toBe('One of your picks removes something from the library.');
    expect(removalNote(3)).toBe('3 of your picks remove something from the library.');
    expect(settledText(0)).toBe('Settled the copy and kept the library as it is');
    expect(settledText(1)).toBe('Settled the copy and took 1 change from it');
  });

  it('explains why a copy with no questions is still listed', () => {
    expect(whyListed(file('thumbnail'), false)).toMatch(/thumbnail is missing/);
    expect(whyListed(file('other'), false)).toMatch(/leaves this kind of file alone/);
    expect(whyListed(file('item'), true)).toMatch(/read-only/);
    expect(whyListed(file('item'), false)).toMatch(/still checking/);
  });

  it('shows an item copy by its file name, not the id folder', () => {
    expect(copyName("images/MABC.info/metadata (Sam's conflicted copy 2026-10-01).json")).toBe(
      "metadata (Sam's conflicted copy 2026-10-01).json",
    );
    expect(copyName('metadata.json')).toBe('metadata.json');
  });
});
