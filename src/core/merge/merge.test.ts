import { describe, expect, it } from 'vitest';
import type { EagleRootRecord } from '../../shared/types';
import {
  mergeItem,
  mergeRoot,
  mergeTags,
  pickBases,
  questionsOf,
  redundant,
  SLACK_MS,
  summarize,
  takeAnswers,
  takeCertain,
  type Diff,
  type Rec,
} from './index';

const FOLDERS: Record<string, string> = { F1: 'Hands', F2: 'Feet' };
const ctx = (auto = true) => ({ folderName: (id: string) => FOLDERS[id], auto });

/** An item as Eagle saves it. `extra` wins; `at` is its lastModified. */
const item = (extra: Rec = {}, at = 1000): Rec => ({
  id: 'A',
  name: 'Portrait study',
  size: 100,
  btime: at,
  mtime: at,
  ext: 'jpg',
  tags: [],
  folders: [],
  isDeleted: false,
  url: '',
  annotation: '',
  modificationTime: 5,
  width: 10,
  height: 10,
  lastModified: at,
  palettes: [{ color: [1, 2, 3], ratio: 50 }],
  ...extra,
});

const ids = (d: Diff<Rec>[]) => d.map((x) => `${x.id}:${x.verdict}`);

describe('copies that hold nothing new', () => {
  it('an item that differs only in noise fields is redundant, and has no differences', () => {
    const live = item({ name: 'x' }, 1000);
    const copy = item(
      { name: 'x', palettes: [{ color: [9, 9, 9], ratio: 1, $$hashKey: 'o:1' }] },
      5000,
    );
    copy.processingPalette = true;
    expect(redundant(live, copy)).toBe(true);
    expect(mergeItem(live, copy, [], ctx())).toEqual([]);
  });

  it('what is derived from the picture is never a question: the library keeps its own', () => {
    const copy = item({ size: 999, width: 1, height: 1, ext: 'png', noThumbnail: true });
    expect(mergeItem(item(), copy, [], ctx())).toEqual([]);
  });

  it('an older snapshot, with the history that shows it is older, has nothing to apply or ask', () => {
    const T = 1_790_000_000_000; // when the partner saved the copy
    const min = 60_000;
    const fresh = item(); // as imported
    const live = item({
      name: 'Study of hands',
      annotation: 'Date: 1876',
      tags: ['hands'],
      folders: ['F1'],
    });
    const copy = item({}, T); // the partner's save of the item as imported, before any of the edits
    const versions = [
      { at: T + 10 * min, text: JSON.stringify(live) }, // the edits came after the copy was saved
      { at: T - 60 * min, text: JSON.stringify(fresh) },
    ];
    const diffs = mergeItem(live, copy, pickBases(versions, T), ctx());
    expect(ids(diffs).sort()).toEqual([
      'annotation:live',
      'folder:F1:live',
      'name:live',
      'tag:hands:live',
    ]);
    expect(takeCertain(diffs, structuredClone(live))).toBe(false);
    expect(questionsOf(diffs)).toEqual([]);
  });
});

describe('the three-way decision', () => {
  const v1 = item();
  const v2 = item({ tags: ['x'] }); // we tagged it

  it("takes the partner's rename, but asks about the tag their old copy lacks", () => {
    const live = v2;
    const copy = item({ name: 'Renamed' }, 4000); // saved from v1: no tag x
    const diffs = mergeItem(live, copy, [v2, v1], ctx());
    expect(ids(diffs)).toEqual(['name:copy', 'tag:x:ask']);
    const target = structuredClone(live);
    expect(
      takeCertain(
        diffs.filter((d) => d.id !== 'tag:x'),
        target,
      ),
    ).toBe(true);
    expect(target).toMatchObject({ name: 'Renamed', tags: ['x'] });
    expect(questionsOf(diffs)).toMatchObject([
      { id: 'tag:x', label: 'Tag “x”', live: 'x', copy: '(none)' },
    ]);
    // Answering "take the copy's" removes the tag; nothing else changes.
    expect(takeAnswers(diffs, target, new Set(['tag:x']))).toBe(true);
    expect(target.tags).toEqual([]);
  });

  it('an old copy saved from a version we have is never taken: the library is left alone', () => {
    const v3 = item({ tags: ['x'], annotation: 'my note' });
    const copy = item({}, 4000); // a stale save of v1
    const diffs = mergeItem(v3, copy, [v2, v1], ctx());
    expect(ids(diffs)).toEqual(['annotation:live', 'tag:x:ask']);
    expect(takeCertain(diffs, structuredClone(v3))).toBe(false);
  });

  it('a version recorded after the copy was made is never a base', () => {
    const older = item({ name: 'Old name' });
    const live = item({ name: 'New name' }); // we renamed it after the partner saved
    const copy = item({ name: 'Old name' }, 2000);
    const versions = [
      { at: 2000 + SLACK_MS + 1, text: JSON.stringify(live) },
      { at: 2000 + SLACK_MS, text: JSON.stringify(older) },
    ];
    const bases = pickBases(versions, 2000);
    expect(bases).toHaveLength(1);
    // Against the right bases our rename stands; with our own later version as a base it would be undone.
    expect(ids(mergeItem(live, copy, bases, ctx()))).toEqual(['name:live']);
    expect(ids(mergeItem(live, copy, [live], ctx()))).toEqual(['name:copy']);
    // No usable time, no versions: no bases at all.
    expect(pickBases(versions, null)).toEqual([]);
    expect(pickBases([{ at: 1, text: 'not json' }], 2000)).toEqual([]);
  });

  it('both changed the name differently: a question, and the library keeps its name', () => {
    const live = item({ name: 'Mine' });
    const copy = item({ name: 'Theirs' }, 4000);
    const diffs = mergeItem(live, copy, [item({ name: 'Original' })], ctx());
    expect(diffs).toMatchObject([{ id: 'name', verdict: 'ask', live: 'Mine', copy: 'Theirs' }]);
  });

  it('without any history every difference is a question', () => {
    const live = item({ name: 'Mine', tags: ['a'], star: 3, folders: ['F1'] });
    const copy = item({ name: 'Theirs', tags: ['b'], folders: ['F2'] }, 4000);
    const diffs = mergeItem(live, copy, [], ctx());
    expect(ids(diffs).sort()).toEqual(
      ['name:ask', 'star:ask', 'tag:a:ask', 'tag:b:ask', 'folder:F1:ask', 'folder:F2:ask'].sort(),
    );
    expect(takeCertain(diffs, structuredClone(live))).toBe(false);
  });

  it('with ask-only mode a certain change waits for a person too', () => {
    const live = item();
    const copy = item({ name: 'Renamed' }, 4000);
    expect(ids(mergeItem(live, copy, [live], ctx(true)))).toEqual(['name:copy']);
    expect(ids(mergeItem(live, copy, [live], ctx(false)))).toEqual(['name:ask']);
  });

  it('manual positions stay exactly the strings they are, and trash moves as one unit', () => {
    const live = item({ folders: ['F1'], order: { F1: '1700000000000' } });
    const copy = item(
      { folders: ['F1'], order: { F1: '0001700000000999' }, isDeleted: true, deletedTime: 77 },
      4000,
    );
    const diffs = mergeItem(live, copy, [], ctx());
    const target = structuredClone(live);
    takeAnswers(diffs, target, new Set(['order:F1', 'trash']));
    expect(target.order).toEqual({ F1: '0001700000000999' });
    expect(JSON.stringify(target.order)).toBe('{"F1":"0001700000000999"}');
    expect(target).toMatchObject({ isDeleted: true, deletedTime: 77 });
  });

  it('a folder the library no longer has is never put back on an item', () => {
    const live = item({ folders: ['F1'] });
    const copy = item({ folders: ['F1', 'GONE'] }, 4000);
    expect(mergeItem(live, copy, [], ctx())).toEqual([]);
  });

  it('summarizes what was taken in plain words, and says removed for what the copy lacks', () => {
    const live = item({ tags: ['old'], annotation: 'a note', star: 3 });
    const copy = item({ name: 'N', tags: ['x', 'y'] }, 4000);
    const diffs = mergeItem(live, copy, [live], ctx());
    expect(summarize(diffs)).toBe(
      'took the name and 2 tags and removed the notes, the rating and 1 tag',
    );
    expect(summarize(diffs.filter((d) => d.id === 'tag:old'))).toBe('removed 1 tag');
  });

  it('a question carries a whole note, not its first hundred characters', () => {
    const note = 'word '.repeat(300).trim();
    const [q] = mergeItem(item(), item({ annotation: note }, 4000), [], ctx());
    expect(q.copy).toBe(note);
  });
});

// ───────────────────────── root ─────────────────────────

const folder = (id: string, name: string, extra: Rec = {}, children: unknown[] = []) => ({
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
const root = (folders: unknown[], extra: Rec = {}): EagleRootRecord =>
  ({
    folders,
    smartFolders: [],
    quickAccess: [],
    tagsGroups: [],
    modificationTime: 1,
    applicationVersion: '4.0.0',
    ...extra,
  }) as unknown as EagleRootRecord;
const names = (r: EagleRootRecord) => r.folders.map((f) => `${f.id}=${f.name}`);

describe('the root metadata.json', () => {
  const r0 = root([folder('F1', 'Hands')]);

  it("takes a rename and a new folder from the copy, keeps the library's new folder, asks nothing", () => {
    const live = root([folder('F1', 'Hands'), folder('F2', 'Feet')]);
    const copy = root([
      folder('F1', 'Hand studies', { modificationTime: 99 }),
      folder('F3', 'Faces'),
    ]);
    const diffs = mergeRoot(live, copy, [r0], { auto: true });
    expect(diffs.map((d) => `${d.id}:${d.verdict}`)).toEqual(['F3:copy', 'F1:copy', 'F2:live']);
    const target = structuredClone(live);
    expect(takeCertain(diffs, target)).toBe(true);
    expect(names(target)).toEqual(['F1=Hand studies', 'F3=Faces', 'F2=Feet']); // Faces where the copy has it
    expect(questionsOf(diffs)).toEqual([]);
  });

  it('with no history every folder difference is a question, and taking one folder away is never automatic', () => {
    const live = root([folder('F1', 'Hands'), folder('F2', 'Feet')]);
    const copy = root([folder('F1', 'Hand studies'), folder('F3', 'Faces')]);
    const diffs = mergeRoot(live, copy, [], { auto: true });
    expect(questionsOf(diffs).map((d) => d.id)).toEqual(['F3', 'F1', 'F2']);
    expect(questionsOf(diffs)[1]).toMatchObject({
      label: 'Folder “Hands”',
      live: '“Hands”',
      copy: '“Hand studies”',
    });
    expect(takeCertain(diffs, structuredClone(live))).toBe(false);
    // The partner really did delete it (every base has it): still a question, never done by itself.
    const gone = mergeRoot(live, root([folder('F1', 'Hands')]), [live], { auto: true });
    expect(gone.map((d) => `${d.id}:${d.verdict}`)).toEqual(['F2:ask']);
  });

  it('a folder we deleted stays deleted, unless the copy made a new subfolder in it since', () => {
    const base = root([folder('F1', 'Hands'), folder('F2', 'Feet')]);
    const live = root([folder('F1', 'Hands')]);
    const verdicts = (copy: EagleRootRecord) =>
      mergeRoot(live, copy, [base], { auto: true }).map((d) => `${d.id}:${d.verdict}`);
    expect(verdicts(base)).toEqual(['F2:live']);
    const withNew = root([folder('F1', 'Hands'), folder('F2', 'Feet', {}, [folder('F9', 'Toes')])]);
    expect(verdicts(withNew)).toEqual(['F2:ask']);
  });

  it('takes only the parts that are certain: their rename, not a colour we changed since', () => {
    const live = root([folder('F1', 'Hands', { iconColor: 'blue' })]);
    const copy = root([folder('F1', 'Hand studies')]);
    const diffs = mergeRoot(live, copy, [r0], { auto: true });
    expect(diffs.map((d) => `${d.id}:${d.verdict}`)).toEqual(['F1:copy', 'F1:live']);
    const target = structuredClone(live);
    takeCertain(diffs, target);
    expect(target.folders[0]).toMatchObject({ name: 'Hand studies', iconColor: 'blue' });
  });

  it("a base from before the folder existed can't say who renamed it", () => {
    const before = root([]);
    const live = root([folder('F1', 'Hands')]);
    const copy = root([folder('F1', 'Hand studies')]);
    const verdicts = (bases: EagleRootRecord[]) =>
      mergeRoot(live, copy, bases, { auto: true }).map((d) => `${d.id}:${d.verdict}`);
    expect(verdicts([live, before])).toEqual(['F1:copy']);
    expect(verdicts([before])).toEqual(['F1:ask']); // no base that knows the folder: nothing is certain
  });

  it('two folders with one name are told apart by how many items they hold', () => {
    const live = root([folder('F1', 'Hands'), folder('F2', 'Hands'), folder('F3', 'Feet')]);
    const copy = root([folder('F1', 'Hands', { iconColor: 'red' })]);
    const itemCount = (id: string) => ({ F1: 41, F2: 0, F3: 7 })[id];
    const diffs = mergeRoot(live, copy, [], { auto: true, itemCount });
    expect(diffs.map((d) => d.label)).toEqual([
      'Folder “Hands” (41 items)',
      'Folder “Hands” (no items)',
      'Folder “Feet”',
    ]);
    // Taking a folder away is said as that in the merge's label.
    expect(summarize(diffs)).toBe('took 1 change and removed 2 folders');
  });

  it('a copy that is the library apart from modification times has no differences', () => {
    const live = root([folder('F1', 'Hands')]);
    const copy = root([folder('F1', 'Hands', { modificationTime: 12345 })], {
      modificationTime: 9,
    });
    expect(redundant(live, copy)).toBe(true);
    expect(mergeRoot(live, copy, [], { auto: true })).toEqual([]);
  });
});

describe('tags.json', () => {
  it('takes what is certain, and keeps the library recent tags without asking about each one', () => {
    const live = { historyTags: ['a'], starredTags: ['s1'] };
    const copy = { historyTags: ['b'], starredTags: ['s1', 's2'] };
    const diffs = mergeTags(live, copy, [{ historyTags: [], starredTags: ['s1'] }], { auto: true });
    expect(diffs.map((d) => `${d.id}:${d.verdict}`)).toEqual([
      'starred:s2:copy',
      'recent:a:live',
      'recent:b:copy',
    ]);
    const target = structuredClone(live);
    takeCertain(diffs, target);
    expect(target).toEqual({ historyTags: ['b', 'a'], starredTags: ['s2', 's1'] });
    // No history: a starred tag is a question, recent tags just stay.
    expect(questionsOf(mergeTags(live, copy, [], { auto: true })).map((d) => d.id)).toEqual([
      'starred:s2',
    ]);
    // A copy without a list says nothing about it: its tags are never taken off.
    expect(mergeTags(live, {}, [live], { auto: true })).toEqual([]);
  });
});
