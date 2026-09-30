import { describe, expect, it } from 'vitest';
import type { TagGroup, TagInfo } from '../../../shared/types';
import { moveTagToGroup, visibleTags } from './tagManager';

const g = (id: string, tags: string[]): TagGroup => ({
  id,
  name: id,
  tags,
  color: null,
  description: '',
});

describe('moving a tag into a group', () => {
  const groups = [g('one', ['sketch', 'draft']), g('two', ['final'])];

  it('takes it out of its other groups by default (Eagle keeps a tag in one group), adding first', () => {
    const changed = moveTagToGroup(groups, 'sketch', 'two', false);
    expect(changed.map((x) => [x.id, x.tags])).toEqual([
      ['two', ['final', 'sketch']],
      ['one', ['draft']],
    ]);
  });
  it('keeps it in both when Alt is held', () => {
    const changed = moveTagToGroup(groups, 'sketch', 'two', true);
    expect(changed.map((x) => x.id)).toEqual(['two']);
    expect(changed[0].tags).toEqual(['final', 'sketch']);
  });
  it('does nothing when it is already there', () => {
    expect(moveTagToGroup(groups, 'draft', 'one', false)).toEqual([]);
  });
});

describe('the tag list', () => {
  const tags: TagInfo[] = [
    { name: 'Hands', count: 9, groupIds: [] },
    { name: 'cats', count: 2, groupIds: [] },
    { name: 'Color Poetry', count: 46, groupIds: [] },
  ];
  it('sorts A to Z ignoring case, or by use', () => {
    expect(visibleTags(tags, '', 'name').map((t) => t.name)).toEqual([
      'cats',
      'Color Poetry',
      'Hands',
    ]);
    expect(visibleTags(tags, '', 'count').map((t) => t.name)).toEqual([
      'Color Poetry',
      'Hands',
      'cats',
    ]);
  });
  it('searches inside names', () => {
    expect(visibleTags(tags, 'OL', 'name').map((t) => t.name)).toEqual(['Color Poetry']);
  });
});
