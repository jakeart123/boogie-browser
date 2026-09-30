// Undo / redo and the History tab in the real app, checked on disk: Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y
// for item edits, folder changes, tag renames, imports and reorders; the History tab's entries,
// "Undo" and "Show them"; a change made by someone else (the partner's Eagle, simulated by writing the
// files the way Eagle does) showing up in History and the status strip, including one that may
// have put an old copy over your change ("Keep Sam's" / "Put my change back"); and the strip.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe } from 'node:test';
import {
  freshLibrary,
  importFiles,
  itemMeta,
  launch,
  makeFixtures,
  mtimeJson,
  rootMeta,
  scanItems,
  until,
  withShots,
} from './lib/harness.mjs';
import { nav, shownCount, tile, waitCount, waitToast } from './lib/ui.mjs';

describe('undo, redo, history, status strip', () => {
  let ctx;
  let lib;
  let ids;
  const it = withShots(() => ctx);
  const undoKey = async () => {
    await ctx.win.locator('.scroller').focus();
    await ctx.win.keyboard.press('Control+z');
  };

  before(async () => {
    const f = makeFixtures();
    lib = freshLibrary('history');
    ctx = await launch({ name: 'history', open: lib });
    await ctx.call('setLibraryOptions', lib, { partnerName: 'Sam', shared: true });
    ids = await importFiles(ctx, [f('red.png'), f('blue.png')]);
    await waitCount(ctx.win, 5);
  });
  after(() => ctx?.close());

  it('Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y undo and redo item edits on disk', async () => {
    const { win } = ctx;
    await tile(win, ids[0]).locator('.th').click();
    await win.keyboard.press('4');
    await until(() => itemMeta(lib, ids[0]).star === 4, 'rated');
    await undoKey();
    await until(() => !itemMeta(lib, ids[0]).star, 'undo the rating');
    await waitToast(win, /Undid/);
    await win.keyboard.press('Control+Shift+z');
    await until(() => itemMeta(lib, ids[0]).star === 4, 'redo the rating');
    await undoKey();
    await until(() => !itemMeta(lib, ids[0]).star, 'undo again');
    await win.keyboard.press('Control+y');
    await until(() => itemMeta(lib, ids[0]).star === 4, 'Ctrl+Y redo');
  });

  it('undoes folder, tag, import and reorder changes too', async () => {
    const cases = [
      {
        what: 'create a folder',
        run: () => ctx.call('createFolder', 'Temp', null),
        done: () => rootMeta(lib).folders.some((x) => x.name === 'Temp'),
      },
      {
        what: 'rename a folder',
        run: async () => {
          const id = rootMeta(lib).folders.find((x) => x.name === 'Temp').id;
          return ctx.call('updateFolder', id, { name: 'Temp 2', iconColor: 'blue' });
        },
        done: () => rootMeta(lib).folders.some((x) => x.name === 'Temp 2'),
      },
      {
        what: 'rename a tag on every item',
        run: () => ctx.call('renameTag', 'Atelier Gerome', 'Gerome studio'),
        done: () => scanItems(lib).some((m) => m.tags.includes('Gerome studio')),
      },
      {
        what: 'move items into a folder',
        run: async () => {
          const id = rootMeta(lib).folders.find((x) => x.name.startsWith('Temp')).id;
          return ctx.call('updateItems', ids, { addFolders: [id] });
        },
        done: () => itemMeta(lib, ids[0]).folders.length === 1,
      },
      {
        what: 'drag-reorder in a folder',
        run: async () => {
          const id = rootMeta(lib).folders.find((x) => x.name.startsWith('Temp')).id;
          return ctx.call('reorderItems', id, [ids[1]], ids[0]);
        },
        done: () => Object.keys(itemMeta(lib, ids[1]).order ?? {}).length > 0,
      },
      {
        what: 'import a file',
        run: () => importFiles(ctx, [makeFixtures()('green.jpg')]),
        done: () => scanItems(lib).some((m) => m.name === 'green' && !m.isDeleted),
      },
    ];
    const failures = [];
    for (const c of cases) {
      await c.run();
      await until(c.done, c.what);
      await undoKey();
      try {
        await until(async () => !(await c.done()), `undo: ${c.what}`, 5000);
      } catch (e) {
        failures.push(e.message);
      }
      // Put it back for the next case (redo).
      await ctx.win.keyboard.press('Control+Shift+z');
      await until(c.done, `redo: ${c.what}`, 5000).catch((e) => failures.push(e.message));
    }
    assert.deepEqual(failures, []);
  });

  it('History tab lists the changes, undoes one, and shows its items', async () => {
    const { win } = ctx;
    await win.locator('.strip .btn', { hasText: 'History' }).click();
    const tab = win.locator('.insp');
    await tab.locator('.hev').first().waitFor();
    assert.match(await tab.locator('.hday').first().innerText(), /today/i);
    const rated = tab.locator('.hev', { hasText: /Rated|star/i }).first();
    assert.ok(await rated.count(), `no rating entry in: ${await tab.innerText()}`);
    // Entries are prepended as they happen, so pin this one by its position.
    const at = (await tab.locator('.hev').allInnerTexts()).findIndex((t) => /Imported/.test(t));
    const imported = tab.locator('.hev').nth(at);
    await imported.getByRole('button', { name: 'Show them' }).click();
    await until(async () => (await shownCount(win)) >= 1, 'Show them to show the items');
    await imported.getByRole('button', { name: /^Undo/ }).click();
    await until(
      () => !scanItems(lib).some((m) => m.name === 'green' && !m.isDeleted),
      'the import to be undone from History',
    );
    const same = tab.locator('.hev').nth(at + 1); // the undo itself is now on top
    await until(async () => (await same.innerText()).includes('Undone'), '"Undone" mark');
  });

  it("a change from the partner's Eagle shows up in History and the status strip, and can be undone", async () => {
    const { win } = ctx;
    // Eagle's way: rewrite the item's metadata.json with a higher lastModified, then mtime.json.
    // Boogie's own stamps end in a fixed millisecond; + 5001 keeps this one from looking like a
    // second Boogie's write.
    const meta = itemMeta(lib, ids[1]);
    const next = {
      ...meta,
      tags: [...meta.tags, 'from sam'],
      lastModified: meta.lastModified + 5001,
    };
    writeFileSync(join(lib, 'images', `${ids[1]}.info`, 'metadata.json'), JSON.stringify(next));
    const mt = mtimeJson(lib);
    mt[ids[1]] = next.lastModified;
    writeFileSync(join(lib, 'mtime.json'), JSON.stringify(mt));
    const strip = win.locator('.strip .grp.ext');
    await until(
      async () => (await strip.count()) > 0,
      'the outside change in the status strip',
      15_000,
    );
    assert.match(await strip.innerText(), /Sam/);
    const row = win.locator('.insp .hev', { hasText: /\bSam\b/ }).first();
    await row.waitFor();
    await strip.getByRole('button', { name: 'Show' }).click();
    await until(async () => (await shownCount(win)) === 1, 'Show to open the changed item');
    await row.getByRole('button', { name: /^Undo/ }).click();
    await until(
      () => !itemMeta(lib, ids[1]).tags.includes('from sam'),
      'undo of the outside change',
    );
  });

  it("a change the partner's Eagle may have written an old copy over: Keep Sam's, or put mine back", async () => {
    const { win } = ctx;
    await win.locator('.strip .btn', { hasText: 'History' }).click();
    // The partner's Eagle still shows the old copy of an item (a cached start), and rates it: its save
    // writes that old copy over a tag of yours. Eagle stamps with its own clock (+ 7001: never one
    // above a value Boogie knows, and not Boogie's millisecond mark).
    const oldCopy = async (id, tag, star) => {
      const before = itemMeta(lib, id);
      await ctx.call('updateItems', [id], { addTags: [tag] });
      await until(() => itemMeta(lib, id).tags.includes(tag), `${tag} on disk`);
      const theirs = { ...before, star, lastModified: itemMeta(lib, id).lastModified + 7001 };
      writeFileSync(join(lib, 'images', `${id}.info`, 'metadata.json'), JSON.stringify(theirs));
      const mt = mtimeJson(lib);
      mt[id] = theirs.lastModified;
      writeFileSync(join(lib, 'mtime.json'), JSON.stringify(mt));
      const row = win.locator('.insp .hev.stale').first();
      await row.waitFor({ timeout: 15_000 });
      assert.match(await row.innerText(), /may have written an old copy/);
      return row;
    };

    const kept = await oldCopy(ids[0], 'alex keeps?', 2);
    const notice = win.locator('.strip .grp.old');
    await notice.waitFor({ timeout: 5_000 });
    await kept.getByRole('button', { name: 'Keep Sam’s' }).click();
    const resolved = win.locator('.insp .hev', { hasText: 'Kept Sam’s version' }).first();
    await resolved.waitFor();
    await until(async () => (await notice.count()) === 0, 'the notice to clear');
    assert.equal(itemMeta(lib, ids[0]).star, 2); // their version stays, nothing rewritten
    assert.ok(!itemMeta(lib, ids[0]).tags.includes('alex keeps?'));

    const back = await oldCopy(ids[1], 'alex wants it', 3);
    await back.getByRole('button', { name: 'Put my change back' }).click();
    await until(() => itemMeta(lib, ids[1]).tags.includes('alex wants it'), 'the tag back on disk');
    assert.equal(itemMeta(lib, ids[1]).star, 3); // their rating kept
    await win.locator('.insp .hev', { hasText: 'Your change is back' }).first().waitFor();
    await until(async () => (await notice.count()) === 0, 'no notice left');
  });

  it('an item the partner adds (a new .info folder + mtime.json, as Dropbox delivers it) appears with the new dot', async () => {
    const { win } = ctx;
    await nav(win, 'All');
    const n0 = (await ctx.call('getCounts')).all;
    await waitCount(win, n0);
    // Build the new item the way Eagle writes one: its folder first, then mtime.json.
    const id = 'MPARTNER00001';
    const dir = join(lib, 'images', `${id}.info`);
    mkdirSync(dir);
    copyFileSync(makeFixtures()('wide.png'), join(dir, 'from sam.png'));
    const now = Date.now();
    const rec = {
      id,
      name: 'from sam',
      size: statSync(join(dir, 'from sam.png')).size,
      btime: now,
      mtime: now,
      ext: 'png',
      tags: [],
      folders: [],
      isDeleted: false,
      url: '',
      annotation: '',
      modificationTime: now,
      height: 100,
      width: 200,
      noThumbnail: true,
      lastModified: now,
    };
    writeFileSync(join(dir, 'metadata.json'), JSON.stringify(rec));
    const mt = mtimeJson(lib);
    mt[id] = now;
    mt.all = (mt.all ?? 0) + 1;
    writeFileSync(join(lib, 'mtime.json'), JSON.stringify(mt));
    await waitCount(win, n0 + 1, 15_000);
    await until(
      async () => (await tile(win, id).locator('.new').count()) > 0,
      'the orange "new" dot on the tile',
    );
    assert.match(await win.locator('.strip .grp.ext').innerText(), /Sam/);
  });

  it('status strip: no Dropbox state for a private library, conflicted copies, ports tooltip', async () => {
    const { win } = ctx;
    // A Dropbox conflicted copy of the root file.
    writeFileSync(
      join(lib, "metadata (Sam Lee's conflicted copy 2026-09-29).json"),
      JSON.stringify(rootMeta(lib)),
    );
    await ctx.call('refresh', { full: true });
    const link = win.locator('.strip .link.amber');
    await until(async () => (await link.count()) > 0, 'the conflicted copies link', 15_000);
    await link.click();
    const dlg = win.locator('.dg-panel');
    assert.match(await dlg.innerText(), /conflicted copy/i);
    await win.keyboard.press('Escape');
    // Dropbox's state shows only for a library marked shared; this private copy isn't.
    assert.equal(await win.locator('.strip .grp.sync').count(), 0);
    const tip = await win.locator('#ports-tip').innerText();
    assert.ok(tip.length > 0, 'the ports tooltip is empty');
    assert.ok(existsSync(join(lib, 'metadata.json')));
  });
});
