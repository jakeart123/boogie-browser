import { describe, expect, it } from 'vitest';
import type { EagleItemRecord, EagleRootRecord } from '../../shared/types';
import {
  addFolders,
  addTags,
  removeFolders,
  removeTags,
  restore,
  setAnnotation,
  setFolders,
  setOrder,
  setStar,
  setTags,
  setUrl,
  trash,
} from './edits';
import {
  addFolder,
  addSmartFolder,
  ancestors,
  autoTagsFor,
  descendantIds,
  findFolder,
  folderPath,
  moveFolder,
  removeFolder,
  removeSmartFolder,
  removeTagFromGroups,
  removeTagGroup,
  renameTagInGroups,
  setQuickAccess,
  updateFolder,
  updateSmartFolder,
  upsertTagGroup,
} from './root';

function tree(): EagleRootRecord {
  const f = (id: string, name: string, tags: string[], children: any[] = []) => ({
    id,
    name,
    description: '',
    children,
    modificationTime: 1,
    tags,
    password: '',
    passwordTips: '',
  });
  return {
    applicationVersion: '4.0.0',
    folders: [
      f(
        'A',
        'Art',
        ['art'],
        [f('A1', 'Faces', ['face', 'art'], [f('A1a', 'Old masters', [])]), f('A2', 'Hands', [])],
      ),
      f('B', 'Bin', []),
    ],
    smartFolders: [],
    quickAccess: [{ type: 'folder', id: 'A1', extra: 'junk' } as any, { type: 'folder', id: 'B' }],
    tagsGroups: [],
    modificationTime: 5,
  } as EagleRootRecord;
}

describe('folder tree helpers', () => {
  it('finds folders, paths, ancestors and descendants', () => {
    const r = tree();
    expect(findFolder(r, 'A1a')!.name).toBe('Old masters');
    expect(findFolder(r, 'nope')).toBeNull();
    expect(folderPath(r, 'A1a').map((f) => f.id)).toEqual(['A', 'A1', 'A1a']);
    expect(ancestors(r, 'A1a').map((f) => f.id)).toEqual(['A', 'A1']);
    expect(descendantIds(r, 'A')).toEqual(['A1', 'A1a', 'A2']); // document order
    expect(descendantIds(r, 'A1', true).sort()).toEqual(['A1', 'A1a']);
  });

  it("auto-tags are the folder's own plus every ancestor's, without repeats", () => {
    const r = tree();
    expect(autoTagsFor(r, 'A1a').sort()).toEqual(['art', 'face']);
    expect(autoTagsFor(r, 'B')).toEqual([]);
    expect(autoTagsFor(r, 'missing')).toEqual([]);
  });

  it("new folder records use Eagle's key order; sub-folders nest; ids are unique", () => {
    const r = tree();
    const id = addFolder(r, { name: 'New/Sub', parentId: 'B' });
    const rec = findFolder(r, id)!;
    expect(Object.keys(rec)).toEqual([
      'id',
      'name',
      'description',
      'children',
      'modificationTime',
      'tags',
      'password',
      'passwordTips',
    ]);
    expect(rec.name).toBe('NewSub');
    expect(findFolder(r, 'B')!.children).toEqual([rec]);
    expect(() => addFolder(r, { name: 'x', parentId: 'nope' })).toThrow();
    expect(() => addFolder(r, { name: 'x', iconColor: 'mauve' as any })).toThrow();
    expect(new Set([id, addFolder(r, { name: 'a' }), addFolder(r, { name: 'b' })]).size).toBe(3);
  });

  it('updateFolder slots new keys where Eagle writes them and writes orderBy with sortIncrease', () => {
    const r = tree();
    expect(
      updateFolder(r, 'A2', {
        iconColor: 'red',
        icon: 'box',
        coverId: 'ITEM1',
        orderBy: 'MANUAL',
        description: 'hi',
        tags: [' x ', 'x', 'y'],
      }),
    ).toBe(true);
    const rec = findFolder(r, 'A2')!;
    expect(Object.keys(rec)).toEqual([
      'id',
      'name',
      'description',
      'children',
      'modificationTime',
      'tags',
      'icon',
      'iconColor',
      'password',
      'passwordTips',
      'coverId',
      'orderBy',
      'sortIncrease',
    ]);
    expect(rec).toMatchObject({
      description: 'hi',
      tags: ['x', 'y'],
      iconColor: 'red',
      icon: 'box',
      coverId: 'ITEM1',
      orderBy: 'MANUAL',
      sortIncrease: true,
      modificationTime: 1,
    });
    expect(updateFolder(r, 'A2', { sortIncrease: false })).toBe(true);
    expect(rec.sortIncrease).toBe(false);
    expect(updateFolder(r, 'A2', { orderBy: 'NAME' })).toBe(true);
    expect(rec.sortIncrease).toBe(false); // an existing direction is kept
    expect(updateFolder(r, 'A2', { name: 'Hands', iconColor: 'red' })).toBe(false); // nothing new
    expect(
      updateFolder(r, 'A2', { iconColor: null, icon: null, coverId: null, orderBy: null }),
    ).toBe(true);
    expect(Object.keys(rec)).toEqual([
      'id',
      'name',
      'description',
      'children',
      'modificationTime',
      'tags',
      'password',
      'passwordTips',
    ]);
    expect(() => updateFolder(r, 'nope', { name: 'x' })).toThrow();
    expect(() => updateFolder(r, 'A2', { orderBy: 'SIDEWAYS' as any })).toThrow();
  });

  it("moves folders, refuses a move into the folder's own subtree, and reports no-ops", () => {
    const r = tree();
    expect(() => moveFolder(r, 'A', 'A1a', 0)).toThrow(/itself/);
    expect(() => moveFolder(r, 'A', 'A', 0)).toThrow();
    expect(moveFolder(r, 'A2', null, 0)).toBe(true);
    expect(r.folders.map((f) => f.id)).toEqual(['A2', 'A', 'B']);
    expect(findFolder(r, 'A')!.children.map((f) => f.id)).toEqual(['A1']);
    expect(moveFolder(r, 'A2', null, 0)).toBe(false);
    expect(moveFolder(r, 'B', 'A', 99)).toBe(true); // index is clamped
    expect(findFolder(r, 'A')!.children.map((f) => f.id)).toEqual(['A1', 'B']);
  });

  it('removes a folder with its subfolders and their quick-access entries', () => {
    const r = tree();
    expect(removeFolder(r, 'A1')).toEqual(['A1', 'A1a']);
    expect(removeFolder(r, 'A1')).toEqual([]);
    expect(findFolder(r, 'A1a')).toBeNull();
    expect(r.quickAccess).toEqual([{ type: 'folder', id: 'B' }]);
  });
});

describe('smart folders, quick access, tag groups', () => {
  it("smart folders keep Eagle's record shape; editing rules refreshes modificationTime, renaming does not", () => {
    const r = tree();
    const cond = [
      {
        rules: [{ property: 'tags', method: 'contain', value: 'x' }],
        match: 'AND' as const,
        boolean: 'TRUE' as const,
      },
    ];
    const id = addSmartFolder(r, {
      name: 'Faces',
      conditions: cond,
      iconColor: 'green',
      now: 1000,
    });
    const sub = addSmartFolder(r, { name: 'Sub', conditions: cond, parentId: id, now: 1000 });
    const rec = r.smartFolders[0];
    expect(Object.keys(rec)).toEqual([
      'id',
      'icon', // Eagle writes both, "" when unset (eagle-proof D.root.smart)
      'iconColor',
      'name',
      'description',
      'modificationTime',
      'conditions',
      'children',
    ]);
    expect(rec.children![0].id).toBe(sub);
    expect(updateSmartFolder(r, id, { name: 'Renamed', icon: 'box', now: 2000 })).toBe(true);
    expect(rec.modificationTime).toBe(1000);
    expect(Object.keys(rec).slice(0, 3)).toEqual(['id', 'icon', 'iconColor']);
    expect(r.smartFolders[0].children![0]).toMatchObject({ icon: '', iconColor: '' });
    expect(updateSmartFolder(r, id, { icon: null, iconColor: null })).toBe(true);
    expect(rec).toMatchObject({ icon: '', iconColor: '' }); // cleared the way Eagle clears them
    expect(updateSmartFolder(r, id, { conditions: [...cond, ...cond], now: 3000 })).toBe(true);
    expect(rec.modificationTime).toBe(3000);
    expect(updateSmartFolder(r, id, { conditions: [...cond, ...cond], now: 4000 })).toBe(false);
    r.quickAccess.push({ type: 'smartFolder', id: sub });
    expect(removeSmartFolder(r, id)).toEqual([id, sub]);
    expect(r.smartFolders).toEqual([]);
    expect(r.quickAccess.some((e) => e.id === sub)).toBe(false);
  });

  it('quick access is cut to {type,id}, deduped by id, and reports no-ops', () => {
    const r = tree();
    expect(
      setQuickAccess(r, [
        { type: 'folder', id: 'B', size: 3 } as any,
        { type: 'smartFolder', id: 'B' },
        { type: 'folder', id: 'A' },
      ]),
    ).toBe(true);
    expect(r.quickAccess).toEqual([
      { type: 'folder', id: 'B' },
      { type: 'folder', id: 'A' },
    ]);
    expect(setQuickAccess(r, [...r.quickAccess])).toBe(false);
  });

  it('tag groups: create, update in place, reorder, rename and remove tags, delete', () => {
    const r = tree();
    const g1 = upsertTagGroup(r, {
      name: 'Moods',
      tags: ['sad', ' happy ', 'sad', 'a\nb'],
      color: 'red',
    });
    const g2 = upsertTagGroup(r, { name: 'Places', tags: ['paris'], description: 'where' }, 0);
    expect(r.tagsGroups.map((g) => g.id)).toEqual([g2, g1]);
    expect(Object.keys(r.tagsGroups[1])).toEqual(['id', 'name', 'tags', 'color']);
    expect(r.tagsGroups[1].tags).toEqual(['sad', 'happy', 'ab']);
    expect(Object.keys(r.tagsGroups[0])).toEqual(['id', 'name', 'tags', 'description']);
    upsertTagGroup(r, { id: g1, name: 'Moods 2', tags: ['sad'], color: null });
    expect(r.tagsGroups[1]).toEqual({ id: g1, name: 'Moods 2', tags: ['sad'] });
    upsertTagGroup(r, { id: g2, name: 'Places', tags: ['paris', 'sad'], description: 'where' }, 1);
    expect(r.tagsGroups.map((g) => g.id)).toEqual([g1, g2]);
    expect(renameTagInGroups(r, 'sad', 'blue')).toBe(true);
    expect(r.tagsGroups.map((g) => g.tags)).toEqual([['blue'], ['paris', 'blue']]);
    expect(renameTagInGroups(r, 'nothing', 'x')).toBe(false);
    expect(removeTagFromGroups(r, 'blue')).toBe(true);
    expect(r.tagsGroups.map((g) => g.tags)).toEqual([[], ['paris']]);
    expect(removeTagGroup(r, g1)).toBe(true);
    expect(removeTagGroup(r, g1)).toBe(false);
  });
});

describe('item edit helpers', () => {
  const rec = (over: Partial<EagleItemRecord> = {}): EagleItemRecord =>
    ({
      id: 'X',
      name: 'n',
      size: 1,
      btime: 1,
      mtime: 1,
      ext: 'jpg',
      tags: ['a', 'b'],
      folders: ['F1'],
      isDeleted: false,
      url: '',
      annotation: '',
      modificationTime: 1,
      ...over,
    }) as EagleItemRecord;

  it('tags: trim, cap at 1024, de-dup, append at the end, keep the existing order', () => {
    const r = rec();
    expect(addTags(r, [' c ', 'a', 'c', '', 'd'.repeat(2000)])).toBe(true);
    expect(r.tags).toEqual(['a', 'b', 'c', 'd'.repeat(1024)]);
    expect(addTags(r, ['a', 'c'])).toBe(false);
    expect(removeTags(r, ['b', 'zzz'])).toBe(true);
    expect(r.tags).toEqual(['a', 'c', 'd'.repeat(1024)]);
    expect(setTags(r, ['new', 'c', 'a'])).toBe(true);
    expect(r.tags).toEqual(['a', 'c', 'new']); // survivors keep their order, new ones at the end
    expect(setTags(r, ['c', 'a', 'new'])).toBe(false); // same set: no rewrite
  });

  it('folders: add appends and brings the auto-tags only when a folder was really added', () => {
    const r = rec();
    expect(addFolders(r, ['F1'], ['auto'])).toBe(false);
    expect(r.tags).toEqual(['a', 'b']);
    expect(addFolders(r, ['F1', 'F2'], ['auto', 'a'])).toBe(true);
    expect(r.folders).toEqual(['F1', 'F2']);
    expect(r.tags).toEqual(['a', 'b', 'auto']);
    expect(removeFolders(r, ['F1'])).toBe(true);
    expect(setFolders(r, ['F3', 'F2'], ['t3'])).toBe(true);
    expect(r.folders).toEqual(['F2', 'F3']);
    expect(r.tags).toContain('t3');
    expect(setFolders(r, [])).toBe(true);
    expect(r.folders).toEqual([]);
  });

  it('star, trash and restore follow Eagle, and nothing else is deleted', () => {
    const r = rec({ order: { F1: '5' } });
    expect(setStar(r, 5)).toBe(true);
    expect(setStar(r, 5)).toBe(false);
    expect(setStar(r, 9)).toBe(true); // out of range means "no rating", as in Eagle's unrate
    expect('star' in r).toBe(false);
    expect(setStar(r, 0)).toBe(false);
    expect(trash(r, 123)).toBe(true);
    expect(r).toMatchObject({ isDeleted: true, deletedTime: 123, folders: ['F1'] });
    expect(restore(r)).toBe(true);
    expect('deletedTime' in r).toBe(false);
    expect(restore(r)).toBe(false);
    expect(r.order).toEqual({ F1: '5' });
  });

  it('note, url (cut to 2000) and manual order', () => {
    const r = rec();
    expect(setAnnotation(r, 'line1\nline2')).toBe(true);
    expect(setAnnotation(r, 'line1\nline2')).toBe(false);
    setUrl(r, 'u'.repeat(3000));
    expect(r.url).toHaveLength(2000);
    expect(setOrder(r, 'F1', '10.5')).toBe(true);
    expect(setOrder(r, 'F2', '11')).toBe(true);
    expect(r.order).toEqual({ F1: '10.5', F2: '11' });
    expect(setOrder(r, 'F1', '10.5')).toBe(false);
  });
});
