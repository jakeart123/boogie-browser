// Getting files out of the real app: Ctrl+C (pixels + file list on the private display's
// clipboard), Copy file path, Reveal in folder and Open with default app (shell stubbed so nothing
// opens on the desktop), the source link button, drag out (the native drag gets the originals),
// and Export… (copies, never moves, -01 on name clashes).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe } from 'node:test';
import {
  WORK,
  freshLibrary,
  importFiles,
  launch,
  makeFixtures,
  readClipboard,
  until,
  withShots,
} from './lib/harness.mjs';
import {
  dragStartTile,
  menu,
  shellCalls,
  stubNativeDrag,
  stubOpenDialog,
  stubShell,
  tile,
  waitCount,
  waitNativeDrag,
  waitToast,
} from './lib/ui.mjs';

describe('files out', () => {
  let ctx;
  let ids;
  let items;
  const it = withShots(() => ctx);
  const out = join(WORK, 'export-out');

  before(async () => {
    const f = makeFixtures();
    ctx = await launch({ name: 'files-out', open: freshLibrary('files-out') });
    ids = await importFiles(ctx, [f('red.png'), f('green.jpg')]);
    await ctx.call('updateItems', [ids[0]], { url: 'https://example.com/source' });
    items = await ctx.call('getItems', ids);
    await waitCount(ctx.win, 5);
    await stubShell(ctx.app);
    await stubNativeDrag(ctx.app);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
  });
  after(() => ctx?.close());

  it('Ctrl+C puts the picture and both files on the clipboard', async () => {
    const { win } = ctx;
    await tile(win, ids[0]).locator('.th').click();
    await tile(win, ids[1])
      .locator('.th')
      .click({ modifiers: ['Control'] });
    await win.keyboard.press('Control+c');
    await waitToast(win, /Copied 2 items/);
    const targets = readClipboard('TARGETS').toString();
    assert.match(targets, /image\/png/);
    assert.match(targets, /text\/uri-list/);
    const uris = readClipboard('text/uri-list').toString();
    for (const it of items)
      assert.ok(uris.includes(encodeURI(it.filePath)), `${it.filePath} missing`);
    const png = readClipboard('image/png');
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
  });

  it('Copy file path, Reveal in folder, Open with default app', async () => {
    const { win, app } = ctx;
    await tile(win, ids[0]).locator('.th').click(); // just this one (right-click keeps a selection)
    await tile(win, ids[0]).locator('.th').click({ button: 'right' });
    await menu(win, 'Copy file path');
    await until(() => readClipboard('UTF8_STRING').toString() === items[0].filePath, 'the path');
    await tile(win, ids[0]).locator('.th').click({ button: 'right' });
    await menu(win, 'Reveal in folder');
    await tile(win, ids[0]).locator('.th').click({ button: 'right' });
    await menu(win, 'Open with default app');
    await until(async () => (await shellCalls(app)).length >= 2, 'the shell calls');
    assert.deepEqual(await shellCalls(app), [
      ['reveal', items[0].filePath],
      ['open', items[0].filePath],
    ]);
  });

  it('the inspector link button opens the source URL in the browser', async () => {
    const { win, app } = ctx;
    await tile(win, ids[0]).locator('.th').click();
    await win.locator('.insp [aria-label="Open the source link"]').click();
    await until(
      async () => (await shellCalls(app)).some((c) => c[0] === 'external'),
      'openExternal',
    );
    assert.deepEqual((await shellCalls(app)).at(-1), ['external', 'https://example.com/source']);
  });

  it('dragging tiles out hands the original files to a native drag', async () => {
    const { win, app } = ctx;
    await tile(win, ids[0]).locator('.th').click();
    await tile(win, ids[1])
      .locator('.th')
      .click({ modifiers: ['Control'] });
    await dragStartTile(win, ids[1]);
    const drag = await waitNativeDrag(app, 1);
    assert.deepEqual([...drag.files].sort(), items.map((i) => i.filePath).sort());
    assert.ok(drag.icon, 'the drag has no icon');
    // Dragging a tile that isn't selected drags just that one.
    await win.keyboard.press('Escape');
    await dragStartTile(win, ids[0]);
    assert.deepEqual((await waitNativeDrag(app, 2)).files, [items[0].filePath]);
  });

  it('Export… copies the originals to a folder, twice gives -01 names, originals stay', async () => {
    const { win, app } = ctx;
    await stubOpenDialog(app, [out]);
    for (let round = 0; round < 2; round++) {
      await tile(win, ids[0]).locator('.th').click();
      await tile(win, ids[1])
        .locator('.th')
        .click({ modifiers: ['Control'] });
      await tile(win, ids[1]).locator('.th').click({ button: 'right' });
      await menu(win, 'Export items…');
      // The dialog: pick the folder the first time (it's remembered after that), then Export.
      if (round === 0) await win.locator('.dg-panel button', { hasText: 'Choose…' }).click();
      await win.locator('.dg-panel .dest', { hasText: 'export-out' }).waitFor();
      await win.locator('.dg-foot .dg-btn.pri', { hasText: 'Export' }).click();
      await waitToast(win, /Exported 2 items/);
    }
    // "Show folder" on the done toast opens the export folder.
    const shown = (await shellCalls(app)).length;
    await win.locator('.toast button', { hasText: 'Show folder' }).last().click();
    await until(async () => (await shellCalls(app)).length > shown, 'Show folder');
    assert.deepEqual((await shellCalls(app)).at(-1), ['open', out]);
    assert.deepEqual(readdirSync(out).sort(), [
      'green-01.jpg',
      'green.jpg',
      'red-01.png',
      'red.png',
    ]);
    for (const it of items) {
      assert.ok(existsSync(it.filePath), 'an original is gone');
      assert.equal(statSync(join(out, `${it.name}.${it.ext}`)).size, it.size);
    }
  });

  it('double-click follows the setting: default app, or a reference window', async () => {
    const { win, app } = ctx;
    const setDouble = async (label) => {
      await win.locator('.scroller').focus();
      await win.keyboard.press('Control+,');
      await win.locator('.dg-panel #dbl').selectOption({ label });
      await win.keyboard.press('Escape');
      await win.locator('.dg-scrim').waitFor({ state: 'detached' });
    };
    await setDouble('Opens it in the default app');
    const before = (await shellCalls(app)).length;
    await tile(win, ids[1]).locator('.th').dblclick();
    await until(async () => (await shellCalls(app)).length > before, 'openPath');
    assert.deepEqual((await shellCalls(app)).at(-1), ['open', items[1].filePath]);
    await setDouble('Opens a floating reference window');
    const opened = app.waitForEvent('window');
    await tile(win, ids[1]).locator('.th').dblclick();
    const ref = await opened;
    await ref.waitForLoadState('domcontentloaded');
    assert.equal(await ref.evaluate(() => window.boogie.windowKind.itemId), ids[1]);
    await ref.close();
    await setDouble('Opens the detail view');
    await until(
      async () => (await ctx.call('getSettings')).doubleClickAction === 'detail',
      'the setting saved',
    );
  });
});
