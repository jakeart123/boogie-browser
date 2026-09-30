import { describe, expect, it } from 'vitest';
import { clueLine, parseNote, sameClue, sourceSite, suggest } from './clues';

describe('parseNote', () => {
  it('reads "Label: value" lines and museum label/value line pairs', () => {
    expect(parseNote('Artist: Morisset, François Henri\nDate: 1891\nStudent of: Delaunay')).toEqual(
      [
        { label: 'Artist', value: 'Morisset, François Henri' },
        { label: 'Date', value: '1891' },
        { label: 'Student of', value: 'Delaunay' },
      ],
    );
    // A real note from the Art Archive (a museum page pasted in, blank lines and all).
    const museum =
      'Artist\n\nCarl von Marr (Milwaukee 1858–1936 Munich)\n\nTitle\n\nFlagellants\n\nYear\n\n1885–89';
    expect(parseNote(museum)).toEqual([
      { label: 'Artist', value: 'Carl von Marr (Milwaukee 1858–1936 Munich)' },
      { label: 'Title', value: 'Flagellants' },
      { label: 'Year', value: '1885–89' },
    ]);
  });

  it('leaves prose, links and times alone and reads through HTML', () => {
    expect(parseNote('Signed lower left.\nhttps://example.com/a\nAt 10:30 in the studio')).toEqual(
      [],
    );
    expect(parseNote('<div>Teacher: Bonnat</div><div><br></div>')).toEqual([
      { label: 'Teacher', value: 'Bonnat' },
    ]);
  });

  it('makes one short line for the queue list', () => {
    expect(clueLine('Artist: Morisset\nDate: 1891')).toBe('Morisset · 1891');
    expect(clueLine('\n  Oil on wood.\nSigned lower left.')).toBe('Oil on wood.');
    expect(sourceSite('https://www.proantic.com/x')).toBe('proantic.com');
    expect(sourceSite('not a link')).toBe('');
  });
});

describe('sameClue', () => {
  it('matches the whole fact, never a longer name or a sentence that mentions it', () => {
    // The five notes behind the "Tag all 5" that should have been 3.
    const clue = { label: 'Student of', value: 'Gerome' };
    const notes = [
      'Student of: Gerome',
      'Date: 1880\nStudent of: Gerome',
      'student of: GEROME',
      'The Geromeo family',
      'a dealer who hated Gerome',
    ];
    expect(notes.map((n) => sameClue(n, clue))).toEqual([true, true, true, false, false]);
    expect(sameClue('Student of: Geromeo', clue)).toBe(false);
    expect(sameClue('Teacher: Gerome', clue)).toBe(false);
  });
});

describe('suggest', () => {
  const clues = [
    { label: 'Student of', value: 'Delaunay' },
    { label: 'Artist', value: 'Morisset, François Henri' },
  ];
  const folders = [
    { id: 'F1', name: 'Atelier Delaunay' },
    { id: 'F2', name: 'Delaunay-ish' }, // words split at the dash, so it names Delaunay too
    { id: 'F3', name: 'Anatomy' },
  ];

  it('suggests tags and folders a clue names, whole words only, best match first', () => {
    const got = suggest(clues, ['Atelier Delaunay', 'Morisset', 'Del', 'Portrait'], folders, {
      tags: [],
      folders: [],
    });
    expect(got.map((s) => `${s.kind}:${s.name}`)).toEqual([
      'tag:Morisset', // the value "Morisset, François Henri" contains the tag name
      'folder:Delaunay-ish',
      'tag:Atelier Delaunay',
      'folder:Atelier Delaunay',
    ]);
    expect(got[0].clue.label).toBe('Artist');
  });

  it('skips what the item already has', () => {
    const got = suggest(clues, ['Atelier Delaunay'], folders.slice(0, 1), {
      tags: ['Atelier Delaunay'],
      folders: ['F1'],
    });
    expect(got).toEqual([]);
  });
});
