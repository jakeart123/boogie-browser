import { describe, expect, it } from 'vitest';
import type { HistoryEntry, TagGroup, TagInfo } from '../../../shared/types';
import {
  afterActor,
  commonValue,
  countToday,
  dayLabel,
  entryText,
  groupByDay,
  groupTags,
  hex,
  keepLineEndings,
  lastActor,
  normalizeNewlines,
  onEveryItem,
  reversedIds,
  rowParts,
  topTags,
  undoLabel,
  unionCounts,
} from './logic';

const group = (id: string, tags: string[]): TagGroup => ({
  id,
  name: id,
  tags,
  color: null,
  description: '',
});
const entry = (over: Partial<HistoryEntry>): HistoryEntry => ({
  groupId: 'g',
  libraryId: 'l',
  actor: { kind: 'user', name: 'You' },
  label: 'Edited 1 item',
  at: 0,
  itemIds: [],
  itemCount: 1,
  kind: 'items',
  undoable: true,
  undoneBy: null,
  ...over,
});

describe('multi-select tag union', () => {
  it('counts partial tags and puts the ones on every item first', () => {
    const u = unionCounts([['a', 'b'], ['b'], ['b', 'c']]);
    expect(u).toEqual([
      { key: 'b', count: 3 },
      { key: 'a', count: 1 },
      { key: 'c', count: 1 },
    ]);
  });

  it('keeps a single item in its stored order', () => {
    expect(unionCounts([['z', 'a', 'm']]).map((t) => t.key)).toEqual(['z', 'a', 'm']);
  });

  it('counts a repeated tag on one item once', () => {
    expect(unionCounts([['a', 'a'], []])).toEqual([{ key: 'a', count: 1 }]);
  });
});

describe('tags already on every selected item', () => {
  const counts = unionCounts([['a', 'b'], ['b'], ['b', 'c']]);

  it('leaves out a tag only some items have, so typing it still adds it to the rest', () => {
    expect([...onEveryItem(counts, 3, 3)]).toEqual(['b']);
  });

  it('counts nothing as present when the selection was cut short', () => {
    expect(onEveryItem(counts, 3, 5000).size).toBe(0);
  });
});

describe('tag groups', () => {
  const tags = (...k: string[]) => k.map((key) => ({ key, count: 1 }));

  it('stays flat when no tag is in a group', () => {
    const r = groupTags(tags('x', 'y'), [group('G', ['q'])]);
    expect(r.grouped).toBe(false);
    expect(r.sections).toHaveLength(1);
  });

  it('puts tags under their group, ungrouped last, and uses the first group for a shared tag', () => {
    const r = groupTags(tags('x', 'y', 'z'), [group('One', ['y']), group('Two', ['y', 'z'])]);
    expect(r.grouped).toBe(true);
    expect(r.sections.map((s) => [s.group?.id ?? null, s.tags.map((t) => t.key)])).toEqual([
      ['One', ['y']],
      ['Two', ['z']],
      [null, ['x']],
    ]);
  });
});

describe('frequent tag suggestions', () => {
  const lib: TagInfo[] = [
    { name: 'a', count: 5, groupIds: [] },
    { name: 'b', count: 50, groupIds: [] },
    { name: 'c', count: 20, groupIds: [] },
    { name: 'd', count: 20, groupIds: [] },
    { name: 'e', count: 1, groupIds: [] },
  ];
  it('takes the most used tags the items do not have yet', () => {
    expect(topTags(lib, new Set(['b']), 3)).toEqual(['c', 'd', 'a']);
    expect(topTags(lib, new Set(), 2)).toEqual(['b', 'c']);
  });
});

describe('notes and links', () => {
  it('shows a shared value, flags differing ones', () => {
    expect(commonValue(['n', 'n'])).toEqual({ mixed: false, value: 'n' });
    expect(commonValue(['n', 'm'])).toEqual({ mixed: true, value: '' });
  });
  it('treats CRLF notes as unchanged after a textarea round trip', () => {
    expect(normalizeNewlines('a\r\nb\rc\n')).toBe('a\nb\nc\n');
  });
  it('keeps a Windows note in CRLF when it is edited, and leaves other notes alone', () => {
    expect(keepLineEndings('a\nb\nc', 'a\r\nb')).toBe('a\r\nb\r\nc');
    expect(keepLineEndings('a\nb\nc', 'a\nb')).toBe('a\nb\nc');
    expect(keepLineEndings('a\nb', 'a\r\nb\nc')).toBe('a\nb'); // mixed: stay with LF
    expect(keepLineEndings('one line', '')).toBe('one line');
  });
});

describe('formatting', () => {
  it('hex', () => {
    expect(hex([255, 0, 16])).toBe('#FF0010');
  });
  it('history wording', () => {
    expect(afterActor('Tagged 48 items X')).toBe('tagged 48 items X');
    expect(afterActor('PSD files moved')).toBe('PSD files moved');
    expect(undoLabel(entry({ itemCount: 48 }), [])).toBe('Undo all 48');
    expect(undoLabel(entry({ itemCount: 1 }), [])).toBe('Undo');
  });
});

describe('history row wording', () => {
  it('never repeats the name an outside label already starts with', () => {
    const sam = { kind: 'external' as const, name: 'Sam' };
    const text = (e: HistoryEntry) => {
      const p = rowParts(e, [e]);
      return p.who + p.rest;
    };
    expect(text(entry({ actor: sam, label: 'Sam edited 1 item' }))).toBe('Sam edited 1 item');
    expect(
      text(entry({ actor: sam, label: 'Sam’s Eagle may have written an old copy over “X”' })),
    ).toBe('Sam’s Eagle may have written an old copy over “X”');
    const outside = { kind: 'external' as const, name: 'Outside Boogie' };
    const p = rowParts(
      entry({ actor: outside, label: 'Changed outside Boogie: edited 1 item' }),
      [],
    );
    expect(p).toEqual({ who: '', rest: 'Changed outside Boogie: edited 1 item' });
    const you = { kind: 'user' as const, name: 'You' };
    expect(text(entry({ actor: you, label: 'Tagged 48 items X' }))).toBe('You tagged 48 items X');
  });
});

describe('history grouping', () => {
  const now = new Date(2026, 8, 28, 15, 0).getTime();
  const at = (d: number, h: number) => new Date(2026, 8, d, h, 30).getTime();

  it('groups newest-first entries by local day and counts today', () => {
    const list = [
      entry({ groupId: '1', at: at(28, 14) }),
      entry({ groupId: '2', at: at(28, 9) }),
      entry({ groupId: '3', at: at(27, 23) }),
      entry({ groupId: '4', at: at(20, 10) }),
    ];
    const days = groupByDay(list, now);
    expect(days.map((d) => [d.label, d.entries.length])).toEqual([
      ['Today', 2],
      ['Yesterday', 1],
      [dayLabel(at(20, 10), now), 1],
    ]);
    expect(countToday(list, now)).toBe(2);
  });

  it('words undo entries as undid / redid and labels their button Redo / Undo', () => {
    const x = entry({ groupId: 'x', label: 'Tagged 48 items \u201cX\u201d', itemCount: 48 });
    const undid = entry({
      groupId: 'u',
      kind: 'undo',
      undoOf: 'x',
      label: 'Undo: …',
      itemCount: 48,
    });
    const redid = entry({
      groupId: 'r',
      kind: 'undo',
      undoOf: 'u',
      label: 'Undo: …',
      itemCount: 48,
    });
    const list = [redid, undid, x];
    expect(entryText(undid, list)).toBe('undid: Tagged 48 items \u201cX\u201d');
    expect(entryText(redid, list)).toBe('redid: Tagged 48 items \u201cX\u201d');
    expect(undoLabel(undid, list)).toBe('Redo all 48');
    expect(undoLabel(redid, list)).toBe('Undo all 48');
    // a normal entry that happens to start with "Undo" is not an undo entry
    expect(entryText(entry({ label: 'Undo: not really' }), list)).toBe('undo: not really');
  });

  it('marks an undone entry as reversed, but not again once its undo was redone', () => {
    const x = entry({ groupId: 'x', undoneBy: 'u' });
    const u = entry({ groupId: 'u', kind: 'undo', undoneBy: null });
    expect([...reversedIds([u, x])]).toEqual(['x']);
    const redone = entry({ groupId: 'u', kind: 'undo', undoneBy: 'r' });
    const r = entry({ groupId: 'r', kind: 'undo' });
    expect([...reversedIds([r, redone, x])].sort()).toEqual(['u']);
    // the undoer is not loaded (or the backend has no undo entry): still undone
    expect([...reversedIds([x])]).toEqual(['x']);
  });

  it('finds who last touched an item', () => {
    const list = [
      entry({ itemIds: ['b'], actor: { kind: 'agent', name: 'Claude' } }),
      entry({ itemIds: ['a', 'b'], actor: { kind: 'external', name: 'Sam' } }),
    ];
    expect(lastActor(list, 'a')?.name).toBe('Sam');
    expect(lastActor(list, 'b')?.name).toBe('Claude');
    expect(lastActor(list, 'zzz')).toBeNull();
  });
});
