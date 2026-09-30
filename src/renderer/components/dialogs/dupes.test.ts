// The duplicate finder's rules: who can be kept, what a merge would do, and the totals.
import { describe, expect, it } from 'vitest';
import type { DuplicateGroup, DuplicateMember } from '../../../shared/types';
import {
  actionableGroups,
  groupsWith,
  keeperOf,
  mergePreview,
  mergeSentence,
  removable,
  summaryLine,
  totals,
} from './dupes';

const member = (id: string, over: Partial<DuplicateMember> = {}): DuplicateMember => ({
  libraryId: 'mine',
  libraryName: 'Mine',
  id,
  name: id,
  ext: 'png',
  size: 1000,
  width: 10,
  height: 10,
  folders: [],
  tags: [],
  star: 0,
  importedAt: 0,
  thumbUrl: '',
  distance: 0,
  ...over,
});
const group = (members: DuplicateMember[], suggestedKeeperId = members[0].id): DuplicateGroup => ({
  key: members.map((m) => m.id).join('+'),
  kind: 'exact',
  members,
  suggestedKeeperId,
});

describe('keeperOf', () => {
  const g = group(
    [member('other', { libraryId: 'theirs', libraryName: 'Theirs' }), member('a'), member('b')],
    'other',
  );

  it('never picks a copy from another library, even when it is the suggestion', () => {
    expect(keeperOf(g, undefined, 'mine')).toBe('a');
  });
  it('honours the user choice only when it can be kept', () => {
    expect(keeperOf(g, 'b', 'mine')).toBe('b');
    expect(keeperOf(g, 'other', 'mine')).toBe('a');
  });
});

describe('a merge', () => {
  const g = group([
    member('a', { folders: ['f1'], tags: ['x'] }),
    member('b', { folders: ['f1', 'f2'], tags: ['x', 'y'], size: 500 }),
    member('c', { libraryId: 'theirs', libraryName: 'Theirs', folders: ['zz'], tags: ['q'] }),
  ]);

  it('trashes only copies in the open library, and leaves other libraries alone', () => {
    expect(removable(g, 'a', 'mine').map((m) => m.id)).toEqual(['b']);
  });
  it('unions folders and tags of the copies that stay in the open library', () => {
    expect(mergePreview(g, 'a', 'mine')).toEqual({ folders: 2, tags: 2, trashed: 1, left: 1 });
  });
  it('says so in plain words', () => {
    const text = mergeSentence(mergePreview(g, 'a', 'mine'));
    expect(text).toBe(
      'Keeps one item in 2 folders with 2 tags; moves 1 copy to the trash. 1 copy in other libraries is left alone.',
    );
  });
});

describe('the list', () => {
  const mine = group([member('a'), member('b')]);
  const onlyElsewhere = group([
    member('x', { libraryId: 'theirs' }),
    member('y', { libraryId: 'theirs' }),
  ]);

  it('drops groups with nothing to do in this library', () => {
    expect(actionableGroups([mine, onlyElsewhere], 'mine')).toEqual([mine]);
  });
  it('limits to the groups that involve the selected items', () => {
    expect(groupsWith([mine, group([member('c'), member('d')])], ['b'], 'mine')).toEqual([mine]);
  });
  it('adds up what a merge of everything would free', () => {
    const t = totals(
      [
        mine,
        group([member('c', { size: 4 * 1024 * 1024 }), member('d', { size: 4 * 1024 * 1024 })]),
      ],
      (g) => g.members[0].id,
      'mine',
    );
    expect(t).toEqual({ groups: 2, extraCopies: 2, bytes: 1000 + 4 * 1024 * 1024 });
    expect(summaryLine(t)).toBe('2 groups, 2 extra copies, 4.00 MB');
  });
});
