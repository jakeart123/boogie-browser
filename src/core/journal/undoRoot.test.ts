import { describe, expect, it } from 'vitest';
import { undoRoot } from './undoRoot';
import type { Conflict } from './util';

type Rec = Record<string, any>;

const folder = (id: string, name: string, children: Rec[] = [], extra: Rec = {}): Rec => ({
  id,
  name,
  description: '',
  children,
  modificationTime: 1,
  tags: [],
  password: '',
  passwordTips: '',
  ...extra,
});
const root = (folders: Rec[], extra: Rec = {}): Rec => ({
  folders,
  smartFolders: [],
  quickAccess: [],
  tagsGroups: [],
  modificationTime: 1,
  applicationVersion: '4.0.0',
  ...extra,
});
/** Run the undo on a copy of `current`. */
function run(current: Rec, before: Rec, after: Rec) {
  const out = structuredClone(current);
  const conflicts: Conflict[] = [];
  const changed = undoRoot(out, before, after, conflicts);
  return { out, conflicts, changed };
}
/** Compare trees ignoring modificationTime noise. */
const names = (list: Rec[]): any[] =>
  list.map((f) => (f.children?.length ? [f.name, names(f.children)] : f.name));

describe('undoRoot: folders', () => {
  // before: B, C(D), E      after: A (created), B renamed to B2, C and its child D deleted, E
  const before = root([folder('B', 'B'), folder('C', 'C', [folder('D', 'D')]), folder('E', 'E')]);
  const after = root([folder('A', 'A'), folder('B', 'B2'), folder('E', 'E')]);

  it('create A, rename B, delete C with a child: undo restores all three', () => {
    const { out, conflicts, changed } = run(after, before, after);
    expect(changed).toBe(true);
    expect(conflicts).toEqual([]);
    expect(names(out.folders)).toEqual(['B', ['C', ['D']], 'E']);
  });

  it('A was renamed since: A is still removed (it is ours) but the change is reported', () => {
    const current = structuredClone(after);
    current.folders[0].name = 'A renamed by Sam';
    const { out, conflicts } = run(current, before, after);
    expect(names(out.folders)).toEqual(['B', ['C', ['D']], 'E']);
    expect(conflicts).toEqual([{ id: 'A', field: 'name', reason: 'changed since' }]);
  });

  it('B was renamed again since: B keeps its new name and is reported; the rest is restored', () => {
    const current = structuredClone(after);
    current.folders[1].name = 'B3';
    const { out, conflicts } = run(current, before, after);
    expect(names(out.folders)).toEqual(['B3', ['C', ['D']], 'E']);
    expect(conflicts).toEqual([{ id: 'B', field: 'name', reason: 'changed since' }]);
  });

  it('the folder parent of a deleted subfolder is gone: it returns at the top level', () => {
    const b = root([folder('P', 'P', [folder('K', 'K')]), folder('Z', 'Z')]);
    const a = root([folder('P', 'P'), folder('Z', 'Z')]); // K deleted
    const current = root([folder('Z', 'Z')]); // and P is gone now too
    const { out } = run(current, b, a);
    expect(names(out.folders)).toEqual(['Z', 'K']);
  });

  it('a subfolder someone else added to our new folder is kept, not destroyed', () => {
    const b = root([folder('X', 'X')]);
    const a = root([folder('A', 'A'), folder('X', 'X')]);
    const current = root([folder('A', 'A', [folder('R', 'Sam made this')]), folder('X', 'X')]);
    const { out, conflicts } = run(current, b, a);
    expect(names(out.folders)).toEqual(['Sam made this', 'X']);
    expect(conflicts).toEqual([{ id: 'A', field: 'children', reason: 'changed since' }]);
  });

  it('a folder moved under another one goes back; moved again since is a conflict', () => {
    const b = root([folder('P', 'P', [folder('K', 'K')]), folder('Q', 'Q')]);
    const a = root([folder('P', 'P'), folder('Q', 'Q', [folder('K', 'K')])]);
    expect(names(run(a, b, a).out.folders)).toEqual([['P', ['K']], 'Q']);

    const movedAgain = root([folder('P', 'P', [folder('K', 'K')]), folder('Q', 'Q')]); // K went back to P by itself
    const r = run(movedAgain, b, a);
    expect(r.conflicts).toEqual([{ id: 'K', field: 'parent', reason: 'changed since' }]);
    expect(names(r.out.folders)).toEqual([['P', ['K']], 'Q']);
  });

  it('one group that deletes, moves and reorders (with a folder added since) restores the order', () => {
    // What a debounced root write or two of the partner's edits between polls look like.
    const b = root([
      folder('X', 'X'),
      folder('Y', 'Y'),
      folder('Z', 'Z'),
      folder('D', 'D', [folder('K', 'K')]),
      folder('W', 'W'),
    ]);
    // D deleted, X moved under Y, Z dragged to the top.
    const a = root([folder('Z', 'Z'), folder('Y', 'Y', [folder('X', 'X')]), folder('W', 'W')]);
    const current = structuredClone(a);
    current.folders.unshift(folder('R', 'Sam'));
    const { out, conflicts } = run(current, b, a);
    expect(conflicts).toEqual([]);
    expect(names(out.folders)).toEqual(['Sam', 'X', 'Y', 'Z', ['D', ['K']], 'W']);
  });

  it('a reorder is undone in place, keeping folders the group never touched where they are', () => {
    const b = root([folder('A', 'A'), folder('B', 'B'), folder('C', 'C')]);
    const a = root([folder('C', 'C'), folder('A', 'A'), folder('B', 'B')]); // C dragged to the top
    expect(names(run(a, b, a).out.folders)).toEqual(['A', 'B', 'C']);

    const withNew = root([folder('C', 'C'), folder('N', 'N'), folder('A', 'A'), folder('B', 'B')]);
    expect(names(run(withNew, b, a).out.folders)).toEqual(['A', 'N', 'B', 'C']);

    const shuffled = root([folder('A', 'A'), folder('C', 'C'), folder('B', 'B')]);
    const r = run(shuffled, b, a);
    expect(r.conflicts).toEqual([{ id: 'root', field: 'order', reason: 'changed since' }]);
    expect(names(r.out.folders)).toEqual(['A', 'C', 'B']);
  });

  it('own fields: color and auto-tags come back only where still as the group left them', () => {
    const b = root([folder('A', 'A', [], { iconColor: 'red', tags: ['x'] })]);
    const a = root([folder('A', 'A', [], { iconColor: 'blue', tags: ['x', 'y'] })]);
    const current = root([folder('A', 'A', [], { iconColor: 'blue', tags: ['x', 'y', 'z'] })]);
    const r = run(current, b, a);
    expect(r.out.folders[0]).toMatchObject({ iconColor: 'red', tags: ['x', 'y', 'z'] });
    expect(r.conflicts).toEqual([{ id: 'A', field: 'tags', reason: 'changed since' }]);
  });

  it('a folder deleted since cannot be renamed back, and is reported', () => {
    const b = root([folder('A', 'Old')]);
    const a = root([folder('A', 'New')]);
    const r = run(root([]), b, a);
    expect(r.changed).toBe(false);
    expect(r.conflicts).toEqual([{ id: 'A', field: 'folder', reason: 'no longer exists' }]);
  });

  it('nothing to undo (same folders) changes nothing', () => {
    expect(run(after, after, after).changed).toBe(false);
  });
});

describe('undoRoot: smart folders, tag groups, quick access', () => {
  const smart = (id: string, name: string): Rec => ({
    id,
    name,
    modificationTime: 1,
    conditions: [],
  });
  const group = (id: string, name: string, tags: string[]): Rec => ({
    id,
    name,
    tags,
    color: '#fff',
  });

  it('deleted smart folder and tag group come back at their old place; a created one goes', () => {
    const b = root([], {
      smartFolders: [smart('S1', 'one'), smart('S2', 'two')],
      tagsGroups: [group('G1', 'g', ['a'])],
    });
    const a = root([], {
      smartFolders: [smart('S2', 'two'), smart('S3', 'three')],
      tagsGroups: [],
    });
    const r = run(a, b, a);
    expect(r.out.smartFolders.map((s: Rec) => s.id)).toEqual(['S1', 'S2']);
    expect(r.out.tagsGroups).toEqual([group('G1', 'g', ['a'])]);
    expect(r.conflicts).toEqual([]);
  });

  it('a tag group edited since keeps the newer tags list and reports it', () => {
    const b = root([], { tagsGroups: [group('G', 'g', ['a'])] });
    const a = root([], { tagsGroups: [group('G', 'g', ['a', 'b'])] });
    const current = root([], { tagsGroups: [group('G', 'g', ['a', 'b', 'c'])] });
    const r = run(current, b, a);
    expect(r.out.tagsGroups[0].tags).toEqual(['a', 'b', 'c']);
    expect(r.conflicts).toEqual([{ id: 'G', field: 'tags', reason: 'changed since' }]);
  });

  it('quick access is restored as a whole, only if untouched since', () => {
    const qa = (...ids: string[]) => ids.map((id) => ({ type: 'folder', id }));
    const b = root([], { quickAccess: qa('A') });
    const a = root([], { quickAccess: qa('A', 'B') });
    expect(run(a, b, a).out.quickAccess).toEqual(qa('A'));
    const r = run(root([], { quickAccess: qa('A', 'B', 'C') }), b, a);
    expect(r.out.quickAccess).toEqual(qa('A', 'B', 'C'));
    expect(r.conflicts).toEqual([
      { id: 'quickAccess', field: 'quickAccess', reason: 'changed since' },
    ]);
  });

  it('never touches applicationVersion or the root modificationTime', () => {
    const b = root([folder('A', 'A')], { applicationVersion: '4.0.0' });
    const a = root([], { applicationVersion: '4.0.0', modificationTime: 99 });
    const current = root([], { applicationVersion: '4.0.0', modificationTime: 123 });
    const r = run(current, b, a);
    expect(r.out.modificationTime).toBe(123);
    expect(r.out.applicationVersion).toBe('4.0.0');
  });
});
