// Sync safety on the REAL core (adapter, index, journal, watcher) against a sandbox copy, with
// the partner's running Eagle played by a small model that does what background.js does (read for
// behavior only): its window shows the records it loaded; a save writes the whole record from
// memory with lastModified = its Date.now(); ~3 s later it rewrites mtime.json from its memory;
// its poll re-reads an item only when the mtime.json value went up, and skips one less than
// 500 ms behind its own clock. Scenarios: test/eagle-proof FINDINGS(-2), .tmp/review4-core probes.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EagleItemRecord, HistoryEntry } from '../../shared/types';
import { createCoreHost } from './index';
import { CLOCK_RULES, PARTNER_TIMING } from './partner';
import { eagleNow, openSandbox, sandboxAvailable, type Sandbox } from './testSandbox';

let sb: Sandbox | null = null;
const closers: (() => Promise<void>)[] = [];
const timing = { ...PARTNER_TIMING, recheckAfterMs: [...PARTNER_TIMING.recheckAfterMs] };
const clockRules = { ...CLOCK_RULES };
afterEach(async () => {
  Object.assign(PARTNER_TIMING, timing, { recheckAfterMs: [...timing.recheckAfterMs] });
  Object.assign(CLOCK_RULES, clockRules);
  for (const close of closers.splice(0)) await close();
  await sb?.close();
  sb = null;
});
const shared = async (opts: Parameters<typeof openSandbox>[0] = {}) =>
  (sb = await openSandbox({
    area: 'sync-safety-2',
    shared: true,
    partner: 'Sam',
    completeMtime: true,
    ...opts,
  }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const history = async (s: Sandbox) => s.host.api.listHistory();
const mtimeOf = (s: Sandbox) =>
  JSON.parse(readFileSync(join(s.libPath, 'mtime.json'), 'utf8')) as Record<string, number>;
const flushed = (s: Sandbox, id: string) =>
  s.waitFor(() => mtimeOf(s)[id] === s.read(id).lastModified, 5000);
async function until<T>(s: Sandbox, get: () => Promise<T | undefined | null | false>, ms = 10_000) {
  let got: T | undefined | null | false;
  const end = Date.now() + ms;
  while (!(got = await get())) {
    if (Date.now() > end)
      throw new Error(
        `timed out; history: ${JSON.stringify((await history(s)).map((h) => [h.actor.name, h.label, h.staleOverwrite ?? false]))}`,
      );
    await sleep(25);
  }
  return got as T;
}
const entry = (s: Sandbox, pred: (h: HistoryEntry) => boolean, ms?: number) =>
  until(s, async () => (await history(s)).find(pred), ms);
const repairs = async (s: Sandbox) => (await history(s)).filter((h) => h.actor.kind === 'system');

/** The partner's running Eagle (see the top of the file). `skewMs`: its clock minus ours. */
class PartnersEagle {
  map: Record<string, number> = {};
  shown = new Map<string, string>();
  constructor(
    private readonly s: Sandbox,
    private readonly skewMs = 0,
  ) {
    this.start();
  }
  now = () => eagleNow(Date.now() + this.skewMs);
  private file = (id: string) => join(this.s.libPath, 'images', `${id}.info`, 'metadata.json');
  /** A (cached) start: its memory from mtime.json, its window from the files as they are now. */
  start(): void {
    const { all: _all, ...map } = mtimeOf(this.s);
    this.map = map;
    for (const id of this.s.itemIds) this.shown.set(id, readFileSync(this.file(id), 'utf8'));
  }
  /** A cached start (FINDINGS 1): memory adopts mtime.json, the window keeps its old copies. */
  cachedStart(): void {
    const { all: _all, ...map } = mtimeOf(this.s);
    this.map = map;
  }
  /** Its 4 s poll of mtime.json. */
  poll(): { reread: string[]; skipped: string[] } {
    const out = { reread: [] as string[], skipped: [] as string[] };
    for (const [id, v] of Object.entries(mtimeOf(this.s))) {
      if (id === 'all') continue;
      const known = this.map[id];
      if (known !== undefined && !(v > known)) continue;
      this.map[id] = v;
      if (known !== undefined && this.now() - v < 500) {
        out.skipped.push(id); // "prevent triggering itself"
        continue;
      }
      this.shown.set(id, readFileSync(this.file(id), 'utf8'));
      out.reread.push(id);
    }
    return out;
  }
  /** The partner edits an item in their window. */
  save(id: string, edit: (rec: EagleItemRecord) => void): void {
    const rec = JSON.parse(this.shown.get(id)!) as EagleItemRecord;
    edit(rec);
    rec.lastModified = this.now();
    const text = JSON.stringify(rec);
    writeFileSync(this.file(id), text);
    this.shown.set(id, text);
    this.map[id] = rec.lastModified;
  }
  /** ~3 s after a save: mtime.json from its memory. */
  rewriteMtime(): void {
    const all = mtimeOf(this.s).all;
    writeFileSync(join(this.s.libPath, 'mtime.json'), JSON.stringify({ ...this.map, all }));
  }
}

const setRoot = (s: Sandbox, edit: (root: Record<string, any>) => void) => {
  const path = join(s.libPath, 'metadata.json');
  const root = JSON.parse(readFileSync(path, 'utf8'));
  edit(root);
  writeFileSync(path, JSON.stringify(root));
};

describe.skipIf(!sandboxAvailable)("The partner's Eagle writes over a change of yours", () => {
  it('an old copy with an edit of theirs: logged as "may have written", counted in the status, never repaired by itself', async () => {
    const s = await shared();
    const [a] = s.itemIds;
    const eagle = new PartnersEagle(s); // its window keeps the old copy (FINDINGS 1)
    await s.host.api.updateItems([a], { addTags: ['mine'] });
    expect((await s.host.api.getStatus()).partner).toMatchObject({ active: false, pending: 1 });
    eagle.save(a, (r) => (r.star = 5));
    eagle.rewriteMtime();
    const name = JSON.parse(eagle.shown.get(a)!).name;
    const stale = await entry(s, (h) => !!h.staleOverwrite);
    expect(stale.label).toBe(
      `Sam's Eagle may have written an old copy over your change to “${name}”`,
    );
    await sleep(1500);
    expect(await repairs(s)).toEqual([]);
    expect(s.read(a).tags).not.toContain('mine');
    expect((await s.host.api.getStatus()).partner?.oldCopies).toBe(1);
    await s.host.api.undo(stale.groupId); // "Put my change back"
    expect(s.read(a)).toMatchObject({ star: 5, tags: expect.arrayContaining(['mine']) });
    expect((await history(s))[0]!.label).toBe(`Put back your change to “${name}”`);
    expect((await s.host.api.getStatus()).partner?.oldCopies).toBeUndefined();
  });

  it('"Keep Sam\'s" leaves their version, survives reopening, and clears the notice', async () => {
    const s = await shared();
    const [a] = s.itemIds;
    const eagle = new PartnersEagle(s);
    await s.host.api.updateItems([a], { addTags: ['mine'] });
    eagle.save(a, (r) => (r.star = 5));
    eagle.rewriteMtime();
    const stale = await entry(s, (h) => !!h.staleOverwrite);
    const onDisk = readFileSync(join(s.libPath, 'images', `${a}.info`, 'metadata.json'), 'utf8');
    await s.host.api.keepTheirs(stale.groupId);
    expect(readFileSync(join(s.libPath, 'images', `${a}.info`, 'metadata.json'), 'utf8')).toBe(
      onDisk,
    );
    expect((await s.host.api.getStatus()).partner?.oldCopies).toBeUndefined();
    await s.host.api.openLibrary(s.libPath); // reopening: the choice is in the journal
    const again = (await history(s)).find((h) => h.groupId === stale.groupId);
    expect(again).toMatchObject({ staleOverwrite: true, keptTheirs: true });
    expect((await s.host.api.getStatus()).partner?.oldCopies).toBeUndefined();
    const plain = (await history(s)).find((h) => !h.staleOverwrite)!;
    await expect(s.host.api.keepTheirs(plain.groupId)).rejects.toThrow(/may have been overwritten/);
  });

  it('their deliberate replacements are only offered (review5 must-fix 1: Q1a, Q1b)', async () => {
    const s = await shared();
    const [a, b, c] = s.itemIds;
    const anatomy = (await s.host.api.createFolder('Anatomy', null)).id;
    const figure = (await s.host.api.createFolder('Figure', null)).id;
    const eagle = new PartnersEagle(s);
    await s.host.api.updateItems([a], { addTags: ['wip'] });
    await s.host.api.updateItems([b], { addFolders: [anatomy] });
    await flushed(s, a);
    await flushed(s, b);
    await sleep(700);
    expect(eagle.poll().reread).toEqual(expect.arrayContaining([a, b]));
    eagle.save(a, (r) => (r.tags = r.tags.map((t) => (t === 'wip' ? 'in-progress' : t)))); // rename
    eagle.save(b, (r) => (r.folders = r.folders.filter((f) => f !== anatomy).concat(figure))); // move
    eagle.save(c, (r) => (r.star = 1));
    eagle.rewriteMtime();
    await entry(s, (h) => !!h.staleOverwrite && h.itemIds.includes(a));
    await entry(s, (h) => !!h.staleOverwrite && h.itemIds.includes(b));
    await sleep(2000);
    expect(await repairs(s)).toEqual([]);
    expect(s.read(a).tags).toContain('in-progress');
    expect(s.read(a).tags).not.toContain('wip');
    expect(s.read(b).folders).not.toContain(anatomy);
    expect((await history(s)).filter((h) => h.staleOverwrite).map((h) => h.label)).toEqual([
      "Sam's Eagle may have written an old copy over your changes to 2 items",
    ]);
  });

  it('a deliberate revert while their Eagle runs is logged with the button, never repaired (R2-1, P1, P10)', async () => {
    const s = await shared();
    const [a, b] = s.itemIds;
    const eagle = new PartnersEagle(s);
    await s.host.api.updateItems([a], { addTags: ['wip'] });
    await flushed(s, a);
    expect(eagle.poll().reread).toEqual([a]); // their window shows the tag
    eagle.save(a, (r) => (r.tags = r.tags.filter((t) => t !== 'wip'))); // they remove it on purpose
    eagle.rewriteMtime();
    const e = await entry(s, (h) => !!h.staleOverwrite);
    const name = JSON.parse(eagle.shown.get(a)!).name;
    expect(e.label).toBe(`Sam's Eagle may have written an old copy over your change to “${name}”`);
    await sleep(1500);
    expect(s.read(a).tags).not.toContain('wip');
    expect(await repairs(s)).toEqual([]);

    // The same for a restore of an item you trashed (P2).
    await s.host.api.trashItems([b]);
    await flushed(s, b);
    eagle.poll();
    eagle.save(b, (r) => (r.isDeleted = false));
    eagle.rewriteMtime();
    await entry(s, (h) => !!h.staleOverwrite && h.itemIds.includes(b));
    await sleep(1500);
    expect(s.read(b).isDeleted).toBe(false);
    expect(await repairs(s)).toEqual([]);

    // The button puts yours back, if you want it.
    await s.host.api.undo(e.groupId);
    expect(s.read(a).tags).toContain('wip');
  });

  it('once their Eagle saved the item with your change in it, their later revert is a plain edit', async () => {
    const s = await shared();
    const [a] = s.itemIds;
    const eagle = new PartnersEagle(s);
    await s.host.api.updateItems([a], { addTags: ['mine'] });
    await flushed(s, a);
    eagle.poll();
    eagle.save(a, (r) => (r.star = 1)); // keeps your tag: their Eagle has your version
    eagle.rewriteMtime();
    await until(s, async () => (await s.host.api.getStatus()).partner?.pending === 0);
    eagle.save(a, (r) => (r.tags = r.tags.filter((t) => t !== 'mine')));
    eagle.rewriteMtime();
    await entry(s, (h) => h.label === 'Sam edited 1 item' && (h.at ?? 0) > 0, 10_000);
    await until(s, async () => !s.read(a).tags.includes('mine'));
    await sleep(1000);
    expect((await history(s)).some((h) => h.staleOverwrite)).toBe(false);
  });

  it('seen through their rewrite from memory: no longer waiting, and even a revert with an edit is only offered', async () => {
    const s = await shared();
    const [a, b] = s.itemIds;
    const eagle = new PartnersEagle(s);
    eagle.save(b, (r) => (r.star = 3)); // they are working
    eagle.rewriteMtime();
    await until(s, async () => (await s.host.api.getStatus()).partner?.active);
    await s.host.api.updateItems([a], { addTags: ['mine'] });
    await flushed(s, a);
    expect(eagle.poll().reread).toContain(a);
    eagle.save(b, (r) => (r.star = 4));
    eagle.rewriteMtime(); // holds exactly our value for a
    await until(s, async () => (await s.host.api.getStatus()).partner?.pending === 0);
    // Two saves of theirs that Dropbox delivered as one: the tag removed, a rating set.
    eagle.save(a, (r) => ((r.tags = r.tags.filter((t) => t !== 'mine')), (r.star = 5)));
    eagle.rewriteMtime();
    const e = await entry(s, (h) => !!h.staleOverwrite);
    expect(e.label).toMatch(/may have written an old copy/);
    await sleep(1500);
    expect(await repairs(s)).toEqual([]);
  });

  it('an Eagle that quit is not "seen": the edit still reaches their window at their next start (review5 must-fix 2, Q2)', async () => {
    PARTNER_TIMING.activeMs = 4000;
    const s = await shared();
    const [a, b, c] = s.itemIds;
    const eagle = new PartnersEagle(s);
    eagle.save(b, (r) => (r.star = 3)); // their last save, then they quit (mtime.json rewritten)
    eagle.rewriteMtime();
    await until(s, async () => (await s.host.api.getStatus()).partner?.active);
    await sleep(1000);
    await s.host.api.updateItems([a], { addTags: ['mine'] }); // just after they quit
    await flushed(s, a);
    await sleep(5000); // the night
    eagle.cachedStart(); // memory adopts mtime.json, the window keeps its old copy of a
    eagle.save(c, (r) => (r.star = 2));
    eagle.rewriteMtime(); // holds our value for a, from memory only
    await sleep(3000);
    expect((await s.host.api.getStatus()).partner?.pending).toBe(1);
    expect(eagle.poll().reread).toContain(a); // re-sent into their window
    eagle.save(a, (r) => (r.star = 4));
    expect(s.read(a).tags).toContain('mine');
  });

  it('quick folder writes right after theirs never push a stamp into their future (FINDINGS-3 R3-1)', async () => {
    const s = await shared();
    const [a, b] = s.itemIds;
    const eagle = new PartnersEagle(s);
    eagle.save(b, (r) => (r.star = 3));
    eagle.rewriteMtime();
    await until(s, async () => (await s.host.api.getStatus()).partner?.active);
    setRoot(s, (root) => (root.modificationTime = eagle.now())); // they created a folder
    await sleep(2500);
    let last = '';
    for (let i = 0; i < 20; i++) last = (await s.host.api.createFolder(`Quick ${i}`, null)).id;
    await s.host.api.updateItems([a], { addTags: ['mine'], addFolders: [last] });
    await flushed(s, a);
    const now = Date.now();
    const rootTime = JSON.parse(readFileSync(join(s.libPath, 'metadata.json'), 'utf8'))
      .modificationTime as number;
    expect(now - rootTime).toBeGreaterThanOrEqual(1000);
    expect(now - s.read(a).lastModified!).toBeGreaterThanOrEqual(1000);
    await sleep(600);
    expect(eagle.poll()).toMatchObject({ skipped: [], reread: expect.arrayContaining([a]) });
  });
});

describe.skipIf(!sandboxAvailable)('re-sending never loses an outside write', () => {
  it('their racing old copy, then their rewrite from memory: logged, the UI told, and the button puts it right (review4 must-fix 2, P4)', async () => {
    const s = await shared();
    const [a] = s.itemIds;
    const base = s.read(a);
    await s.host.api.updateItems([a], { addTags: ['mine'] });
    await flushed(s, a);
    const mark = s.events.length;
    // Their Eagle saved its old copy with their rating right after us, skipping its mtime.json
    // update (FINDINGS 3); ~3 s later it rewrote mtime.json from memory, a back to its old value.
    const theirs = { ...base, star: 5, lastModified: eagleNow() };
    writeFileSync(join(s.libPath, 'images', `${a}.info`, 'metadata.json'), JSON.stringify(theirs));
    await sleep(2500);
    s.rewriteMtimeAsEagle({ [a]: base.lastModified! });
    const stale = await entry(s, (h) => !!h.staleOverwrite);
    await s.host.api.undo(stale.groupId); // "Put my change back"
    expect(s.read(a).tags).toContain('mine');
    expect(s.read(a).star).toBe(5);
    expect((await s.host.api.getItem(a))?.tags).toContain('mine');
    const told = s.events
      .slice(mark)
      .some((e) => e.name === 'itemsChanged' && (e.payload as { ids: string[] }).ids.includes(a));
    expect(told).toBe(true);
  });

  it('their mtime.json arriving before their file: no re-send over it, and their old copy is caught when it lands (review4 must-fix 9, P3)', async () => {
    const s = await shared();
    const [a] = s.itemIds;
    const base = s.read(a);
    await s.host.api.updateItems([a], { addTags: ['mine'] });
    await flushed(s, a);
    const ours = s.read(a).lastModified!;
    const V = eagleNow(Math.max(Date.now(), ours + 1));
    s.rewriteMtimeAsEagle({ [a]: V }); // their raise; it also says their Eagle is running
    await sleep(3500);
    expect(s.read(a).lastModified).toBe(ours); // not touched
    const theirs = { ...base, star: 5, lastModified: V };
    writeFileSync(join(s.libPath, 'images', `${a}.info`, 'metadata.json'), JSON.stringify(theirs));
    const stale = await entry(s, (h) => !!h.staleOverwrite);
    expect(stale.label).toMatch(/^Sam's Eagle may have written an old copy/);
    await s.host.api.undo(stale.groupId);
    expect(s.read(a).tags).toContain('mine');
    expect(s.read(a).star).toBe(5);
  });

  it('an Eagle that keeps putting a raise back gets it at most 3 times, then a warning (review4 should-fix 1, P5)', async () => {
    const s = await shared();
    const [a, b] = s.itemIds;
    const eagle = new PartnersEagle(s); // never polls: it keeps its old value for a
    await s.host.api.updateItems([a], { addTags: ['mine'] });
    await flushed(s, a);
    const ours = s.read(a).lastModified!;
    let resent = 0;
    for (let i = 0; i < 6; i++) {
      eagle.save(b, (r) => (r.star = (i % 5) + 1));
      eagle.rewriteMtime(); // a back to their old value
      for (let j = 0; j < 20; j++) {
        await sleep(100);
        if (mtimeOf(s)[a] === ours) {
          resent++; // our value is back in mtime.json (a re-raise: the item isn't rewritten)
          break;
        }
      }
    }
    expect(resent).toBe(3);
    expect(s.read(a).lastModified).toBe(ours);
    expect((await s.host.api.getStatus()).writeProblem).toBe(
      "Sam's Eagle isn't picking up 1 of your changes. Ask Sam to restart Eagle.",
    );
  });

  it('new items their rewrite kept are left alone; ones it dropped go back in mtime.json (R2-5, review5 should-fix 3)', async () => {
    const s = await shared();
    const [, b] = s.itemIds;
    const originals = readdirSync(join(s.libPath, 'images'))
      .flatMap((d) =>
        readdirSync(join(s.libPath, 'images', d)).map((f) => join(s.libPath, 'images', d, f)),
      )
      .filter((f) => f.endsWith('.jpg'));
    const files = originals.slice(0, 4).map((f, i) => {
      const to = join(s.dir, `new${i}.jpg`);
      copyFileSync(f, to);
      return to;
    });
    const eagle = new PartnersEagle(s);
    const job = await s.job((await s.host.api.importPaths(files.slice(0, 2))).jobId);
    const kept = (job.result as { added: string[] }).added;
    for (const id of kept) await flushed(s, id);
    eagle.poll(); // their Eagle read the new items
    const lm = new Map(kept.map((id) => [id, s.read(id).lastModified]));
    eagle.save(b, (r) => (r.star = 2));
    eagle.rewriteMtime();
    await sleep(3000);
    expect(kept.filter((id) => s.read(id).lastModified !== lm.get(id))).toEqual([]);

    const job2 = await s.job((await s.host.api.importPaths(files.slice(2))).jobId);
    const dropped = (job2.result as { added: string[] }).added;
    for (const id of dropped) await flushed(s, id);
    const lm2 = new Map(dropped.map((id) => [id, s.read(id).lastModified]));
    eagle.save(b, (r) => (r.star = 3));
    eagle.rewriteMtime(); // from memory: it never saw these, so they are gone from mtime.json
    await s.waitFor(() => dropped.every((id) => mtimeOf(s)[id] !== undefined), 8000);
    expect(dropped.filter((id) => s.read(id).lastModified !== lm2.get(id))).toEqual([]);
    expect(eagle.poll().reread).toEqual(expect.arrayContaining(dropped));
  });
});

describe.skipIf(!sandboxAvailable)('clocks (R2-2)', () => {
  it("our clock 30 s ahead of theirs: their Eagle doesn't skip the edit, and it survives their next save", async () => {
    const s = await shared();
    const [a] = s.itemIds;
    const eagle = new PartnersEagle(s, -30_000);
    await s.host.api.updateItems([a], { addTags: ['mine'] });
    await flushed(s, a);
    expect(eagle.poll()).toEqual({ reread: [a], skipped: [] });
    eagle.save(a, (r) => (r.star = 5));
    expect(s.read(a).tags).toContain('mine');
  });

  it('their clock 5 minutes behind: still seen as running, and the status says so', async () => {
    CLOCK_RULES.minSpreadMs = 0;
    const s = await shared();
    const [, b] = s.itemIds;
    const eagle = new PartnersEagle(s, -5 * 60_000);
    for (let i = 1; i <= 3; i++) {
      eagle.save(b, (r) => (r.star = i));
      eagle.rewriteMtime();
      await until(s, async () => (await s.host.api.getItem(b))?.star === i);
    }
    const st = await s.host.api.getStatus();
    expect(st.partner?.active).toBe(true);
    expect(st.writeProblem).toMatch(/^Sam's computer clock seems about 5 minutes behind yours/);
  });
});

describe.skipIf(!sandboxAvailable)(
  'another Boogie on the same library (one user on two machines)',
  () => {
    it('its touches are not logged, its edits are named as such, and it is not the partner Eagle (should-fix 3, P6)', async () => {
      const s = await shared();
      const home = join(s.dir, 'homeB');
      mkdirSync(join(home, 'config'), { recursive: true });
      writeFileSync(join(home, 'config/settings.json'), JSON.stringify({ writableRoots: [s.dir] }));
      const hostB = await createCoreHost({
        paths: {
          config: join(home, 'config'),
          cache: join(home, 'cache'),
          data: join(home, 'data'),
          tmp: join(home, 'cache/tmp'),
        },
        deps: {
          eagleMonitor: { check: async () => ({ running: false, openLibraryPath: null }) },
          dropbox: { check: async () => ({ state: 'idle', detail: 'Up to date' }) },
        },
        discovery: { home: s.dir, settingsFiles: [], dropboxDir: join(s.dir, 'no-dropbox') },
      });
      closers.push(() => hostB.close());
      await hostB.api.addLibrary(s.libPath);
      await hostB.api.setLibraryOptions(s.libPath, { partnerName: 'Sam', shared: true });
      await hostB.api.openLibrary(s.libPath);
      await hostB.api.refresh({ full: true });

      const [x, y] = s.itemIds;
      await s.host.api.updateItems([x], { addTags: ['fromA'] });
      await hostB.api.updateItems([y], { addTags: ['fromB'] });
      const onA = await entry(s, (h) => h.itemIds.includes(y) && h.actor.kind === 'external');
      expect(onA).toMatchObject({
        actor: { kind: 'external', name: 'Boogie on another computer' },
        label: 'Boogie on another computer edited 1 item',
      });
      const onB = await until(s, async () =>
        (await hostB.api.listHistory()).find(
          (h) => h.itemIds.includes(x) && h.actor.kind === 'external',
        ),
      );
      expect(onB.actor.name).toBe('Boogie on another computer');
      await sleep(3000);
      for (const api of [s.host.api, hostB.api]) {
        expect((await api.getStatus()).partner?.active).toBe(false);
        expect((await api.listHistory()).filter((h) => h.actor.name === 'Sam')).toEqual([]);
      }
    });
  },
);

describe.skipIf(!sandboxAvailable)(
  'a Boogie on another computer, unmarked (review6 must-fix 2)',
  () => {
    it("its write right after the partner's folder change is its own: our change stays protected", async () => {
      const s = await shared();
      const home = join(s.dir, 'homeB2');
      mkdirSync(join(home, 'config'), { recursive: true });
      writeFileSync(join(home, 'config/settings.json'), JSON.stringify({ writableRoots: [s.dir] }));
      const hostB = await createCoreHost({
        paths: {
          config: join(home, 'config'),
          cache: join(home, 'cache'),
          data: join(home, 'data'),
          tmp: join(home, 'cache/tmp'),
        },
        deps: {
          eagleMonitor: { check: async () => ({ running: false, openLibraryPath: null }) },
          dropbox: { check: async () => ({ state: 'idle', detail: 'Up to date' }) },
        },
        discovery: { home: s.dir, settingsFiles: [], dropboxDir: join(s.dir, 'no-dropbox') },
      });
      closers.push(() => hostB.close());
      await hostB.api.addLibrary(s.libPath);
      await hostB.api.setLibraryOptions(s.libPath, { partnerName: 'Sam', shared: true });
      await hostB.api.openLibrary(s.libPath);
      await hostB.api.refresh({ full: true });

      const [x] = s.itemIds;
      const original = s.read(x); // what the partner's Eagle window still shows (a cached start)
      await s.host.api.updateItems([x], { addTags: ['fromA'] });
      await sleep(2500);
      expect((await s.host.api.getStatus()).partner?.pending).toBe(1);
      // The partner's Eagle creates a folder (its root save stamps its Date.now()).
      setRoot(s, (root) => {
        root.folders.push({
          id: 'MPARTNERFLDR1',
          name: 'Sam new',
          description: '',
          children: [],
          modificationTime: Date.now(),
          tags: [],
          password: '',
          passwordTips: '',
        });
        root.modificationTime = eagleNow();
      });
      await sleep(1500); // both Boogies take the root in
      // The user on machine B files x into it a moment later: B's stamp is the root time + 1, unmarked.
      await hostB.api.updateItems([x], { addFolders: ['MPARTNERFLDR1'] });
      await sleep(6000);
      const statusA = (await s.host.api.getStatus()).partner;
      expect(statusA?.pending).toBe(1); // still waiting for the partner's Eagle
      const onA = (await history(s)).find(
        (h) => h.itemIds.includes(x) && h.actor.kind === 'external',
      );
      expect(onA?.actor.name).toBe('Boogie on another computer');
      // The partner's Eagle, still on its old copy, rates x: A offers its change back.
      const theirs = { ...original, star: 5, lastModified: eagleNow() };
      writeFileSync(
        join(s.libPath, 'images', `${x}.info`, 'metadata.json'),
        JSON.stringify(theirs),
      );
      s.rewriteMtimeAsEagle({ [x]: theirs.lastModified });
      const stale = await entry(s, (h) => !!h.staleOverwrite && h.itemIds.includes(x));
      await s.host.api.undo(stale.groupId);
      expect(s.read(x).tags).toContain('fromA');
    });
  },
);

describe.skipIf(!sandboxAvailable)('resolving, and undo', () => {
  it('"Keep theirs" works while the library is read-only (it writes nothing there)', async () => {
    let eagleHere = false;
    const s = await shared({
      eagleMonitor: {
        check: async () => ({
          running: eagleHere,
          openLibraryPath: eagleHere ? (sb?.libPath ?? null) : null,
        }),
      },
    });
    const [a] = s.itemIds;
    const eagle = new PartnersEagle(s);
    await s.host.api.updateItems([a], { addTags: ['mine'] });
    eagleHere = true; // Eagle opened this library on this computer: read-only here
    await s.host.api.refresh();
    expect((await s.host.api.getLibraryState())?.readOnly).toBe(true);
    eagle.save(a, (r) => (r.star = 5));
    eagle.rewriteMtime();
    const stale = await entry(s, (h) => !!h.staleOverwrite);
    await s.host.api.keepTheirs(stale.groupId);
    expect((await history(s)).find((h) => h.groupId === stale.groupId)?.keptTheirs).toBe(true);
    expect(s.read(a).tags).not.toContain('mine');
  });

  it('starring a tag can be undone (tags.json)', async () => {
    const s = await shared();
    await s.host.api.setTagStarred(['cat'], true);
    expect((await s.host.api.getLibraryState())?.starredTags).toContain('cat');
    await s.host.api.undo();
    expect((await s.host.api.getLibraryState())?.starredTags ?? []).not.toContain('cat');
  });

  it('thumbnails: undo and redo of a custom one, and undo of a refresh over it (review6 must-fix 1)', async () => {
    const s = await shared();
    const a = 'MKG8VYYQTA5SW'; // sample items (real copy and generated fixture alike)
    const thumbOf = (id: string) => {
      const dir = join(s.libPath, 'images', `${id}.info`);
      return readFileSync(
        join(
          dir,
          readdirSync(dir).find((f) => f.endsWith('_thumbnail.png'))!,
        ),
      );
    };
    const original = thumbOf(a);
    const picture = join(s.libPath, 'images', 'LT24XY3DPJFLK.info', '0051.jpg');
    await s.host.api.setCustomThumbnail(a, picture);
    const custom = thumbOf(a);
    expect(custom.equals(original)).toBe(false);
    await s.host.api.undo();
    expect(thumbOf(a).equals(original)).toBe(true);
    const redo = await s.host.api.redo();
    expect(redo.conflicts).toEqual([]);
    expect(thumbOf(a).equals(custom)).toBe(true);

    // A refresh redraws it from the original; its undo brings the custom picture back.
    await s.host.api.refreshThumbnails([a]);
    await s.waitFor(() => !thumbOf(a).equals(custom), 10_000);
    const undo = await s.host.api.undo();
    expect(undo.conflicts).toEqual([]);
    expect(thumbOf(a).equals(custom)).toBe(true);
  });
});

describe.skipIf(!sandboxAvailable)('outside folder changes', () => {
  it('are logged in History with a short label, and can be undone', async () => {
    const s = await shared();
    const path = join(s.libPath, 'metadata.json');
    const root = JSON.parse(readFileSync(path, 'utf8'));
    root.folders.push({
      id: 'MPARTNERFLDR1',
      name: 'Hands',
      description: '',
      children: [],
      modificationTime: Date.now(),
      tags: [],
      password: '',
      passwordTips: '',
    });
    root.modificationTime = eagleNow(Date.now() + 1);
    writeFileSync(path, JSON.stringify(root));
    const e = await entry(s, (h) => h.label === 'Sam added folder “Hands”');
    expect(e).toMatchObject({ kind: 'external', undoable: true });
    await s.host.api.undo(e.groupId);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.folders.some((f: { id: string }) => f.id === 'MPARTNERFLDR1')).toBe(false);
  });
});

describe.skipIf(!sandboxAvailable)('a shared library without a partner name', () => {
  it('names outside changes neutrally, never "Dropbox"', async () => {
    const s = await shared({ partner: null });
    const [, b] = s.itemIds;
    s.writeAsEagle(b, (r) => (r.star = 2));
    const e = await entry(s, (h) => h.actor.kind === 'external');
    expect(e).toMatchObject({
      actor: { name: 'Your partner' },
      label: 'Your partner edited 1 item',
    });
  });
});

describe.skipIf(!sandboxAvailable)('status', () => {
  it('a library outside Dropbox says so instead of a Dropbox state, and has no partner', async () => {
    const s = (sb = await openSandbox({ area: 'sync-safety-2' }));
    const st = await s.host.api.getStatus();
    expect(st.sync).toMatchObject({ state: 'idle', detail: 'Not in Dropbox' });
    expect(st.partner).toBeUndefined();
    expect(st.writeProblem).toBeUndefined();
  });
});
