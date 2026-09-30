// The service on the REAL adapter, index, query engine, journal, importer, media and watcher,
// against copies of a sandbox library in .tmp/service/ (see testSandbox.ts).
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobProgress, LibraryState } from '../../shared/types';
import type { EagleLibrary, EagleLibraryFactory } from '../contracts';
import { eagleLibraries } from '../eagle';
import { openIndex } from '../index';
import { libraryRef } from '../libraryId';
import { setAllowProtectedWrites, setWritableRoots } from '../safety/writeGuard';
import { decideReadOnly } from './session';
import { openSandbox, sandboxAvailable, type Sandbox } from './testSandbox';
import type { Env } from './types';

let sb: Sandbox | null = null;
afterEach(async () => {
  await sb?.close();
  sb = null;
});
const open = async (opts: Parameters<typeof openSandbox>[0] = {}) =>
  (sb = await openSandbox({ area: 'service', ...opts }));

/** A 600x400 PNG copied `n` times into a folder of the sandbox (identical content). */
function pngs(dir: string, n: number, name = 'pic'): string[] {
  mkdirSync(dir, { recursive: true });
  const first = join(dir, `${name}-0.png`);
  execFileSync('vips', ['black', first, '600', '400']);
  const out = [first];
  for (let i = 1; i < n; i++) {
    out.push(join(dir, `${name}-${i}.png`));
    copyFileSync(first, out[i]);
  }
  return out;
}

const history = async () => (await sb!.host.api.listHistory()).map((h) => h.label);

describe.skipIf(!sandboxAvailable)('opening and read-only', () => {
  it('opens and indexes a library under its own app folders, and a wrong folder never closes it', async () => {
    const s = await open();
    expect(s.itemIds).toHaveLength(11);
    const state = (await s.host.api.getLibraryState())!;
    expect(state).toMatchObject({ readOnly: false, readOnlyKind: null, indexing: null });
    expect((await s.host.api.listLibraries()).map((l) => l.path)).toContain(s.libPath);
    expect(existsSync(join(s.dir, 'home/cache/index'))).toBe(true);
    expect(await s.host.api.listHistory()).toEqual([]); // the first scan is not an outside change

    await expect(s.host.api.openLibrary(join(s.dir, 'home'))).rejects.toThrow(
      /doesn't look like an Eagle library/,
    );
    expect((await s.host.api.getLibraryState())?.ref.path).toBe(s.libPath);
  });

  it('is read-only where writing is not allowed (every edit says why) until Settings allows it', async () => {
    const s = await open({ writable: false });
    expect(await s.host.api.getLibraryState()).toMatchObject({
      readOnly: true,
      readOnlyKind: 'guard',
      readOnlyReason: 'Editing is off for this library. Allow it in Settings.',
    });
    const [a] = s.itemIds;
    const reason = /Editing is off/;
    await expect(s.host.api.updateItems([a], { star: 5 })).rejects.toThrow(reason);
    await expect(s.host.api.trashItems([a])).rejects.toThrow(reason);
    await expect(s.host.api.createFolder('X', null)).rejects.toThrow(reason);
    await expect(s.host.api.importPaths(['/x.jpg'])).rejects.toThrow(reason);
    await expect(s.host.api.importBytes(new Uint8Array([1]), 'x.png')).rejects.toThrow(reason);
    await expect(s.host.api.refreshThumbnails([a])).rejects.toThrow(reason);
    await expect(s.host.api.undo()).rejects.toThrow(reason);
    expect((await s.host.api.getItem(a))?.name).toBeTruthy(); // reads work

    await s.host.api.setSettings({ writableRoots: [s.dir] }); // reopens with a writable adapter
    expect(await s.host.api.getLibraryState()).toMatchObject({
      readOnly: false,
      readOnlyKind: null,
    });
    expect((await s.host.api.updateItems([a], { star: 3 })).changed).toBe(1);
  });

  it('says why: Eagle open here, a newer Eagle, or you asked for it', async () => {
    const eagle = { running: false, openLibraryPath: null as string | null };
    const s = await open({ eagleMonitor: { check: async () => ({ ...eagle }) } });
    Object.assign(eagle, { running: true, openLibraryPath: s.libPath });
    expect(await s.host.api.openLibrary(s.libPath)).toMatchObject({
      readOnlyKind: 'eagle',
      readOnlyReason: 'Eagle is open on this library on this computer. Close Eagle to edit here.',
    });
    Object.assign(eagle, { openLibraryPath: join(s.dir, 'Other.library') }); // another library: fine
    expect((await s.host.api.openLibrary(s.libPath)).readOnly).toBe(false);
    expect(await s.host.api.openLibrary(s.libPath, { readOnly: true })).toMatchObject({
      readOnlyKind: 'user',
      readOnlyReason: 'You opened it for viewing only.',
    });

    const rootPath = join(s.libPath, 'metadata.json');
    const root = JSON.parse(readFileSync(rootPath, 'utf8'));
    writeFileSync(rootPath, JSON.stringify({ ...root, applicationVersion: '5.0.0' }));
    expect(await s.host.api.openLibrary(s.libPath)).toMatchObject({
      readOnlyKind: 'version',
      readOnlyReason: "This library was saved by a newer Eagle (5.0.0), so Boogie won't change it.",
    });
  });

  it('tells a library in Dropbox apart: allowing its folder is not enough without the Dropbox switch', async () => {
    const ref = libraryRef(join(homedir(), 'Dropbox/Some Team/Some.library')); // only the path is judged
    const env = {
      deps: { eagleMonitor: { check: async () => ({ running: false, openLibraryPath: null }) } },
    } as unknown as Env;
    const decide = () => decideReadOnly(env, ref, { userReadOnly: false, versionReason: null });
    try {
      setWritableRoots([]);
      expect(await decide()).toMatchObject({ kind: 'guard', reason: /^Editing is off/ });
      setWritableRoots([join(homedir(), 'Dropbox')]);
      expect(await decide()).toMatchObject({ kind: 'protected', reason: /Dropbox .* Settings/ });
      setAllowProtectedWrites(true);
      expect(await decide()).toMatchObject({ kind: null, reason: null });
    } finally {
      setWritableRoots([]);
      setAllowProtectedWrites(false);
    }
  });

  it('the Dropbox switch in Settings turns a library there editable and back, without reopening by hand', async () => {
    const s = await open({ open: false });
    writeFileSync(join(s.dir, '.dropbox'), '{}'); // the sandbox folder is now a Dropbox folder
    expect(await s.host.api.openLibrary(s.libPath)).toMatchObject({
      readOnly: true,
      readOnlyKind: 'protected',
    });
    await s.host.api.refresh({ full: true }); // join the first index sync
    const [a] = (await s.host.api.query({ scope: { kind: 'all' }, filter: {}, sort: null })).ids;
    const star = s.read(a).star === 2 ? 3 : 2;
    await expect(s.host.api.updateItems([a], { star })).rejects.toThrow(/Editing is off/);

    await s.host.api.setSettings({ allowProtectedWrites: true });
    expect(await s.host.api.getLibraryState()).toMatchObject({
      readOnly: false,
      readOnlyKind: null,
    });
    expect((await s.host.api.updateItems([a], { star })).changed).toBe(1);
    expect(s.read(a).star).toBe(star);

    await s.host.api.setSettings({ allowProtectedWrites: false });
    expect(await s.host.api.getLibraryState()).toMatchObject({
      readOnly: true,
      readOnlyKind: 'protected',
    });
    // The edit's mtime.json raise (normally batched) went out before the guard closed, so the
    // partner's Eagle still sees it.
    const mtime = JSON.parse(readFileSync(join(s.libPath, 'mtime.json'), 'utf8'));
    expect(mtime[a]).toBe(s.read(a).lastModified);
    await expect(s.host.api.updateItems([a], { star: 5 })).rejects.toThrow(/Editing is off/);
    expect(s.read(a).star).toBe(star);
    // 'library' events told the UI both times (the banner follows them).
    const kinds = s.events
      .filter((e) => e.name === 'library')
      .map((e) => (e.payload as LibraryState).readOnlyKind);
    expect(kinds).toContain(null);
    expect(kinds.at(-1)).toBe('protected');
  });

  it('stops a running import between files when Eagle opens the library here', async () => {
    const eagle = { running: false, openLibraryPath: null as string | null };
    const s = await open({ eagleMonitor: { check: async () => ({ ...eagle }) } });
    const files = pngs(join(s.dir, 'incoming'), 60);
    const { jobId } = await s.host.api.importPaths(files, { onDuplicate: 'keep-both' });
    await s.waitFor(() =>
      s.events.some((e) => e.name === 'job' && (e.payload as JobProgress).done >= 2),
    );
    Object.assign(eagle, { running: true, openLibraryPath: s.libPath });
    await s.host.api.refresh(); // what window focus does; the 10 s tick does the same
    const job = await s.job(jobId);
    expect(job.state).toBe('cancelled');
    const onDisk = readdirSync(join(s.libPath, 'images')).length;
    expect(onDisk).toBeLessThan(11 + 60);
    await new Promise((r) => setTimeout(r, 300));
    expect(readdirSync(join(s.libPath, 'images')).length).toBe(onDisk); // nothing lands later
    expect((await s.host.api.getLibraryState())?.readOnlyKind).toBe('eagle');
  });
});

describe.skipIf(!sandboxAvailable)('editing', () => {
  it('writes tags exactly as Eagle wants them (record, mtime.json, journal)', async () => {
    const s = await open();
    const [a, b] = s.itemIds;
    const before = s.read(a).lastModified!;
    const res = await s.host.api.updateItems([a, b, 'NOTANITEMID99', 'x'], {
      addTags: ['service test'],
    });
    expect(res).toMatchObject({ changed: 2 });
    expect(res.skipped).toEqual([
      { id: 'x', reason: 'Not a valid item id.', kind: 'other' },
      { id: 'NOTANITEMID99', reason: 'Item not found.', kind: 'missing' },
    ]);
    const rec = s.read(a);
    expect(rec.tags).toContain('service test');
    expect(rec.lastModified).toBeGreaterThan(before);
    expect(Object.keys(rec)[0]).toBe('id');
    expect((await s.host.api.getItem(a))?.tags).toContain('service test');
    expect((await s.host.api.listHistory())[0]).toMatchObject({
      groupId: res.groupId,
      label: 'Tagged 2 items “service test”',
      kind: 'items',
      actor: { name: 'You' },
    });
    // mtime.json is raised (the partner's Eagle needs it) once the writes are flushed: closing flushes.
    await s.host.api.closeLibrary();
    const mtime = JSON.parse(readFileSync(join(s.libPath, 'mtime.json'), 'utf8'));
    expect(mtime[a]).toBe(rec.lastModified);
    expect(Object.keys(mtime).at(-1)).toBe('all');
    await expect(s.host.api.getCounts()).rejects.toThrow('Open a library first.');
  });

  it('a disk error part way keeps what landed in the index and History, and it can be undone', async () => {
    const s = await open();
    const [a, b, c] = s.itemIds;
    const locked = join(s.libPath, 'images', `${c}.info`);
    chmodSync(locked, 0o555); // no temp file can be made in c's folder
    try {
      await expect(s.host.api.updateItems([a, b, c], { addTags: ['partial'] })).rejects.toThrow();
    } finally {
      chmodSync(locked, 0o755);
    }
    expect((await s.host.api.getItem(a))?.tags).toContain('partial');
    expect((await s.host.api.getItem(c))?.tags).not.toContain('partial');
    expect((await s.host.api.listHistory())[0]).toMatchObject({ itemCount: 2 });
    await s.host.api.undo();
    expect(s.read(a).tags).not.toContain('partial');
    expect((await s.host.api.getItem(b))?.tags).not.toContain('partial');
  });

  it('Ctrl+Z undoes only what you did in the app, and two quick presses undo two actions', async () => {
    const s = await open();
    const [a, b, c, d] = s.itemIds;
    await s.host.api.updateItems([a], { addTags: ['first'] });
    await s.host.api.updateItems([b], { addTags: ['second'] });
    await s.host.as({ kind: 'user', name: 'Browser extension' }).updateItems([c], { star: 2 });
    await s.host.as({ kind: 'agent', name: 'Claude (mcp)' }).updateItems([d], { star: 4 });

    const [u1, u2] = await Promise.all([s.host.api.undo(), s.host.api.undo()]);
    expect(u1.reverted + u2.reverted).toBe(2);
    expect(s.read(a).tags).not.toContain('first');
    expect(s.read(b).tags).not.toContain('second');
    expect(s.read(c).star).toBe(2);
    expect(s.read(d).star).toBe(4);
    expect((await s.host.api.undo()).groupId).toBeNull();
    // The agent undoes its own work.
    expect((await s.host.as({ kind: 'agent', name: 'Claude (mcp)' }).undo()).reverted).toBe(1);
    expect('star' in s.read(d)).toBe(false);
  });

  it('an undo blocked by later changes writes nothing and can be tried again', async () => {
    const s = await open();
    const [a] = s.itemIds;
    const { groupId } = await s.host.api.updateItems([a], { star: 4 });
    s.writeAsEagle(a, (rec) => (rec.star = 2)); // the partner changed the same field since
    const before = readFileSync(join(s.libPath, 'images', `${a}.info`, 'metadata.json'), 'utf8');
    const u = await s.host.api.undo();
    expect(u).toMatchObject({ groupId: null, reverted: 0 });
    expect(u.conflicts).toEqual([expect.objectContaining({ id: a, field: 'star' })]);
    expect(readFileSync(join(s.libPath, 'images', `${a}.info`, 'metadata.json'), 'utf8')).toBe(
      before,
    );
    const entry = (await s.host.api.listHistory()).find((h) => h.groupId === groupId);
    expect(entry).toMatchObject({ undoable: true, undoneBy: null });
  });

  it('a big edit is ONE history entry written in slices; no change makes no entry', async () => {
    const s = await open({ extraItems: 0 });
    // 250 items: copies of one item folder under new ids (a scratch library, so writing is fine).
    const [src] = s.itemIds;
    for (let i = 0; i < 250; i++) {
      const id = `ZZBIG${String(i).padStart(8, '0')}`;
      const dir = join(s.libPath, 'images', `${id}.info`);
      execFileSync('cp', ['-r', '--reflink=auto', join(s.libPath, 'images', `${src}.info`), dir]);
      const rec = JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8'));
      writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ ...rec, id }));
    }
    await s.host.api.refresh({ full: true });
    const ids = (await s.host.api.query({ scope: { kind: 'all' }, filter: {}, sort: null })).ids;
    expect(ids.length).toBeGreaterThan(250);
    const entries = (await s.host.api.listHistory()).length;
    const r = await s.host.api.updateItems(ids, { addTags: ['bulk'] });
    expect(r.changed).toBe(ids.length);
    const history = await s.host.api.listHistory();
    expect(history).toHaveLength(entries + 1);
    expect(history[0]).toMatchObject({
      itemCount: ids.length,
      label: `Tagged ${ids.length} items “bulk”`,
    });

    const again = await s.host.api.updateItems(ids.slice(0, 3), { addTags: ['bulk'] });
    expect(again).toMatchObject({ groupId: null, changed: 0 });
    expect(again.skipped.map((x) => x.reason)).toEqual(Array(3).fill('Nothing to change.'));
    expect(await s.host.api.listHistory()).toHaveLength(entries + 1);
  });

  it('a throwing listener never breaks an edit; rename and reorder say what they skipped', async () => {
    const s = await open();
    const [a, b] = s.itemIds;
    const off = s.host.on('itemsChanged', () => {
      throw new Error('a broken window');
    });
    try {
      expect((await s.host.api.updateItems([a], { star: 1 })).changed).toBe(1);
    } finally {
      off();
    }
    const name = s.read(a).name;
    const r = await s.host.api.renameItems([a], name);
    expect(r.skipped).toEqual([{ id: a, reason: 'Nothing to change.', kind: 'unchanged' }]);
    const { id: folder } = await s.host.api.createFolder('Only a', null);
    await s.host.api.updateItems([a], { addFolders: [folder] });
    const order = await s.host.api.reorderItems(folder, [b], null);
    expect(order.skipped).toEqual([{ id: b, reason: 'Not in this folder.', kind: 'other' }]);
  });

  it('undoes and redoes through the real journal, and leaves a later outside change alone', async () => {
    const s = await open();
    const [a] = s.itemIds;
    await s.host.api.updateItems([a], { addTags: ['mine'], star: 4 });
    s.writeAsEagle(a, (rec) => rec.tags.push('theirs'));

    expect((await s.host.api.undo()).reverted).toBe(1);
    expect(s.read(a).tags).toEqual(expect.arrayContaining(['theirs']));
    expect(s.read(a).tags).not.toContain('mine');
    expect('star' in s.read(a)).toBe(false); // unrated, like Eagle

    expect((await s.host.api.redo()).groupId).not.toBeNull();
    expect(s.read(a)).toMatchObject({ star: 4, tags: expect.arrayContaining(['mine', 'theirs']) });
  });

  it('trashes, restores, deletes for good into the journal store, and brings it back on undo', async () => {
    const s = await open();
    const [a, b] = s.itemIds;
    await s.host.api.trashItems([a, b]);
    expect(s.read(a)).toMatchObject({ isDeleted: true });
    await s.host.api.restoreItems([b]);
    expect('deletedTime' in s.read(b)).toBe(false);

    expect(await s.host.api.deletePermanently([a, b])).toMatchObject({
      changed: 1,
      skipped: [{ id: b }],
    });
    expect(existsSync(join(s.libPath, 'images', `${a}.info`))).toBe(false);
    const stored = execFileSync('find', [join(s.dir, 'home/data/journal'), '-name', `${a}.info`])
      .toString()
      .trim();
    expect(stored).toContain(`${a}.info`);

    expect((await s.host.api.undo()).reverted).toBe(1);
    expect(existsSync(join(s.libPath, 'images', `${a}.info`, 'metadata.json'))).toBe(true);
    expect(existsSync(stored)).toBe(false);
    expect((await s.host.api.getCounts()).trash).toBe(1);
  });

  it('adds a folder with its auto-tags, reorders by hand, and deletes the folder items-first', async () => {
    const s = await open();
    const [a, b, c, d] = s.itemIds;
    const parent = await s.host.api.createFolder('Finals', null);
    await s.host.api.updateFolder(parent.id, { tags: ['finals'] });
    const child = await s.host.api.createFolder('Round two', parent.id);
    await s.host.api.updateFolder(child.id, { tags: ['round two'] });

    await s.host.api.updateItems([a, b, c, d], { addFolders: [child.id] });
    expect(s.read(a).tags).toEqual(expect.arrayContaining(['round two', 'finals']));
    expect((await s.host.api.getCounts()).folders[parent.id]).toEqual({ own: 0, deep: 4 });
    expect((await s.host.api.listHistory())[0].label).toBe('Added 4 items to “Round two”');

    const scope = { kind: 'folder', id: child.id, includeSubfolders: false } as const;
    const shown = async () => (await s.host.api.query({ scope, filter: {}, sort: null })).ids;
    const start = await shown();
    await s.host.api.reorderItems(child.id, [start[3]], start[0]);
    expect(await shown()).toEqual([start[3], start[0], start[1], start[2]]);
    expect((await s.host.api.getLibraryState())!.folders.at(-1)!.children[0]).toMatchObject({
      orderBy: 'MANUAL',
      sortIncrease: true,
    });
    await s.host.api.reorderItems(child.id, [start[3], start[0]], null);
    expect(await shown()).toEqual([start[1], start[2], start[3], start[0]]);

    const del = await s.host.api.deleteFolder(parent.id);
    expect(del.changed).toBe(5); // four items, then the root
    expect(s.read(a).folders).not.toContain(child.id);
    expect((await s.host.api.undo()).reverted).toBeGreaterThan(0);
    const state = (await s.host.api.getLibraryState())!;
    expect(state.folders.find((f) => f.name === 'Finals')?.children[0].id).toBe(child.id);
    expect(s.read(a).folders).toContain(child.id);
  });

  it('renames items and tags (a rename onto an existing tag merges)', async () => {
    const s = await open();
    const [a, b] = s.itemIds;
    await s.host.api.updateItems([a, b], { addTags: ['old name'] });
    expect((await s.host.api.renameTag('old name', 'new name')).changed).toBe(2);
    await s.host.api.updateItems([a], { addTags: ['third'] });
    expect((await s.host.api.renameTag('third', 'new name')).changed).toBe(1);
    expect(s.read(a).tags.filter((t) => t === 'new name')).toHaveLength(1);
    expect((await history())[0]).toBe('Merged tag “third” into “new name”');

    expect((await s.host.api.renameItems([a, b], 'Study %N')).changed).toBe(2);
    expect(s.read(a).name).toBe('Study 1');
    const item = await s.host.api.getItem(a);
    expect(item?.name).toBe('Study 1');
    expect(existsSync(item!.filePath)).toBe(true);
    await s.host.api.deleteTag('new name');
    expect(s.read(a).tags).not.toContain('new name');
  });

  it('smart folders, quick access and tag groups warn that a shared library partner may lose them', async () => {
    const s = await open({ shared: true, partner: 'Sam' });
    const smart = await s.host.api.createSmartFolder('Five stars', [
      { rules: [{ property: 'rating', method: 'equal', value: 5 }], match: 'AND' },
    ]);
    await s.host.api.updateSmartFolder(smart.id, { name: 'Best' });
    const node = (await s.host.api.getLibraryState())!.smartFolders.find((f) => f.id === smart.id);
    expect(node).toMatchObject({ name: 'Best', modificationTime: expect.any(Number) });
    const q = await s.host.api.setQuickAccess([{ type: 'smartFolder', id: smart.id }]);
    expect(q.warning).toBe(
      "Eagle on Sam's computer won't pick this up until it restarts, and may undo it.",
    );
    expect(
      (await s.host.api.upsertTagGroup({ name: 'Painters', tags: ['a', 'a'] })).warning,
    ).toMatch(/Sam's computer/);
    await s.host.api.setLibraryOptions(s.libPath, { shared: false });
    expect((await s.host.api.setQuickAccess([])).warning).toBeUndefined();
  });

  it('merges several duplicate groups as ONE history entry, undone in one step', async () => {
    const s = await open();
    const [a, b, c, d] = s.itemIds;
    await s.host.api.updateItems([b], { addTags: ['from b'], star: 5 });
    const r = await s.host.api.mergeDuplicates([
      { keeperId: a, otherIds: [b] },
      { keeperId: c, otherIds: [d, c] },
    ]);
    expect(r.skipped).toEqual([]);
    expect(s.read(a)).toMatchObject({ star: 5, tags: expect.arrayContaining(['from b']) });
    expect(s.read(b).isDeleted).toBe(true);
    expect(s.read(d).isDeleted).toBe(true);
    expect((await s.host.api.listHistory())[0]).toMatchObject({
      kind: 'merge',
      label: 'Merged 2 groups of duplicates (2 items to trash)',
    });
    await s.host.api.undo();
    expect(s.read(b).isDeleted).toBe(false);
    expect(s.read(d).isDeleted).toBe(false);
  });

  it('refreshes thumbnails as a job and serves thumbnails and originals with the right type', async () => {
    const s = await open();
    const lib = (await s.host.api.getLibraryState())!.ref.id;
    const [a, b] = s.itemIds;
    const r = await s.host.api.refreshThumbnails([a, b]);
    expect(r.changed).toBe(2);
    expect((await s.host.api.listJobs()).find((j) => j.kind === 'thumbnails')).toMatchObject({
      state: 'done',
    });
    for (const id of s.itemIds.slice(0, 4)) {
      const thumb = await s.host.resolveFile('thumb', lib, id);
      expect(thumb && existsSync(thumb.path)).toBe(true);
      expect(thumb?.mime).toMatch(/^image\//);
      expect(await s.host.resolveFile('file', lib, id)).not.toBeNull();
    }
    expect(await s.host.resolveFile('file', lib, '../../etc/passwd')).toBeNull();
    expect(await s.host.resolveFile('file', 'some-other-library', a)).toBeNull();
  });
});

describe.skipIf(!sandboxAvailable)('outside changes', () => {
  it("logs a partner's edit on a full refresh, and names nobody when the library isn't shared", async () => {
    const s = await open({ shared: true, partner: 'Sam' });
    const [a, b] = s.itemIds;
    s.writeAsEagle(a, (rec) => rec.tags.push('from partner'));
    await s.host.api.refresh({ full: true });
    expect((await s.host.api.listHistory())[0]).toMatchObject({
      kind: 'external',
      label: 'Sam edited 1 item',
      actor: { kind: 'external', name: 'Sam' },
    });
    expect((await s.host.api.getItem(a))?.tags).toContain('from partner');
    expect((await s.host.api.getStatus()).lastExternal?.label).toBe('Sam edited 1 item');

    await s.host.api.setLibraryOptions(s.libPath, { shared: false });
    s.writeAsEagle(b, (rec) => Object.assign(rec, { isDeleted: true, deletedTime: Date.now() }));
    await s.host.api.refresh({ full: true });
    expect((await history())[0]).toBe('Changed outside Boogie: moved 1 item to trash');
  });

  it('a full refresh catches an edit that never raised mtime.json, and lists conflicted copies and unreadable items', async () => {
    const s = await open();
    const [a, b] = s.itemIds;
    const rec = s.read(a);
    rec.annotation = 'edited by hand';
    writeFileSync(join(s.libPath, 'images', `${a}.info`, 'metadata.json'), JSON.stringify(rec));
    writeFileSync(
      join(s.libPath, 'images', `${b}.info`, "metadata (Sam's conflicted copy 2026-09-28).json"),
      '{}',
    );
    mkdirSync(join(s.libPath, 'images', 'MZZZZZZZZZZZZ.info'));
    writeFileSync(join(s.libPath, 'images', 'MZZZZZZZZZZZZ.info', 'metadata.json'), '\0\0\0\0');

    await s.host.api.refresh({ full: true });
    expect((await s.host.api.getItem(a))?.annotation).toBe('edited by hand');
    expect((await history())[0]).toBe('Changed outside Boogie: edited 1 item');
    const status = await s.host.api.getStatus();
    expect(status.sync.conflicts).toEqual([expect.objectContaining({ itemId: b, kind: 'item' })]);
    expect(status.unreadableItems).toBe(1);
  });

  it('an interrupted first scan is finished on the next open without being logged as outside changes', async () => {
    let reads = 0;
    let stopAt = 6;
    let onStop = () => {};
    // Reads are slowed and the first scan is stopped part way (as if the app quit), with small batches saved.
    const eagle: EagleLibraryFactory = {
      ...eagleLibraries,
      open: async (root, o) => {
        const lib = await eagleLibraries.open(root, o);
        return new Proxy(lib, {
          get(t, k) {
            if (k === 'readItem')
              return async (id: string) => {
                if (++reads === stopAt) onStop();
                await new Promise((r) => setTimeout(r, 2));
                return t.readItem(id);
              };
            const v = Reflect.get(t, k) as unknown;
            return typeof v === 'function' ? (v as () => unknown).bind(t) : v;
          },
        }) as EagleLibrary;
      },
    };
    const indexes = {
      open: (ref: Parameters<typeof openIndex>[0], o?: { dir?: string }) =>
        openIndex(ref, { ...o, batchSize: 2, concurrency: 1 }),
    };
    const s = await open({ open: false, deps: { eagle, indexes } });
    const stopped = new Promise<void>((resolve) => {
      onStop = () => void s.host.api.closeLibrary().then(resolve);
    });
    await s.host.api.openLibrary(s.libPath);
    await stopped;
    stopAt = -1;
    await s.host.api.openLibrary(s.libPath);
    await s.host.api.refresh({ full: true });
    expect((await s.host.api.getCounts()).all).toBe(11);
    expect(await s.host.api.listHistory()).toEqual([]);
  });

  it('with the real watcher: our own edits are not logged as outside changes, a partner edit and a new folder are', async () => {
    const s = await open({ shared: true, partner: 'Sam' });
    const [a, b] = s.itemIds;
    await s.host.api.updateItems([a, b], { addTags: ['mine'] });
    // Our mtime.json raise lands about a second later and the watcher polls every 2 s: give both time.
    await new Promise((res) => setTimeout(res, 4500));
    expect((await s.host.api.listHistory()).filter((h) => h.kind === 'external')).toEqual([]);

    s.writeAsEagle(b, (rec) => rec.tags.push('from partner'));
    await s.waitFor(
      () =>
        s.events.some(
          (e) => e.name === 'history' && (e.payload as { kind: string }).kind === 'external',
        ),
      10_000,
    );
    expect((await s.host.api.getItem(b))?.tags).toEqual(
      expect.arrayContaining(['mine', 'from partner']),
    );

    const rootPath = join(s.libPath, 'metadata.json');
    const root = JSON.parse(readFileSync(rootPath, 'utf8'));
    root.folders.push({
      id: 'PARTNERFLDR01',
      name: 'Sam was here',
      description: '',
      children: [],
      modificationTime: Date.now(),
      tags: [],
      password: '',
      passwordTips: '',
    });
    root.modificationTime = Math.max(Date.now(), root.modificationTime + 1);
    writeFileSync(rootPath, JSON.stringify(root));
    await s.waitFor(
      () =>
        s.events.some(
          (e) =>
            e.name === 'library' &&
            (e.payload as LibraryState).folders.some((f) => f.name === 'Sam was here'),
        ),
      10_000,
    );
  });
});

describe.skipIf(!sandboxAvailable)('imports and duplicates', () => {
  it('cancelling a link import stops its download at once', async () => {
    const s = await open();
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.write(Buffer.alloc(100)); // then nothing, like a stalled server
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/slow.png`;
      const { jobId } = await s.host.api.importUrl(url);
      await new Promise((r) => setTimeout(r, 200));
      await s.host.api.cancelJob(jobId);
      const job = await s.job(jobId, 5000); // the idle timeout alone would take 60 s
      expect(job.state).not.toBe('running');
    } finally {
      server.closeAllConnections();
      await new Promise((ok) => server.close(ok));
    }
  });

  it('imports as a job in one history group, into a folder, and the job remembers its options', async () => {
    const s = await open();
    const folder = await s.host.api.createFolder('Incoming', null);
    const [source] = pngs(s.dir, 1, 'incoming');
    const opts = { folderId: folder.id, tags: ['fresh'] };
    const job = await s.job((await s.host.api.importPaths([source], opts)).jobId);
    expect(job).toMatchObject({
      state: 'done',
      error: null,
      options: { ...opts, onDuplicate: 'ask' },
    });
    const result = job.result as { added: string[]; groupId: string };
    expect(await s.host.api.getItem(result.added[0])).toMatchObject({
      name: 'incoming-0',
      folders: [folder.id],
      tags: expect.arrayContaining(['fresh']),
    });
    expect((await s.host.api.listHistory())[0]).toMatchObject({
      groupId: result.groupId,
      kind: 'import',
      label: 'Imported 1 item into “Incoming”',
    });

    // A paste is a short job too (closing the library waits for it) and returns its result.
    const pasted = await s.host.api.importBytes(readFileSync(source), 'Clipboard.png', {
      onDuplicate: 'keep-both',
    });
    expect(pasted).toMatchObject({ added: [expect.any(String)], groupId: expect.any(String) });
    expect((await s.host.api.listJobs()).filter((j) => j.kind === 'import')).toHaveLength(2);
  });

  it('imports a folder tree that recreates its folders, usable at once', async () => {
    const s = await open();
    const top = join(s.dir, 'Reference pack');
    pngs(join(top, 'Hands'), 1, 'a');
    pngs(join(top, 'Faces'), 1, 'b');
    const job = await s.job(
      (await s.host.api.importPaths([top], { keepFolderStructure: true, onDuplicate: 'keep-both' }))
        .jobId,
    );
    expect((job.result as { added: string[] }).added).toHaveLength(2);
    const pack = (await s.host.api.getLibraryState())!.folders.find(
      (f) => f.name === 'Reference pack',
    )!;
    expect(pack.children.map((f) => f.name).sort()).toEqual(['Faces', 'Hands']);
    const hands = pack.children.find((f) => f.name === 'Hands')!;
    expect((await s.host.api.getCounts()).folders[hands.id]).toEqual({ own: 1, deep: 1 });
    await s.host.api.updateFolder(hands.id, { name: 'Hands and feet' });
  });

  it('a batch import is ONE job and ONE history entry, with each entry named and its id in order', async () => {
    const s = await open();
    const [p1, p2] = pngs(s.dir, 2, 'batch');
    const png = readFileSync(p1);
    const { jobId } = await s.host.api.importBatch!([
      { path: p1, opts: { name: 'First one', onDuplicate: 'keep-both' } },
      { path: join(s.dir, 'missing.png') },
      { bytes: png, fileName: 'third.png', opts: { tags: ['third'], onDuplicate: 'keep-both' } },
      {
        path: p2,
        opts: { name: 'Fourth', modificationTime: 1_600_000_000_000, onDuplicate: 'keep-both' },
      },
    ]);
    const job = await s.job(jobId);
    const result = job.result as { entryIds: (string | null)[]; failed: unknown[] };
    expect(result.entryIds).toHaveLength(4);
    expect(result.entryIds[1]).toBeNull();
    expect(result.failed).toHaveLength(1);
    const [first, , third, fourth] = result.entryIds;
    expect((await s.host.api.getItem(first!))?.name).toBe('First one');
    expect((await s.host.api.getItem(third!))?.tags).toContain('third');
    expect(await s.host.api.getItem(fourth!)).toMatchObject({
      name: 'Fourth',
      importedAt: 1_600_000_000_000,
    });
    expect((await s.host.api.listJobs()).filter((j) => j.kind === 'import')).toHaveLength(1);
    expect((await s.host.api.listHistory()).filter((h) => h.kind === 'import')).toHaveLength(1);
  });

  it('finds exact duplicates, also inside a smart folder only', async () => {
    const s = await open();
    const files = pngs(s.dir, 3, 'twin');
    await s.job((await s.host.api.importPaths(files, { onDuplicate: 'keep-both' })).jobId);
    const smart = await s.host.api.createSmartFolder('Twins', [
      {
        rules: [
          { property: 'name', method: 'contain', value: 'twin-1' },
          { property: 'name', method: 'contain', value: 'twin-2' },
        ],
        match: 'OR',
      },
    ]);
    const scan = async (scope?: { kind: 'smartFolder'; id: string }) => {
      const job = await s.job((await s.host.api.findDuplicates({ mode: 'exact', scope })).jobId);
      expect(job.state).toBe('done');
      return (job.result as { members: unknown[] }[]).map((g) => g.members.length);
    };
    expect(await scan()).toEqual([3]);
    expect(await scan({ kind: 'smartFolder', id: smart.id })).toEqual([2]);
  });
});
