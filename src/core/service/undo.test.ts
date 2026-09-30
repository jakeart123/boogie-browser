import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '../../shared/types';
import { findRedo, findUndoable } from './undo';

describe('finding what to undo or redo (pure)', () => {
  const entry = (
    groupId: string,
    kind: HistoryEntry['kind'],
    over: Partial<HistoryEntry> = {},
  ): HistoryEntry => ({
    groupId,
    libraryId: 'L',
    actor: { kind: 'user', name: 'You' },
    label: groupId,
    at: 0,
    itemIds: [],
    itemCount: 0,
    kind,
    undoable: true,
    undoneBy: null,
    ...over,
  });
  const me = { kind: 'user', name: 'You' } as const;

  it('finds your newest undoable action, skipping undos, others, and undone ones', () => {
    const list = [
      entry('undo1', 'undo'),
      entry('partner', 'external', { actor: { kind: 'external', name: 'Sam' } }),
      entry('agent', 'items', { actor: { kind: 'agent', name: 'Claude (mcp)' } }),
      entry('done', 'items', { undoneBy: 'undo0' }),
      entry('mine', 'items'),
    ];
    expect(findUndoable(list, me)?.groupId).toBe('mine');
    expect(findUndoable(list, { kind: 'agent', name: 'Claude (mcp)' })?.groupId).toBe('agent');
    // Ctrl+Z never reverts a background save by the browser extension (also a "user" actor).
    const saved = entry('ext', 'import', { actor: { kind: 'user', name: 'Browser extension' } });
    expect(findUndoable([saved, ...list], me)?.groupId).toBe('mine');
    expect(findUndoable(list, { kind: 'agent', name: 'Someone else' })).toBeNull();
    // Your newest action can't be undone: it is found anyway (undo() says so) instead of
    // silently undoing an older one behind it.
    const nope = entry('nope', 'items', { undoable: false });
    expect(findUndoable([nope, entry('older', 'items')], me)?.groupId).toBe('nope');
  });

  it('finds the undo to redo', () => {
    expect(
      findRedo([entry('u', 'undo'), entry('a', 'items', { undoneBy: 'u' })], me)?.groupId,
    ).toBe('u');
    // a normal action after the undo clears redo
    expect(
      findRedo(
        [entry('c', 'items'), entry('u', 'undo'), entry('a', 'items', { undoneBy: 'u' })],
        me,
      ),
    ).toBeNull();
    // someone else's change in between does not
    expect(
      findRedo(
        [
          entry('partner', 'external', { actor: { kind: 'external', name: 'Sam' } }),
          entry('u', 'undo'),
          entry('a', 'items', { undoneBy: 'u' }),
        ],
        me,
      )?.groupId,
    ).toBe('u');
    // already redone: u was undone by r (a redo), so nothing is left
    expect(
      findRedo(
        [
          entry('r', 'undo'),
          entry('u', 'undo', { undoneBy: 'r' }),
          entry('a', 'items', { undoneBy: 'u' }),
        ],
        me,
      ),
    ).toBeNull();
    // two undos, one redo: the older undo is still there to redo
    expect(
      findRedo(
        [
          entry('r', 'undo'),
          entry('u2', 'undo', { undoneBy: 'r' }),
          entry('u1', 'undo'),
          entry('b', 'items', { undoneBy: 'u1' }),
          entry('a', 'items', { undoneBy: 'u2' }),
        ],
        me,
      )?.groupId,
    ).toBe('u1');
  });

  it('Ctrl+Z after a redo undoes the redo (so undo, redo, undo works again), not the action it re-applied', () => {
    const list = [
      entry('r', 'undo'),
      entry('u', 'undo', { undoneBy: 'r' }),
      entry('a', 'items', { undoneBy: 'u' }),
    ];
    expect(findUndoable(list, me)?.groupId).toBe('r');
    // ... and once that is undone (by r2), the next Ctrl+Z goes past it; and redo has u's redo r2 to undo
    const after = [
      entry('r2', 'undo'),
      ...list.map((e) => (e.groupId === 'r' ? { ...e, undoneBy: 'r2' } : e)),
    ];
    expect(findUndoable(after, me)).toBeNull();
    expect(findRedo(after, me)?.groupId).toBe('r2');
  });
});
