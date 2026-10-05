// Dropbox conflicted copies merged and tidied, on the REAL core against copies of the sample
// library under .tmp/merge-core/ (docs/specs/merge.md). The partner is simulated by writing the
// copy files Dropbox would leave. Nothing outside .tmp is touched.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConflictFile } from '../../shared/types';
import { createJournal } from '../journal';
import { VERSIONS } from './conflicts';
import { SETTLE } from './group';
import { openSandbox, sandboxAvailable, type Sandbox } from './testSandbox';

let sb: Sandbox | null = null;
afterEach(async () => {
  await sb?.close();
  sb = null;
});
const open = async (opts: Parameters<typeof openSandbox>[0] = {}) =>
  (sb = await openSandbox({ area: 'merge-core', ...opts }));

const COPY = "metadata (Sam's conflicted copy 2026-09-28).json";
const metaPath = (s: Sandbox, id: string) =>
  join(s.libPath, 'images', `${id}.info`, 'metadata.json');
const copyPath = (s: Sandbox, id: string) => join(s.libPath, 'images', `${id}.info`, COPY);
const copyRel = (id: string) => `images/${id}.info/${COPY}`;
const text = (path: string) => readFileSync(path, 'utf8');

/** What the partner's Eagle leaves when it saves `rec` from an older copy: a conflicted copy file. */
function leaveCopy(s: Sandbox, id: string, rec: object): void {
  writeFileSync(copyPath(s, id), JSON.stringify(rec));
}

async function conflictsOf(s: Sandbox): Promise<ConflictFile[]> {
  return (await s.host.api.getStatus()).sync.conflicts;
}

/** Every file under the journal store's conflicts folder, relative to it. */
function stored(s: Sandbox): string[] {
  const base = join(s.dir, 'home/data/journal');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.includes(`${join('store', 'conflicts')}`)) out.push(p.slice(base.length + 1));
    }
  };
  if (existsSync(base)) walk(base);
  return out;
}

/** A tag we added (our edit, in the journal) and a rename the partner made from the copy without it. */
async function taggedAndRenamed(s: Sandbox, id: string) {
  const v1 = JSON.parse(text(metaPath(s, id)));
  await s.host.api.updateItems([id], { addTags: ['x'] });
  leaveCopy(s, id, { ...v1, name: 'Renamed by Sam', lastModified: Date.now() });
  return v1 as { name: string };
}

describe.skipIf(!sandboxAvailable)('a conflicted copy of an item', () => {
  it("takes the partner's rename, asks about the tag their copy lacks, and Undo puts the file back", async () => {
    const s = await open({ shared: true, partner: 'Sam' });
    const { api } = s.host;
    const [a] = s.itemIds;
    const v1 = await taggedAndRenamed(s, a);
    await api.refresh({ full: true });

    expect(s.read(a)).toMatchObject({
      name: 'Renamed by Sam',
      tags: expect.arrayContaining(['x']),
    });
    expect(existsSync(copyPath(s, a))).toBe(true); // a question is left, so the copy stays
    const found = (await conflictsOf(s)).find((c) => c.path === copyRel(a));
    expect(found?.questions).toEqual([
      { id: 'tag:x', label: 'Tag “x”', live: 'x', copy: '(none)' },
    ]);
    const [merge] = await api.listHistory();
    expect(merge).toMatchObject({
      label: `Merged Sam's conflicted copy of “${v1.name}”: took the name; 1 question left`,
      actor: { kind: 'system' },
      kind: 'merge',
      undoable: true,
    });

    // A second look changes nothing: no write, no new History entry.
    const before = text(metaPath(s, a));
    const entries = (await api.listHistory()).length;
    await api.refresh({ full: true });
    expect(text(metaPath(s, a))).toBe(before);
    expect((await api.listHistory()).length).toBe(entries);
    // Nor does a restart: what the session remembered is rebuilt from the files and the journal.
    await api.closeLibrary();
    await api.openLibrary(s.libPath);
    await api.refresh({ full: true });
    expect(text(metaPath(s, a))).toBe(before);
    expect((await api.listHistory()).length).toBe(entries);
    expect((await conflictsOf(s)).find((c) => c.path === copyRel(a))?.questions).toHaveLength(1);

    // Undo puts the live file back, and the copy is not merged again by itself: what it would
    // have taken is a question now.
    const undone = await api.undo(merge.groupId);
    expect(undone.conflicts).toEqual([]);
    expect(s.read(a)).toMatchObject({ name: v1.name });
    await api.refresh({ full: true });
    expect(s.read(a).name).toBe(v1.name);
    const asked = (await conflictsOf(s)).find((c) => c.path === copyRel(a))?.questions;
    expect(asked?.map((q) => q.id).sort()).toEqual(['name', 'tag:x']);
  });

  it('with nothing left to ask, the copy goes to the store in the same group, and Undo leaves it there', async () => {
    const s = await open();
    const { api } = s.host;
    const [a] = s.itemIds;
    const v1 = JSON.parse(text(metaPath(s, a)));
    await api.updateItems([a], { addTags: ['x'] });
    // The partner saw our tag but renamed the item from a copy that already had it.
    leaveCopy(s, a, {
      ...JSON.parse(text(metaPath(s, a))),
      name: 'Renamed by Sam',
      lastModified: Date.now(),
    });
    await api.refresh({ full: true });

    expect(s.read(a).name).toBe('Renamed by Sam');
    expect(existsSync(copyPath(s, a))).toBe(false);
    expect(stored(s)).toHaveLength(1);
    expect(stored(s)[0]).toContain(`images/${a}.info/${COPY}`);
    expect((await conflictsOf(s)).some((c) => c.path === copyRel(a))).toBe(false);
    const [merge] = await api.listHistory();
    expect(merge.label).toBe(`Merged Sam's conflicted copy of “${v1.name}”: took the name`);

    await api.undo(merge.groupId);
    expect(s.read(a).name).toBe(v1.name);
    await api.refresh({ full: true });
    expect(existsSync(copyPath(s, a))).toBe(false); // never brought back into the library
    expect(stored(s)).toHaveLength(1);
  });

  it('resolveConflict takes the copy for the picked questions only, then moves the copy out', async () => {
    const s = await open();
    const { api } = s.host;
    const [a] = s.itemIds;
    await taggedAndRenamed(s, a);
    await api.refresh({ full: true });
    expect(existsSync(copyPath(s, a))).toBe(true);

    const r = await api.resolveConflict(copyRel(a), ['tag:x', 'tag:gone']);
    expect(r.changed).toBe(1);
    expect(r.skipped.map((x) => x.id)).toEqual(['tag:gone']);
    expect(s.read(a).tags).not.toContain('x');
    expect(existsSync(copyPath(s, a))).toBe(false);
    expect(stored(s)).toHaveLength(1);
    const [entry] = await api.listHistory();
    expect(entry).toMatchObject({ groupId: r.groupId, undoable: true });
    expect(entry.label).toMatch(/^Settled Sam's conflicted copy of “.+”: removed 1 tag$/);
    expect((await conflictsOf(s)).some((c) => c.path === copyRel(a))).toBe(false);

    await api.undo(r.groupId!);
    expect(s.read(a).tags).toContain('x');
    expect(existsSync(copyPath(s, a))).toBe(false);
  });

  it('with no history for the item every difference is a question; keeping the library version clears it', async () => {
    const s = await open();
    const { api } = s.host;
    const [a, b] = s.itemIds;
    for (const id of [a, b])
      leaveCopy(s, id, {
        ...JSON.parse(text(metaPath(s, id))),
        name: 'cc',
        lastModified: Date.now(),
      });
    const [liveA, liveB] = [text(metaPath(s, a)), text(metaPath(s, b))];
    await api.refresh({ full: true });
    expect(text(metaPath(s, a))).toBe(liveA); // nothing is certain without history: nothing is written
    const found = (await conflictsOf(s)).filter((c) => c.kind === 'item');
    expect(found.map((c) => c.questions?.map((q) => q.id))).toEqual([['name'], ['name']]);
    expect(found[0].questions![0]).toMatchObject({ label: 'Name', copy: 'cc' });

    await api.resolveConflict(copyRel(a), []); // keep the current name
    expect(existsSync(copyPath(s, a))).toBe(false);
    expect(text(metaPath(s, a))).toBe(liveA);

    // Taking the copy's name renames the files with the record, like any rename.
    const was = s.read(b).name;
    await api.resolveConflict(copyRel(b), ['name']);
    expect(s.read(b).name).toBe('cc');
    expect(existsSync(join(s.libPath, 'images', `${b}.info`, `cc.${s.read(b).ext}`))).toBe(true);
    expect(existsSync(join(s.libPath, 'images', `${b}.info`, `${was}.${s.read(b).ext}`))).toBe(
      false,
    );
    expect(text(metaPath(s, b))).not.toBe(liveB);
    expect(stored(s)).toHaveLength(2);
  });

  it('with more history than it can see, nothing is certain: an old copy never puts an old name back', async () => {
    const max = VERSIONS.max;
    VERSIONS.max = 10;
    try {
      const s = await open();
      const { api } = s.host;
      const [a] = s.itemIds;
      const v0 = JSON.parse(text(metaPath(s, a)));
      await api.updateItems([a], { name: 'Renamed by us' });
      for (let i = 0; i < 12; i++) await api.updateItems([a], { addTags: [`t${i}`] });
      // The partner's Eagle saves the item from the copy it has held all along (the old name),
      // with a tag of its own. Every version still in sight has our name.
      leaveCopy(s, a, { ...v0, tags: [...v0.tags, 'theirs'], lastModified: Date.now() });
      const live = text(metaPath(s, a));
      await api.refresh({ full: true });
      expect(text(metaPath(s, a))).toBe(live);
      const asked = (await conflictsOf(s)).find((c) => c.path === copyRel(a))?.questions;
      expect(asked?.map((q) => q.id)).toEqual(expect.arrayContaining(['name', 'tag:theirs']));
    } finally {
      VERSIONS.max = max;
    }
  });

  it('an undone merge is not taken again when the same values come back in a later copy', async () => {
    const s = await open();
    const { api } = s.host;
    const [a] = s.itemIds;
    const v1 = await taggedAndRenamed(s, a);
    await api.refresh({ full: true });
    expect(s.read(a).name).toBe('Renamed by Sam');
    await api.undo((await api.listHistory())[0].groupId); // not wanted
    await api.resolveConflict(copyRel(a), []); // and the copy is settled: keep everything
    // Their Eagle never showed the undo. It saves the item again, with its name and a note.
    const later = "metadata (Sam's conflicted copy 2026-09-29).json";
    writeFileSync(
      join(s.libPath, 'images', `${a}.info`, later),
      JSON.stringify({
        ...v1,
        name: 'Renamed by Sam',
        annotation: 'a note',
        lastModified: Date.now(),
      }),
    );
    await api.refresh({ full: true });
    expect(s.read(a)).toMatchObject({ name: v1.name, annotation: 'a note' });
    const found = (await conflictsOf(s)).find((c) => c.path.endsWith(later));
    expect(found?.questions?.map((q) => q.id).sort()).toEqual(['name', 'tag:x']);
  });

  it("a certain change that can't be made becomes a question, and settling says so", async () => {
    const s = await open();
    const { api } = s.host;
    const [a] = s.itemIds;
    await api.updateItems([a], { addTags: ['x'] });
    const live = s.read(a);
    // The partner renamed it to a name a file in the item's folder already has.
    writeFileSync(join(s.libPath, 'images', `${a}.info`, `Taken.${live.ext}`), 'another file');
    leaveCopy(s, a, { ...live, name: 'Taken', lastModified: Date.now() });
    const entries = (await api.listHistory()).length;
    await api.refresh({ full: true });
    expect(s.read(a).name).toBe(live.name);
    expect((await api.listHistory()).length).toBe(entries); // nothing was written, nothing is logged
    const found = (await conflictsOf(s)).find((c) => c.path === copyRel(a));
    expect(found?.questions).toMatchObject([{ id: 'name', copy: 'Taken' }]);

    const r = await api.resolveConflict(copyRel(a), ['name']);
    expect(r.changed).toBe(0);
    expect(r.skipped[0].reason).toMatch(/already exists/);
    expect(s.read(a).name).toBe(live.name);
    expect(existsSync(copyPath(s, a))).toBe(false);
    expect((await api.listHistory())[0].label).toMatch(/: kept everything as it is$/);
  });

  it('a file under a copy name that is not this item is left alone', async () => {
    const s = await open();
    const { api } = s.host;
    const [a, b] = s.itemIds;
    await api.updateItems([a], { addTags: ['x'] }); // history, so what the copy lacks would be certain
    writeFileSync(copyPath(s, a), '{}');
    leaveCopy(s, b, { ...s.read(a), lastModified: Date.now() }); // another item's record
    const [liveA, liveB] = [text(metaPath(s, a)), text(metaPath(s, b))];
    await api.refresh({ full: true });
    expect([text(metaPath(s, a)), text(metaPath(s, b))]).toEqual([liveA, liveB]);
    expect(existsSync(copyPath(s, a)) && existsSync(copyPath(s, b))).toBe(true);
  });

  it('refuses paths that are not a conflicted copy inside this library', async () => {
    const s = await open();
    const { api } = s.host;
    const [a] = s.itemIds;
    for (const bad of [
      '../metadata.json',
      '',
      `images/${a}.info/metadata.json`,
      `images/../${COPY}`,
      `images/${a}.info/../../${COPY}`,
      `images/${a}.info/some (Sam's conflicted copy 2026-09-28).json`,
      `/${copyRel(a)}`,
      `images\\${a}.info\\${COPY}`,
      `other/${a}.info/${COPY}`,
    ])
      await expect(api.resolveConflict(bad, [])).rejects.toThrow(
        /conflicted copy Boogie can settle/,
      );
  });

  it('leaves copies alone in a library that cannot be edited', async () => {
    const s = await open({ readOnly: true });
    const [a] = s.itemIds;
    leaveCopy(s, a, {
      ...JSON.parse(text(metaPath(s, a))),
      name: 'Renamed by Sam',
      lastModified: Date.now(),
    });
    const live = text(metaPath(s, a));
    await s.host.api.refresh({ full: true });
    expect(existsSync(copyPath(s, a))).toBe(true);
    expect(text(metaPath(s, a))).toBe(live);
    expect((await conflictsOf(s)).find((c) => c.path === copyRel(a))?.questions).toBeUndefined();
  });
});

describe.skipIf(!sandboxAvailable)('a conflicted copy of the root and of tags.json', () => {
  it('takes the rename and the new folder, asks about the folder it lacks, and settles on request', async () => {
    const s = await open();
    const { api } = s.host;
    const before = (await api.getLibraryState())!.folders.map((f) => `${f.id}=${f.name}`);
    const { id: hands } = await api.createFolder('Hands', null);
    const { id: feet } = await api.createFolder('Feet', null);
    // The partner's copy: saved from the root with only Hands, which it renamed, plus a folder of its own.
    const root = JSON.parse(text(join(s.libPath, 'metadata.json')));
    const copy = structuredClone(root);
    copy.folders = copy.folders.filter((f: { id: string }) => f.id !== feet);
    copy.folders.find((f: { id: string }) => f.id === hands).name = 'Hand studies';
    copy.folders.push({ ...copy.folders[0], id: 'MNEWFOLDER001', name: 'Faces', children: [] });
    copy.modificationTime = Date.now();
    const rel = "metadata (Sam's conflicted copy 2026-09-28).json";
    writeFileSync(join(s.libPath, rel), JSON.stringify(copy));
    await api.refresh(); // the watcher lists the copy, and the pass merges it
    await s.waitFor(() =>
      s.events.some(
        (e) => e.name === 'history' && /^Merged /.test((e.payload as { label: string }).label),
      ),
    );
    const folders = async () =>
      (await api.getLibraryState())!.folders.map((f) => `${f.id}=${f.name}`);
    // Faces goes where it is in the copy; Feet, which the copy lacks, stays.
    expect(await folders()).toEqual([
      ...before,
      `${hands}=Hand studies`,
      'MNEWFOLDER001=Faces',
      `${feet}=Feet`,
    ]);
    const found = (await conflictsOf(s)).find((c) => c.path === rel);
    expect(found?.questions).toEqual([
      { id: feet, label: 'Folder “Feet”', live: '“Feet”', copy: '(none)' },
    ]);
    expect((await api.listHistory())[0].label).toBe(
      "Merged Sam's conflicted copy of the folder list: took 2 changes; 1 question left",
    );

    // "Keep it" for the question: the copy goes out, the folder stays.
    const r = await api.resolveConflict(rel, []);
    expect(existsSync(join(s.libPath, rel))).toBe(false);
    expect(await folders()).toContain(`${feet}=Feet`);
    expect((await api.listHistory())[0]).toMatchObject({ groupId: r.groupId });
    expect(stored(s)).toHaveLength(1);
  });

  it('a folder move that would put a folder inside itself is asked about, never left hanging', async () => {
    const s = await open();
    const { api } = s.host;
    const { id: a } = await api.createFolder('A', null);
    const { id: b } = await api.createFolder('B', null);
    const base = JSON.parse(text(join(s.libPath, 'metadata.json')));
    await api.moveFolder(b, a, 0); // we put B inside A
    // The partner, from the same start, put A inside B.
    const copy = structuredClone(base);
    const movedA = copy.folders.find((f: { id: string }) => f.id === a);
    copy.folders = copy.folders.filter((f: { id: string }) => f.id !== a);
    copy.folders.find((f: { id: string }) => f.id === b).children.push(movedA);
    copy.modificationTime = Date.now();
    const rel = "metadata (Sam's conflicted copy 2026-09-28).json";
    writeFileSync(join(s.libPath, rel), JSON.stringify(copy));
    const live = text(join(s.libPath, 'metadata.json'));
    await api.refresh();
    let found: ConflictFile | undefined;
    await s.waitFor(() => {
      void conflictsOf(s).then((list) => (found = list.find((c) => c.path === rel)));
      return !!found?.questions;
    });
    // (Our own move is recent enough to be a base too, so it is a question as well.)
    expect(found!.questions).toContainEqual({
      id: a,
      label: 'Folder “A”',
      live: 'at the top level',
      copy: 'inside “B”',
    });
    expect(text(join(s.libPath, 'metadata.json'))).toBe(live);

    const r = await api.resolveConflict(rel, [a]);
    expect(r.skipped[0].reason).toBe("Folder “A” couldn't be taken from the copy.");
    expect(text(join(s.libPath, 'metadata.json'))).toBe(live);
    expect(existsSync(join(s.libPath, rel))).toBe(false);
  });

  it('tags.json: a starred tag the old copy lacks is a question, and answering takes the copy', async () => {
    const s = await open();
    const { api } = s.host;
    await api.setTagStarred(['a'], true); // in the journal: the file before and after
    const tagsPath = join(s.libPath, 'tags.json');
    const ours = JSON.parse(text(tagsPath));
    const rel = "tags (Sam's conflicted copy 2026-09-28).json";
    writeFileSync(join(s.libPath, rel), JSON.stringify({ ...ours, starredTags: [] })); // saved before the star
    await api.refresh();
    let found: ConflictFile | undefined;
    await s.waitFor(() => {
      void conflictsOf(s).then((list) => (found = list.find((c) => c.path === rel)));
      return !!found?.questions;
    }, 5000);
    expect(found!.questions).toEqual([
      { id: 'starred:a', label: 'Starred tag “a”', live: 'a', copy: '(none)' },
    ]);
    expect(JSON.parse(text(tagsPath)).starredTags).toEqual(['a']); // the library's list is untouched

    const r = await api.resolveConflict(rel, ['starred:a']);
    expect(JSON.parse(text(tagsPath)).starredTags).toEqual([]);
    expect(existsSync(join(s.libPath, rel))).toBe(false);
    await api.undo(r.groupId!);
    expect(JSON.parse(text(tagsPath)).starredTags).toEqual(['a']);
  });
});

describe.skipIf(!sandboxAvailable)('tidying copies that hold nothing', () => {
  it('moves thumbnail and mtime copies to the store in one History entry, once Dropbox is done with them', async () => {
    let busy = true;
    const asked: string[][] = [];
    const s = await open({
      shared: true,
      partner: 'Sam',
      deps: {
        dropbox: {
          check: async () => ({ state: 'idle', detail: 'Up to date' }),
          fileStatus: async (paths) => {
            asked.push(paths);
            return Object.fromEntries(paths.map((p) => [p, busy ? 'syncing' : 'upToDate']));
          },
        },
      },
    });
    const { api } = s.host;
    const [a, b, c] = s.itemIds;
    const thumb = (id: string) => {
      const name = s.read(id).name;
      return join(s.libPath, 'images', `${id}.info`, `${name}_thumbnail.png`);
    };
    const thumbCopy = (id: string) =>
      join(
        s.libPath,
        'images',
        `${id}.info`,
        `${s.read(id).name}_thumbnail (Sam's conflicted copy 2026-09-28).png`,
      );
    for (const id of [a, b, c]) writeFileSync(thumbCopy(id), 'png bytes');
    writeFileSync(thumb(a), 'webp bytes');
    writeFileSync(thumb(b), 'webp bytes');
    writeFileSync(thumb(c), ''); // c's own thumbnail is empty: its copy is the one worth keeping
    const mtimeCopy = join(s.libPath, "mtime (Sam's conflicted copy 2026-09-28).json");
    writeFileSync(mtimeCopy, '{"all":0}');
    const entries = (await api.listHistory()).length;

    await api.refresh(); // the watcher lists the copy at the root
    await s.waitFor(() => existsSync(mtimeCopy));
    await api.refresh({ full: true }); // and the scan lists the ones in item folders
    // Still syncing: nothing is touched yet.
    expect(existsSync(thumbCopy(a)) && existsSync(mtimeCopy)).toBe(true);
    expect(asked.length).toBeGreaterThan(0);

    busy = false;
    await api.refresh({ full: true });
    expect(existsSync(thumbCopy(a)) || existsSync(thumbCopy(b)) || existsSync(mtimeCopy)).toBe(
      false,
    );
    expect(existsSync(thumbCopy(c))).toBe(true); // no usable live thumbnail: left listed, untouched
    const history = await api.listHistory();
    expect(history).toHaveLength(entries + 1);
    expect(history[0]).toMatchObject({
      label: 'Tidied 3 conflicted copies (nothing new in them)',
      actor: { kind: 'system' },
    });
    expect(stored(s)).toHaveLength(3);
    expect((await conflictsOf(s)).map((x) => x.path)).toEqual([
      `images/${c}.info/${s.read(c).name}_thumbnail (Sam's conflicted copy 2026-09-28).png`,
    ]);
  });
});

describe.skipIf(!sandboxAvailable)('copies that only differ in noise', () => {
  afterEach(() => vi.useRealTimers());

  it('are tidied: the same item with its own stamps, and an old snapshot of an item edited since', async () => {
    // The journal reads the (faked) clock at each call.
    const s = await open({
      deps: { createJournal: (o) => createJournal({ ...o, now: () => Date.now() }) },
    });
    const { api } = s.host;
    const [a, b] = s.itemIds;
    // a: the partner's save of exactly what we have, with its own stamps and palette.
    leaveCopy(s, a, {
      ...s.read(a),
      lastModified: Date.now(),
      mtime: 1,
      palettes: [],
      processingPalette: true,
    });
    // b: saved by the partner after our first edit, and before the second one (ten minutes
    // later, so that edit is no base for it). The copy lacks only what came after.
    const clock = Date.now();
    vi.useFakeTimers({ toFake: ['Date'], now: clock });
    await api.updateItems([b], { addTags: ['one'] });
    vi.setSystemTime(clock + 60_000);
    leaveCopy(s, b, { ...s.read(b), lastModified: clock + 60_000 });
    vi.setSystemTime(clock + 10 * 60_000);
    await api.updateItems([b], { addTags: ['two'] });
    const live = text(metaPath(s, b));
    await api.refresh({ full: true });

    expect(existsSync(copyPath(s, a)) || existsSync(copyPath(s, b))).toBe(false);
    expect(text(metaPath(s, b))).toBe(live);
    expect((await api.listHistory())[0]).toMatchObject({
      label: 'Tidied 2 conflicted copies (nothing new in them)',
      undoable: false,
    });
    expect(stored(s)).toHaveLength(2);
  });
});

describe.skipIf(!sandboxAvailable)('a write to the root files of a shared library', () => {
  const { maxMs, pollMs } = SETTLE;
  afterEach(() => Object.assign(SETTLE, { maxMs, pollMs }));

  let answers: ('syncing' | 'upToDate' | 'unknown')[] = [];
  let calls: string[] = [];
  const shared = () =>
    open({
      shared: true,
      partner: 'Sam',
      deps: {
        dropbox: {
          check: async () => ({ state: 'idle', detail: 'Up to date' }),
          fileStatus: async (paths) => {
            calls.push(...paths);
            return Object.fromEntries(paths.map((p) => [p, answers.shift() ?? 'syncing']));
          },
        },
      },
    });
  const asked = (file: string) => calls.filter((p) => p.endsWith(file)).length;

  it('waits for Dropbox while the file is syncing, but never for its own upload or when Dropbox cannot say', async () => {
    SETTLE.pollMs = 5;
    const s = await shared();
    answers = ['syncing', 'syncing', 'upToDate'];
    calls = [];
    await s.host.api.createFolder('Waited for', null);
    expect(asked('metadata.json')).toBe(3);

    // A second folder edit right after: what Dropbox is busy with is our own write, so no wait.
    answers = [];
    calls = [];
    await s.host.api.createFolder('Did not wait', null);
    expect(asked('metadata.json')).toBe(0);

    answers = ['unknown'];
    await s.host.api.setTagStarred(['a'], true);
    expect(asked('tags.json')).toBe(1);
  });

  it('gives up at the limit and writes anyway, and then stops waiting for a while', async () => {
    Object.assign(SETTLE, { pollMs: 5, maxMs: 40 });
    const s = await shared();
    answers = [];
    calls = [];
    const folder = await s.host.api.createFolder('Written anyway', null);
    expect(folder.id).toBeTruthy();
    expect(asked('metadata.json')).toBeGreaterThan(1);
    // Dropbox isn't getting anywhere: the next edit of the other file doesn't stand still too.
    await s.host.api.setTagStarred(['a'], true);
    expect(asked('tags.json')).toBe(0);
  });
});
