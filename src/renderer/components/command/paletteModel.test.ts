import { describe, expect, it } from 'vitest';
import { buildPalette, type PaletteInput } from './paletteModel';

const base: PaletteInput = {
  text: '',
  selectionCount: 0,
  canEdit: true,
  currentKeywords: '',
  tagSuggestions: [],
  folderSuggestions: [],
  knownTags: ['Flesh Tones', 'Color Poetry'],
  commands: [
    { id: 'edit.undo', title: 'Undo', keys: ['Ctrl+Z'], icon: 'undo-2' },
    { id: 'app.search', title: 'Search…', keys: ['Ctrl+F'] },
    { id: 'item.rename', title: 'Rename…', keys: ['F2', 'Ctrl+R'] },
    { id: 'view.zoomIn', title: 'Bigger thumbnails', keys: ['Ctrl+='] },
  ],
  recentCommandIds: [],
  libraries: [{ path: '/lib/Course Library.library', name: 'Course Library' }],
};

const titles = (input: Partial<PaletteInput>) =>
  buildPalette({ ...base, ...input }).map((s) => s.title);
const labels = (input: Partial<PaletteInput>, section: string) =>
  buildPalette({ ...base, ...input })
    .find((s) => s.title === section)
    ?.rows.map((r) => r.segs.map((g) => g.text).join('')) ?? [];

describe('buildPalette', () => {
  const typed: Partial<PaletteInput> = {
    text: 'fle',
    selectionCount: 2,
    tagSuggestions: [{ label: 'Flesh Tones', count: 8 }],
    folderSuggestions: [
      {
        kind: 'folder',
        id: 'F1',
        label: 'Robert Fleury',
        path: 'Teachers › Robert Fleury',
        count: 29,
      },
      { kind: 'smartFolder', id: 'S1', label: 'Fleshy', path: 'Fleshy', count: 4 },
    ],
  };

  it('puts Search first, then tags, folders and commands, like the mockup', () => {
    expect(titles(typed)).toEqual(['Search', 'Tags', 'Folders']);
    expect(labels(typed, 'Search')).toEqual(['Search for “fle”']);
    expect(labels(typed, 'Tags')).toEqual([
      'Add tag Flesh Tones to 2 selected',
      'Show items tagged Flesh Tones',
      'Create tag “fle” and add to 2 selected',
    ]);
  });

  it('offers to add the selection to folders but only go-to for smart folders', () => {
    expect(labels(typed, 'Folders')).toEqual([
      'Go to Teachers › Robert Fleury',
      'Add 2 selected to Teachers › Robert Fleury',
      'Go to Fleshy',
    ]);
  });

  it('with nothing selected, tags can only be shown, and no create row appears', () => {
    expect(labels({ ...typed, selectionCount: 0 }, 'Tags')).toEqual([
      'Show items tagged Flesh Tones',
    ]);
  });

  it('does not offer to create a tag that exists (ignoring case)', () => {
    expect(labels({ ...typed, text: 'flesh tones' }, 'Tags')).not.toContain(
      'Create tag “flesh tones” and add to 2 selected',
    );
  });

  it('read-only libraries get no add or create rows', () => {
    const rows = labels({ ...typed, canEdit: false }, 'Tags').concat(
      labels({ ...typed, canEdit: false }, 'Folders'),
    );
    expect(rows.some((r) => r.startsWith('Add') || r.startsWith('Create'))).toBe(false);
  });

  it('puts commands first when you type the start of one, so Enter runs it', () => {
    expect(titles({ text: 'rename' })[0]).toBe('Commands');
    expect(titles({ text: 'bigger thumb' })[0]).toBe('Commands');
    // A short or partial match is still a search first.
    expect(titles({ text: 'ren' })[0]).toBe('Search');
    expect(titles({ text: 'thumbnails' })[0]).toBe('Search');
  });

  it('matches commands and libraries by fuzzy text', () => {
    expect(labels({ text: 'ren' }, 'Commands')).toEqual(['Rename…']);
    expect(labels({ text: 'coul' }, 'Libraries')).toEqual(['Switch to Course Library']);
  });

  it('shows recent then suggested commands when empty, and a way to clear the current search', () => {
    const s = buildPalette({
      ...base,
      recentCommandIds: ['edit.undo', 'gone.command'],
      currentKeywords: 'oil',
    });
    expect(s.map((x) => x.title)).toEqual(['Search', 'Recent', 'Commands']);
    expect(s[1].rows.map((r) => r.action)).toEqual([{ kind: 'command', id: 'edit.undo' }]);
    expect(s[1].rows[0].keys).toBe('Ctrl Z');
    expect(s[2].rows.map((r) => r.action)).not.toContainEqual({ kind: 'command', id: 'edit.undo' });
  });

  it('offers the last searches (not the one already on) to run again', () => {
    const s = buildPalette({
      ...base,
      currentKeywords: 'oil',
      recentSearches: ['oil', 'hands', 'sketch'],
    });
    expect(
      labels(
        { currentKeywords: 'oil', recentSearches: ['oil', 'hands', 'sketch'] },
        'Recent searches',
      ),
    ).toEqual(['hands', 'sketch']);
    expect(s.find((x) => x.title === 'Recent searches')?.rows[0].action).toEqual({
      kind: 'search',
      text: 'hands',
    });
  });
});
