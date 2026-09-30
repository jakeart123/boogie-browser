// Round 4 features on the REAL core (adapter, index, journal, media, watcher) against copies of
// the sample library under .tmp/service-features/: starred tags, saved filters, tag rename and
// delete reaching folders and tags.json, a Dropbox conflicted root copy, "Add to other library",
// custom thumbnails, Boogie's own thumbnails for icon-only types, pausing agents, and keeping the
// write-safety settings out of agents' reach.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EagleRootRecord, ImportResult } from '../../shared/types';
import { CLIENT_ACTOR, EXTENSION_ACTOR } from '../http/context';
import { writeZip } from '../media/testFixtures';
import { protectedWritesAllowed } from '../safety/writeGuard';
import { openSandbox, sandboxAvailable, type Sandbox } from './testSandbox';

let sb: Sandbox | null = null;
afterEach(async () => {
  await sb?.close();
  sb = null;
});
const open = async (opts: Parameters<typeof openSandbox>[0] = {}) =>
  (sb = await openSandbox({ area: 'service-features', ...opts }));

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const state = async (s: Sandbox) => (await s.host.api.getLibraryState())!;

/** A small Krita file: a zip whose flattened picture is mergedimage.png. */
function kra(dir: string, name = 'paint.kra'): string {
  const png = join(dir, 'merged.png');
  execFileSync('vips', ['black', png, '300', '200']);
  return writeZip(join(dir, name), [
    { name: 'mimetype', data: Buffer.from('application/x-krita') },
    { name: 'mergedimage.png', data: readFileSync(png) },
  ]);
}

describe.skipIf(!sandboxAvailable)('tags.json: starred and recent tags', () => {
  it('reads the recent list, stars tags at the front, and warns in a shared library', async () => {
    const s = await open({ shared: true, partner: 'Sam' });
    const tagsPath = join(s.libPath, 'tags.json');
    await s.waitFor(() =>
      s.events.some((e) => e.name === 'library' && 'recentTags' in (e.payload as object)),
    );
    expect(await state(s)).toMatchObject({ recentTags: ['Atelier Gerome'], starredTags: [] });

    // Tag edits don't touch tags.json (no churn for Dropbox).
    const before = readFileSync(tagsPath, 'utf8');
    await s.host.api.updateItems([s.itemIds[0]], { addTags: ['hands'] });
    expect(readFileSync(tagsPath, 'utf8')).toBe(before);

    const r = await s.host.api.setTagStarred(['hands', 'feet'], true);
    expect(r.changed).toBe(1);
    expect(r.warning).toMatch(/Sam's computer/);
    expect(json(tagsPath)).toEqual({
      historyTags: ['Atelier Gerome'],
      starredTags: ['hands', 'feet'],
    });
    expect((await state(s)).starredTags).toEqual(['hands', 'feet']);
    await s.host.api.setTagStarred(['feet'], false);
    expect((await state(s)).starredTags).toEqual(['hands']);
    expect((await s.host.api.setTagStarred(['hands'], true)).changed).toBe(0);
    const [last] = await s.host.api.listHistory();
    expect(last).toMatchObject({ label: 'Unstarred tag “feet”', undoable: true });
  });

  it('renaming or deleting a tag reaches folder auto-tags, smart-folder rules and tags.json, in one entry', async () => {
    const s = await open();
    const { api } = s.host;
    const tag = 'Atelier Gerome'; // in tags.json's recent list
    const [a] = s.itemIds;
    await api.updateItems([a], { addTags: [tag] });
    const { id: folder } = await api.createFolder('Class', null);
    await api.updateFolder(folder, { tags: [tag, 'class'] });
    const smart = await api.createSmartFolder('Gerome', [
      { rules: [{ property: 'tags', method: 'union', value: [tag, 'Gerome'] }], match: 'AND' },
    ]);
    await api.setTagStarred([tag], true);
    const entries = (await api.listHistory()).length;

    await api.renameTag(tag, 'Gerome');
    const root = json(join(s.libPath, 'metadata.json')) as EagleRootRecord;
    expect(root.folders.find((f) => f.id === folder)?.tags).toEqual(['Gerome', 'class']);
    expect(root.smartFolders.find((f) => f.id === smart.id)?.conditions[0].rules[0].value).toEqual([
      'Gerome',
    ]);
    expect(json(join(s.libPath, 'tags.json'))).toEqual({
      historyTags: ['Gerome'],
      starredTags: ['Gerome'],
    });
    expect(s.read(a).tags).toContain('Gerome');
    const history = await api.listHistory();
    expect(history).toHaveLength(entries + 1);
    expect(history[0].label).toBe(`Renamed tag “${tag}” to “Gerome”`);

    // Filing an item there now gives the new tag, never the old one back.
    const [, b] = s.itemIds;
    await api.updateItems([b], { addFolders: [folder] });
    expect(s.read(b).tags).toEqual(expect.arrayContaining(['Gerome', 'class']));
    expect(s.read(b).tags).not.toContain(tag);

    await api.deleteTag('Gerome');
    const after = json(join(s.libPath, 'metadata.json')) as EagleRootRecord;
    expect(after.folders.find((f) => f.id === folder)?.tags).toEqual(['class']);
    expect(json(join(s.libPath, 'tags.json')).starredTags).toEqual([]);
    expect((await state(s)).starredTags).toEqual([]);
    // Undo puts the items' tag and the folder's auto-tag back.
    await api.undo();
    expect(s.read(a).tags).toContain('Gerome');
    expect(
      json(join(s.libPath, 'metadata.json')).folders.find((f: { id: string }) => f.id === folder)
        .tags,
    ).toEqual(['Gerome', 'class']);
  });
});

describe.skipIf(!sandboxAvailable)('tags.json half-synced', () => {
  it("a rename that happened isn't reported as an error when tags.json can't be read", async () => {
    const s = await open();
    const { api } = s.host;
    const [a] = s.itemIds;
    await api.updateItems([a!], { addTags: ['cow'] });
    writeFileSync(join(s.libPath, 'tags.json'), '{"historyTags":["co'); // Dropbox mid-sync
    const r = await api.renameTag('cow', 'cattle');
    expect(r.warning).toMatch(/tag lists \(tags.json\) couldn't be updated/);
    expect(s.read(a!).tags).toContain('cattle');
    expect(readFileSync(join(s.libPath, 'tags.json'), 'utf8')).toBe('{"historyTags":["co');
  });
});

describe.skipIf(!sandboxAvailable)('folders and tag groups', () => {
  it('sorts one level A to Z like Eagle, in one undoable entry', async () => {
    const s = await open();
    const { api } = s.host;
    const { id: p } = await api.createFolder('Parent', null);
    for (const name of ['b', 'A10', 'a2', 'C']) await api.createFolder(name, p);
    const names = async () =>
      (await state(s)).folders.find((f) => f.id === p)!.children.map((c) => c.name);
    const r = await api.sortFolders(p);
    expect(await names()).toEqual(['a2', 'A10', 'b', 'C']);
    expect((await api.listHistory())[0]).toMatchObject({
      groupId: r.groupId,
      label: 'Sorted the folders in “Parent” A to Z',
      undoable: true,
    });
    expect((await api.sortFolders(p)).changed).toBe(0); // already in order: no write
    await api.undo(r.groupId!);
    expect(await names()).toEqual(['b', 'A10', 'a2', 'C']);
  });

  it('clears a tag group color, and colors a new smart folder in one entry', async () => {
    const s = await open();
    const { api } = s.host;
    await api.upsertTagGroup({ name: 'Painters', tags: ['a'], color: 'red' });
    const id = (await state(s)).tagGroups[0]!.id;
    const group = () => json(join(s.libPath, 'metadata.json')).tagsGroups[0];
    await api.upsertTagGroup({ id, name: 'Painters', tags: ['a'] });
    expect(group().color).toBe('red'); // not given: kept
    await api.upsertTagGroup({ id, name: 'Painters', tags: ['a'], color: '' });
    expect(group()).not.toHaveProperty('color');
    await api.upsertTagGroup({ id, name: 'Painters', tags: ['a'], color: 'blue' });
    await api.upsertTagGroup({ id, name: 'Painters', tags: ['a'], color: null });
    expect(group()).not.toHaveProperty('color');

    const before = (await api.listHistory()).length;
    const smart = await api.createSmartFolder('Blue ones', [], null, { iconColor: 'blue' });
    expect((await api.listHistory()).length).toBe(before + 1);
    expect(
      json(join(s.libPath, 'metadata.json')).smartFolders.find(
        (f: { id: string }) => f.id === smart.id,
      ).iconColor,
    ).toBe('blue');
  });
});

describe.skipIf(!sandboxAvailable)('saved filters', () => {
  it('saves, renames, reorders and deletes by position after a name check', async () => {
    const s = await open();
    const { api } = s.host;
    const file = join(s.libPath, 'saved-filters.json');
    await api.saveFilter('Five stars', { rating: [5] });
    await api.saveFilter('Big', { width: { min: 1000 } });
    const saved = json(file);
    expect(saved.map((f: { name: string }) => f.name)).toEqual(['Five stars', 'Big']);
    expect(Object.keys(saved[0].rule)).toContain('shape'); // whole sub-objects for Eagle's shallow merge
    expect((await state(s)).savedFilters).toEqual([
      {
        index: 0,
        name: 'Five stars',
        filter: { rating: [5] },
        unsupported: [],
        key: expect.any(String),
      },
      {
        index: 1,
        name: 'Big',
        filter: { width: { min: 1000 } },
        unsupported: [],
        key: expect.any(String),
      },
    ]);

    await expect(api.updateSavedFilter(0, 'Big', { name: 'x' })).rejects.toThrow(/changed on disk/);
    await api.updateSavedFilter(1, 'Big', { name: 'Wide' });
    await api.moveSavedFilter(1, 0);
    expect(json(file).map((f: { name: string }) => f.name)).toEqual(['Wide', 'Five stars']);
    expect(json(file)[0].rule).toEqual(saved[1].rule); // a rename leaves the rule alone
    await api.deleteSavedFilter(1, 'Five stars');
    expect((await state(s)).savedFilters?.map((f) => f.name)).toEqual(['Wide']);
    expect((await api.listHistory()).slice(0, 4).map((h) => h.label)).toEqual([
      'Deleted saved filter “Five stars”',
      'Moved saved filter “Wide”',
      'Renamed saved filter “Big” to “Wide”',
      'Saved filter “Big”',
    ]);
  });

  it('finds the entry by its fingerprint after Eagle reorders or removes entries', async () => {
    const s = await open();
    const { api } = s.host;
    const file = join(s.libPath, 'saved-filters.json');
    await api.saveFilter('Red', { rating: [5] });
    await api.saveFilter('Red', { rating: [1] });
    await api.saveFilter('Blue', { rating: [2] });
    const [red5, red1, blue] = (await state(s)).savedFilters!;
    // The partner's Eagle puts the second "Red" first before you delete it: the other "Red" stays.
    const list = json(file);
    writeFileSync(file, JSON.stringify([list[1], list[0], list[2]]));
    await api.deleteSavedFilter(red1!.index, red1!.name, red1!.key);
    expect(
      json(file).map((e: { rule: { rating: Record<string, boolean> } }) => e.rule.rating['5']),
    ).toEqual([true, false]);
    // The partner removed the first one before you drag "Blue" to the top: Blue moves, nothing else.
    writeFileSync(file, JSON.stringify([json(file)[1]]));
    await api.moveSavedFilter(blue!.index, 0, blue!.name, blue!.key);
    expect(json(file).map((e: { name: string }) => e.name)).toEqual(['Blue']);
    // An entry Eagle edited meanwhile is not the one you saw.
    await expect(
      api.updateSavedFilter(red5!.index, 'Red', { name: 'x' }, red5!.key),
    ).rejects.toThrow(/changed on disk/);
  });

  it('warns when a saved filter means something else in Eagle', async () => {
    const s = await open();
    const r = await s.host.api.saveFilter('Mix', {
      tags: { mode: 'any', include: ['a'], exclude: ['b'] },
    });
    expect(r.warning).toMatch(/included tag OR without the excluded/);
    expect((await s.host.api.saveFilter('Plain', { rating: [5] })).warning).toBeUndefined();
  });

  it("picks up Eagle's edits to the file, and keeps its Eagle-only parts when edited here", async () => {
    const s = await open();
    const { api } = s.host;
    const file = join(s.libPath, 'saved-filters.json');
    writeFileSync(
      file,
      JSON.stringify([
        { name: 'From Eagle', rule: { camera: { X100V: true }, rating: { '4': true } } },
      ]),
    );
    await s.waitFor(() => {
      void api.refresh();
      return s.events.some(
        (e) =>
          e.name === 'library' &&
          (e.payload as { savedFilters?: unknown[] }).savedFilters?.length === 1,
      );
    }, 10_000);
    expect((await state(s)).savedFilters?.[0]).toMatchObject({
      name: 'From Eagle',
      filter: { rating: [4] },
      unsupported: ['Camera'],
    });
    await api.updateSavedFilter(0, 'From Eagle', { filter: { rating: [1, 2] } });
    const [entry] = json(file);
    expect(entry.rule.camera).toEqual({ X100V: true });
    expect(entry.rule.rating).toMatchObject({ '1': true, '2': true, '4': false });
  });
});

describe.skipIf(!sandboxAvailable)('a Dropbox conflicted copy of the root', () => {
  it('lists folder differences by id and applies only the picked ones, never touching the copy', async () => {
    const s = await open();
    const { api } = s.host;
    const { id: keep } = await api.createFolder('Hands', null);
    const { id: gone } = await api.createFolder('Old stuff', null);
    const [a] = s.itemIds;
    await api.updateItems([a], { addFolders: [gone] });

    // The partner's copy: Hands renamed and blue, "Old stuff" deleted, a new folder with a subfolder.
    const root = json(join(s.libPath, 'metadata.json')) as EagleRootRecord;
    const copy = structuredClone(root);
    const hands = copy.folders.find((f) => f.id === keep)!;
    hands.name = 'Hand studies';
    hands.iconColor = 'blue';
    copy.folders = copy.folders.filter((f) => f.id !== gone);
    const sub = { ...hands, id: 'MNEWSUB000001', name: 'Fingers', children: [] };
    copy.folders.push({
      ...hands,
      id: 'MNEWFOLDER001',
      name: 'Feet',
      iconColor: undefined,
      children: [sub],
    } as never);
    const rel = "metadata (Sam Lee's conflicted copy 2026-05-25).json";
    const copyPath = join(s.libPath, rel);
    writeFileSync(copyPath, JSON.stringify(copy));
    const copyBytes = readFileSync(copyPath, 'utf8');

    const plan = await api.planRootConflict(rel);
    expect(plan.changes).toEqual([
      {
        id: keep,
        kind: 'folder',
        change: 'renamed',
        label: "Folder “Hands” is called “Hand studies”, colored blue in Sam Lee's copy",
      },
      {
        id: 'MNEWFOLDER001',
        kind: 'folder',
        change: 'onlyInCopy',
        label: "Folder “Feet” (with 1 inside) is only in Sam Lee's copy",
      },
      {
        id: gone,
        kind: 'folder',
        change: 'deletedInCopy',
        label: "Folder “Old stuff” is not in Sam Lee's copy",
      },
    ]);

    const r = await api.applyRootConflict(rel, [keep, 'MNEWFOLDER001']);
    expect(r.changed).toBe(2);
    const live = (await state(s)).folders;
    expect(live.find((f) => f.id === keep)).toMatchObject({
      name: 'Hand studies',
      iconColor: 'blue',
    });
    expect(live.find((f) => f.id === 'MNEWFOLDER001')?.children.map((c) => c.name)).toEqual([
      'Fingers',
    ]);
    expect(live.some((f) => f.id === gone)).toBe(true); // not picked
    expect((await api.listHistory())[0].label).toBe("Merged 2 changes from Sam Lee's copy");

    await api.applyRootConflict(rel, [gone]);
    expect((await state(s)).folders.some((f) => f.id === gone)).toBe(false);
    expect(s.read(a).folders).not.toContain(gone); // off its items first, like a folder delete
    expect(readFileSync(copyPath, 'utf8')).toBe(copyBytes);
    expect((await api.planRootConflict(rel)).changes).toEqual([]);
    await expect(api.planRootConflict('../metadata.json')).rejects.toThrow(
      /isn't a conflicted copy/,
    );
  });

  it('a folder the copy deleted keeps the subfolders the copy still has, and their items', async () => {
    const s = await open();
    const { api } = s.host;
    // Live: X { Y { Z }, W }. Copy: the partner moved Y (with Z) out of X, then deleted X (and W).
    const { id: x } = await api.createFolder('X', null);
    const { id: y } = await api.createFolder('Y', x);
    const { id: z } = await api.createFolder('Z', y);
    const { id: w } = await api.createFolder('W', x);
    const [a, b] = s.itemIds;
    await api.updateItems([a!], { addFolders: [z] });
    await api.updateItems([b!], { addFolders: [w] });
    const copy = json(join(s.libPath, 'metadata.json')) as EagleRootRecord;
    const X = copy.folders.find((f) => f.id === x)!;
    copy.folders = [...copy.folders.filter((f) => f.id !== x), X.children.find((f) => f.id === y)!];
    const rel = "metadata (Sam's conflicted copy 2026-09-28).json";
    writeFileSync(join(s.libPath, rel), JSON.stringify(copy));

    const plan = await api.planRootConflict(rel);
    expect(plan.changes.map((c) => c.label)).toEqual([
      "Folder “Y” is at the top level in Sam's copy",
      "Folder “X” (with 1 inside) is not in Sam's copy",
    ]);
    // Only the deletion picked: Y and Z come out where X was, W goes with X.
    await api.applyRootConflict(rel, [x]);
    const tree = (await state(s)).folders;
    const top = tree.find((f) => f.id === y);
    expect(top?.children.map((c) => c.id)).toEqual([z]);
    expect(tree.some((f) => f.id === x || f.id === w)).toBe(false);
    expect(s.read(a!).folders).toContain(z);
    expect(s.read(b!).folders).not.toContain(w);
  });
});

describe.skipIf(!sandboxAvailable)('adding items to another library', () => {
  it('copies files and metadata with new ids, skips what is already there, and refuses bad targets', async () => {
    const s = await open();
    const { api } = s.host;
    const [a, b] = s.itemIds;
    await api.updateItems([a], { addTags: ['copied'], annotation: 'a note', star: 4 });
    const other = join(s.dir, 'Other.library');
    execFileSync('cp', ['-r', '--reflink=auto', s.libPath, other]);
    rmSync(join(other, 'images'), { recursive: true });
    mkdirSync(join(other, 'images'));
    writeFileSync(join(other, 'mtime.json'), '{"all":0}');
    const rootBefore = readFileSync(join(other, 'metadata.json'), 'utf8');
    const tree = await api.listLibraryFolders!(other);
    expect(tree.map((f) => f.id)).toEqual(
      (JSON.parse(rootBefore) as EagleRootRecord).folders.map((f) => f.id),
    );
    expect(readFileSync(join(other, 'metadata.json'), 'utf8')).toBe(rootBefore); // read-only

    const run = async () => {
      const job = await s.job((await api.copyToLibrary([a, b], other)).jobId);
      expect(job).toMatchObject({ kind: 'export', state: 'done' });
      return job.result as ImportResult & { copied: number; skipped: string[] };
    };
    const first = await run();
    expect(first.copied).toBe(2);
    const newIds = readdirSync(join(other, 'images')).map((d) => d.replace('.info', ''));
    expect(newIds.sort()).toEqual([...first.added].sort());
    expect(newIds).not.toContain(a);
    const rec = json(join(other, 'images', `${first.added[0]}.info`, 'metadata.json'));
    expect(rec).toMatchObject({
      name: s.read(a).name,
      tags: ['copied'],
      annotation: 'a note',
      star: 4,
      folders: [],
    });
    expect(
      existsSync(join(other, 'images', `${first.added[0]}.info`, `${rec.name}.${rec.ext}`)),
    ).toBe(true);
    expect(json(join(other, 'mtime.json'))[first.added[0]]).toBe(rec.lastModified);

    const second = await run();
    expect(second).toMatchObject({ copied: 0, skipped: [a, b] });
    expect(second.duplicates.map((d) => d.existingId).sort()).toEqual([...first.added].sort());
    await expect(api.copyToLibrary([a], s.libPath)).rejects.toThrow(/different library/);
    await expect(api.copyToLibrary([a], s.dir)).rejects.toThrow(
      /doesn't look like an Eagle library/,
    );
  });

  it("logs what changed in the target while it was closed in the target's History", async () => {
    const s = await open();
    const { api } = s.host;
    const [a, b] = s.itemIds;
    const other = join(s.dir, 'Other.library');
    execFileSync('cp', ['-r', '--reflink=auto', s.libPath, other]);
    const copy = async () => s.job((await api.copyToLibrary([a!], other)).jobId);
    await copy(); // builds the target's index (a first scan logs nothing)
    // The partner edits b in the target while Boogie has it closed.
    const meta = join(other, 'images', `${b}.info`, 'metadata.json');
    const rec = json(meta);
    rec.tags = [...rec.tags, 'partner'];
    rec.lastModified = Date.now() + 5;
    writeFileSync(meta, JSON.stringify(rec));
    const mtimes = json(join(other, 'mtime.json'));
    writeFileSync(join(other, 'mtime.json'), JSON.stringify({ ...mtimes, [b!]: rec.lastModified }));
    await copy();
    await api.openLibrary(other);
    const outside = (await api.listHistory()).filter((e) => e.actor.kind === 'external');
    expect(outside.map((e) => [e.label, e.undoable])).toEqual([
      ['Changed outside Boogie: edited 1 item', true],
    ]);
  });

  it("the duplicate finder logs what changed in another library it reads, in that library's History", async () => {
    const s = await open();
    const { api } = s.host;
    const [, b] = s.itemIds;
    const other = join(s.dir, 'Other.library');
    execFileSync('cp', ['-r', '--reflink=auto', s.libPath, other]);
    const scan = async () =>
      s.job((await api.findDuplicates({ mode: 'exact', otherLibraries: [other] })).jobId, 30_000);
    expect((await scan()).state).toBe('done'); // builds Other's index: nothing to log
    const meta = join(other, 'images', `${b}.info`, 'metadata.json');
    const rec = json(meta);
    rec.annotation = 'from the partner';
    rec.lastModified = Date.now() + 5;
    writeFileSync(meta, JSON.stringify(rec));
    const mtimes = json(join(other, 'mtime.json'));
    writeFileSync(join(other, 'mtime.json'), JSON.stringify({ ...mtimes, [b!]: rec.lastModified }));
    expect((await scan()).state).toBe('done');
    await api.openLibrary(other);
    const outside = (await api.listHistory()).filter((e) => e.actor.kind === 'external');
    expect(outside.map((e) => e.label)).toEqual(['Changed outside Boogie: edited 1 item']);
  });
});

describe.skipIf(!sandboxAvailable)('thumbnails', () => {
  it("a custom thumbnail is always a real picture: a Krita file's image, never a non-picture", async () => {
    const s = await open();
    const [a] = s.itemIds;
    const r = await s.host.api.setCustomThumbnail(a, kra(s.dir));
    expect(r.changed).toBe(1);
    const rec = s.read(a);
    expect(rec.customThumbnail).toBe(true);
    const thumb = readFileSync(join(s.libPath, 'images', `${a}.info`, `${rec.name}_thumbnail.png`));
    expect(thumb.subarray(8, 12).toString()).toBe('WEBP');
    const text = join(s.dir, 'notes.txt');
    writeFileSync(text, 'hello');
    await expect(s.host.api.setCustomThumbnail(a, text)).rejects.toThrow(/no picture/);
  });

  it('a video frame grabbed in the viewer (PNG bytes) becomes the custom thumbnail', async () => {
    const s = await open();
    const [a] = s.itemIds;
    const png = execFileSync('magick', ['-size', '64x48', 'xc:#c04030', 'png:-']);
    expect((await s.host.api.setCustomThumbnailBytes!(a, new Uint8Array(png))).changed).toBe(1);
    const rec = s.read(a);
    expect(rec.customThumbnail).toBe(true);
    const thumb = readFileSync(join(s.libPath, 'images', `${a}.info`, `${rec.name}_thumbnail.png`));
    expect(thumb.subarray(8, 12).toString()).toBe('WEBP');
  });

  it('an icon-only item (Eagle draws no Krita thumbnail) gets our own cached one, outside the library', async () => {
    const s = await open();
    const lib = (await state(s)).ref.id;
    const job = await s.job((await s.host.api.importPaths([kra(s.dir)])).jobId);
    const [id] = (job.result as ImportResult).added;
    expect(s.read(id).noPreview).toBe(true);
    expect((await s.host.api.getBriefs([id]))[0].localThumb).toBe(true);
    const served = await s.host.resolveFile('thumb', lib, id);
    expect(served).toMatchObject({ mime: 'image/webp' });
    expect(served!.path.startsWith(join(s.dir, 'home', 'cache'))).toBe(true);
    expect(readdirSync(join(s.libPath, 'images', `${id}.info`)).sort()).toEqual([
      'metadata.json',
      'paint.kra',
    ]);
    // A tag edit doesn't make a new rendition: the cache follows the file, not the record.
    await s.host.api.updateItems([id!], { addTags: ['wip'] });
    expect((await s.host.resolveFile('thumb', lib, id!))?.path).toBe(served!.path);
  });
});

describe.skipIf(!sandboxAvailable)('small things', () => {
  it('emptying the trash of a shared library says the partner loses those items too', async () => {
    const s = await open({ shared: true, partner: 'Sam' });
    await s.host.api.trashItems([s.itemIds[0]]);
    const r = await s.host.api.emptyTrash();
    expect(r.warning).toMatch(/^Sam loses these items too once Dropbox syncs/);
  });

  it('only you pause agents; the status and the MCP see it', async () => {
    const s = await open();
    const { host } = s;
    host.setAgentActivity([{ name: 'Claude', label: 'Tagging', done: 1, total: 9, paused: false }]);
    await host.api.setAgentPaused('Claude', true);
    expect(host.isAgentPaused?.('Claude')).toBe(true);
    expect((await host.api.getStatus()).agents[0].paused).toBe(true);
    await expect(
      host.as({ kind: 'agent', name: 'Claude' }).setAgentPaused('Claude', false),
    ).rejects.toThrow(/Only you/);
    await host.api.setAgentPaused('Claude', false);
    expect(host.isAgentPaused?.('Claude')).toBe(false);
  });

  it('agents, Eagle API clients and the browser extension can’t change where Boogie may edit', async () => {
    const s = await open();
    const before = await s.host.api.getSettings();
    const others = [
      { kind: 'agent', name: 'Claude (MCP)' } as const,
      CLIENT_ACTOR,
      EXTENSION_ACTOR,
    ];
    for (const actor of others) {
      const api = s.host.as(actor);
      await expect(api.setSettings({ allowProtectedWrites: true })).rejects.toThrow(/Only you/);
      await expect(api.setSettings({ writableRoots: ['/'] })).rejects.toThrow(/Only you/);
      // Mixed in with a harmless change, the whole patch is refused.
      await expect(api.setSettings({ thumbSize: 300, allowProtectedWrites: true })).rejects.toThrow(
        /Only you/,
      );
    }
    expect(await s.host.api.getSettings()).toEqual(before);
    expect(protectedWritesAllowed()).toBe(false);
    // You (the UI) can.
    expect(
      (await s.host.api.setSettings({ allowProtectedWrites: true })).allowProtectedWrites,
    ).toBe(true);
    expect(protectedWritesAllowed()).toBe(true);
    await s.host.api.setSettings({ allowProtectedWrites: false });
  });

  it('a big API batch keeps every id in entry order', async () => {
    const s = await open();
    const dir = join(s.dir, 'batch');
    mkdirSync(dir);
    const paths = Array.from({ length: 24 }, (_, i) => {
      const p = join(dir, `b${i}.png`);
      execFileSync('vips', ['black', p, String(40 + i), '30']);
      return p;
    });
    const { jobId } = await s.host.api.importBatch!(paths.map((path) => ({ path })));
    const result = (await s.job(jobId, 60_000)).result as ImportResult;
    expect(result.entryIds?.every(Boolean)).toBe(true);
    const items = await s.host.api.getItems(result.entryIds as string[]);
    expect(items.map((it) => it.name)).toEqual(paths.map((_, i) => `b${i}`));
    // "Date added" follows the entries, not which one finished first.
    expect(items.map((it) => it.importedAt)).toEqual(
      [...items.map((it) => it.importedAt)].sort((x, y) => x - y),
    );
  });
});
