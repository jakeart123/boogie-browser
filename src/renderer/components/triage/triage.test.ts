import { describe, expect, it, vi } from 'vitest';
import { TriageSession, setOutcome } from '../../lib/stores/triage.svelte';
import { loadKeys, parseKeyMap, queueKey, renameTagInKeys, seedKeys } from '../../lib/triageKeys';
import { queueTokens } from './queue';

const session = (ids: string[]) =>
  new TriageSession({
    libraryId: 'lib',
    scope: { kind: 'untagged' },
    filter: {},
    sort: null,
    ids,
    keys: { folders: [], tags: [] },
    back: { region: 'grid', selection: [], primary: null },
  });

describe('triage session', () => {
  it('goes on to the next unsorted item, wrapping to the start, and knows when all are done', () => {
    const s = session(['a', 'b', 'c', 'd']);
    setOutcome(s, 'b', { kind: 'skipped' });
    expect(s.nextOpen(0)).toBe(2); // b is sorted
    setOutcome(s, 'c', { kind: 'trashed' });
    setOutcome(s, 'd', { kind: 'done' });
    expect(s.nextOpen(3)).toBe(0); // wraps
    setOutcome(s, 'a', { kind: 'done' });
    expect([s.nextOpen(0), s.sorted]).toEqual([-1, 4]);
  });

  it('counts items, not key presses: tagged while its last tag key added one, filed once', () => {
    const s = session(['a', 'b', 'c']);
    const step = (kind: 'tag' | 'untag' | 'file', id: string) => ({
      kind,
      id,
      index: 0,
      groupId: `g-${s.steps.length}`,
      label: '',
    });
    s.steps = [step('tag', 'a'), step('tag', 'b'), step('untag', 'b'), step('file', 'a')];
    setOutcome(s, 'a', { kind: 'filed', key: '2', name: 'Y', moved: false }); // filed twice
    setOutcome(s, 'c', { kind: 'done' });
    expect(s.stats).toEqual({ tagged: 1, filed: 1, skipped: 0, trashed: 0, done: 1 });
  });

  it('takes back a step undone elsewhere, and puts it back when that undo is redone', () => {
    const s = session(['a', 'b']);
    const filed = { kind: 'filed', key: '1', name: 'X', moved: false } as const;
    s.steps = [
      { kind: 'file', id: 'a', index: 0, groupId: 'g1', label: 'Filed in X', after: filed },
    ];
    setOutcome(s, 'a', filed);
    s.undone('u1', 'g1'); // Ctrl+Z
    expect([s.steps.length, s.outcomes.a, s.sorted]).toEqual([0, undefined, 0]);
    s.undone('u2', 'nope'); // not ours: nothing happens
    expect(s.steps.length).toBe(0);
    s.undone('r1', 'u1'); // Ctrl+Shift+Z: the undo is undone
    expect([s.steps.map((x) => x.groupId), s.outcomes.a]).toEqual([['r1'], filed]);
  });
});

describe('triage keys', () => {
  it('pins the first map a queue gets, and follows a tag rename or delete', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    });
    // Keys ranked by folder size must not move once items land in another folder.
    const counts = (big: string) => ({ A: { own: big === 'A' ? 90 : 5 }, B: { own: 10 } });
    const tags = [
      { name: 'Cats', count: 9 },
      { name: 'Dogs', count: 3 },
    ];
    const first = loadKeys('lib', 'untagged', () => seedKeys(counts('B'), tags, null));
    const later = loadKeys('lib', 'untagged', () => seedKeys(counts('A'), tags, null));
    expect([first.folders.slice(0, 2), later.folders.slice(0, 2)]).toEqual([
      ['B', 'A'],
      ['B', 'A'],
    ]);
    // Renamed in the tag manager: the key tags the new name, never the old one again.
    renameTagInKeys('lib', 'Cats', 'Kittens');
    renameTagInKeys('lib', 'Dogs', null);
    expect(loadKeys('lib', 'untagged', () => seedKeys({}, [], null)).tags.slice(0, 2)).toEqual([
      'Kittens',
      null,
    ]);
    vi.unstubAllGlobals();
  });

  it('seeds number keys with the folders holding the most items and letters with the top tags', () => {
    const map = seedKeys(
      { F1: { own: 5 }, F2: { own: 50 }, Q: { own: 99 }, E: { own: 0 } },
      [
        { name: 'rare', count: 1 },
        { name: 'common', count: 40 },
      ],
      'Q', // the queue's own folder
    );
    expect(map.folders.slice(0, 3)).toEqual(['F2', 'F1', null]);
    expect(map.folders).toHaveLength(9);
    expect(map.tags.slice(0, 3)).toEqual(['common', 'rare', null]);
  });

  it('reads a stored map defensively and names each queue by its scope', () => {
    expect(parseKeyMap(null)).toBeNull();
    expect(parseKeyMap({ folders: ['F1', 7, ''], tags: 'x' })).toEqual({
      folders: ['F1', null, null, null, null, null, null, null, null],
      tags: [null, null, null, null, null, null, null, null],
    });
    expect(queueKey({ kind: 'folder', id: 'F1', includeSubfolders: true })).toBe('folder:F1');
    expect(queueKey({ kind: 'untagged' })).toBe('untagged');
  });

  it('describes the queue the way the search box would', () => {
    const tokens = queueTokens(
      {
        scope: { kind: 'folder', id: 'F1', includeSubfolders: true },
        filter: {
          keywords: 'bust',
          rating: [5],
          tags: { mode: 'any', include: ['Hands'], exclude: [] },
        },
        sort: { by: 'IMPORT', ascending: true },
      },
      () => 'Class 2025',
    );
    expect(tokens.map((t) => t.key + t.value)).toEqual([
      'in:Class 2025',
      'bust',
      'tag:Hands',
      '+1 filter',
      'sort:date imported',
    ]);
  });
});
