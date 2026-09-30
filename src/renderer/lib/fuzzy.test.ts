import { describe, expect, it } from 'vitest';
import { fuzzy, fuzzyTight, segments } from './fuzzy';

describe('fuzzy', () => {
  it('finds subsequences and reports where they matched ("mki" -> Mockup iPhone)', () => {
    expect(fuzzy('mki', 'Mockup iPhone')?.positions).toEqual([0, 3, 7]);
    expect(fuzzy('xyz', 'Mockup iPhone')).toBeNull();
  });

  it('ranks prefixes and word starts above scattered matches', () => {
    const prefix = fuzzy('fle', 'Flesh Tones')!.score;
    const wordStart = fuzzy('fle', 'Teachers › Robert Fleury')!.score;
    const scattered = fuzzy('fle', 'Self Loathing Elegy')!.score;
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(scattered);
    expect(fuzzy('fle', 'Flesh Tones')!.score).toBeGreaterThan(
      fuzzy('fle', 'Flesh Tones Study Book')!.score,
    );
  });

  it('ignores spaces and case in the query', () => {
    expect(fuzzy('PRIX rome', 'Prix de Rome versions')).not.toBeNull();
  });

  it('keeps command matching tight: no "fle" inside "Filter by tags"', () => {
    expect(fuzzyTight('fle', 'Filter by tags')).toBeNull();
    expect(fuzzyTight('fle', 'Import files…')).toBeNull();
    expect(fuzzyTight('gtf', 'Go to folder…')).not.toBeNull(); // acronym
    expect(fuzzyTight('addf', 'Add to folder…')).not.toBeNull();
    expect(fuzzyTight('rename', 'Rename…')).not.toBeNull();
    // A title typed out in full, spaces and all, is one run.
    for (const title of ['Add from URL…', 'Save this filter…', 'Add to other library…'])
      expect(fuzzyTight(title.replace('…', ''), title)).not.toBeNull();
    expect(fuzzyTight('Add to other', 'Add to other library…')).not.toBeNull();
  });

  it('splits text into matched and plain runs', () => {
    expect(segments('Flesh', [0, 1, 2])).toEqual([
      { text: 'Fle', hit: true },
      { text: 'sh', hit: false },
    ]);
    expect(segments('abc', undefined)).toEqual([{ text: 'abc', hit: false }]);
  });
});
