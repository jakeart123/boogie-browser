// Folders in the real app, checked in the library's root metadata.json: create, subfolder, rename,
// color, auto-tags, drag items onto a folder (add, and Shift = move), manual order by dragging in a
// folder, move/reorder folders (drag and Ctrl+] / Ctrl+[ as in Eagle), delete with Undo.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe } from 'node:test';
import {
  freshLibrary,
  importFiles,
  itemMeta,
  launch,
  makeFixtures,
  rootMeta,
  sleep,
  until,
  withShots,
} from './lib/harness.mjs';
import {
  dragStartTile,
  dropFiles,
  folderRow,
  menu,
  nav,
  nativeDrags,
  stubNativeDrag,
  waitNativeDrag,
  tile,
  tileIds,
  waitCount,
  waitToast,
} from './lib/ui.mjs';

/** Find a folder by name anywhere in the root tree, with its parent and index. */
function findFolder(lib, name) {
  let hit = null;
  const walk = (list, parent) =>
    list.forEach((f, i) => {
      if (f.name === name) hit = { folder: f, parent, index: i };
      walk(f.children, f);
    });
  walk(rootMeta(lib).folders, null);
  return hit;
}

describe('folders', () => {
  let ctx;
  const it = withShots(() => ctx);
  let lib;
  let ids;
  const backups = () => readdirSync(join(lib, 'backup')).length;

  before(async () => {
    const f = makeFixtures();
    lib = freshLibrary('folders');
    ctx = await launch({ name: 'folders', open: lib });
    ids = await importFiles(ctx, ['red.png', 'blue.png', 'green.jpg', 'wide.png'].map(f));
    await waitCount(ctx.win, 7);
    await stubNativeDrag(ctx.app);
  });
  after(() => ctx?.close());

  it('creates a folder with + and a subfolder from the menu (root file, modificationTime, backup)', async () => {
    const { win } = ctx;
    const root0 = rootMeta(lib);
    const b0 = backups();
    await win.getByRole('button', { name: 'New folder' }).click();
    await win.getByRole('textbox', { name: 'New folder name' }).fill('Studies');
    await win.keyboard.press('Enter');
    await until(() => findFolder(lib, 'Studies'), 'Studies in metadata.json');
    const root1 = rootMeta(lib);
    assert.ok(root1.modificationTime > root0.modificationTime, 'root modificationTime not raised');
    assert.equal(root1.applicationVersion, root0.applicationVersion);
    await until(() => backups() > b0, 'an Eagle-style backup of the root');
    await folderRow(win, 'Studies').click({ button: 'right' });
    await menu(win, 'New subfolder');
    await win.getByRole('textbox', { name: 'New folder name' }).fill('Heads');
    await win.keyboard.press('Enter');
    await until(() => findFolder(lib, 'Heads')?.parent?.name === 'Studies', 'Heads under Studies');
  });

  it('renames with a double-click and colors from the menu', async () => {
    const { win } = ctx;
    await folderRow(win, 'Heads').locator('.fn').dblclick();
    const input = win.getByRole('textbox', { name: 'Folder name' });
    await input.fill('Portrait heads');
    await input.press('Enter');
    await until(() => findFolder(lib, 'Portrait heads'), 'renamed on disk');
    await folderRow(win, 'Studies').click({ button: 'right' });
    await menu(win, 'Color', 'Red');
    await until(() => findFolder(lib, 'Studies')?.folder.iconColor === 'red', 'iconColor red');
  });

  it('sets auto-tags in Edit folder… and applies them when items are dropped on the folder', async () => {
    const { win } = ctx;
    await folderRow(win, 'Studies').click({ button: 'right' });
    await menu(win, 'Edit folder');
    const dlg = win.locator('.dg-panel');
    const tagIn = dlg.getByPlaceholder('Add a tag');
    await tagIn.fill('study');
    await tagIn.press('Enter');
    await dlg.getByRole('button', { name: 'Save' }).click();
    await until(() => findFolder(lib, 'Studies')?.folder.tags?.includes('study'), 'auto-tag saved');
    // Drag two tiles onto the folder row: in Electron that is a native drag of the originals, and
    // the drop comes back as those files, which the app maps to its own items.
    const studies = findFolder(lib, 'Studies').folder.id;
    await nav(win, 'All'); // the double-click above opened the subfolder
    await tile(win, ids[0]).locator('.th').click();
    await tile(win, ids[1])
      .locator('.th')
      .click({ modifiers: ['Control'] });
    await dragStartTile(win, ids[0]);
    await waitNativeDrag(ctx.app, 1);
    const drags = await nativeDrags(ctx.app);
    assert.equal(drags.length, 1, 'startDrag was not called');
    assert.equal(drags[0].files.length, 2);
    assert.ok(
      drags[0].files.every((p) => p.startsWith(join(lib, 'images'))),
      drags[0].files.join(),
    );
    assert.ok(drags[0].icon, 'drag has no icon');
    await dropFiles(win, folderRow(win, 'Studies'), drags[0].files);
    await until(
      () => [ids[0], ids[1]].every((id) => itemMeta(lib, id).folders.includes(studies)),
      'items in the folder on disk',
    );
    for (const id of [ids[0], ids[1]]) assert.ok(itemMeta(lib, id).tags.includes('study'));
    await waitToast(win, /Added 2 items to “Studies”/);
    // And no import happened: still 7 items.
    assert.equal((await ctx.call('getCounts')).all, 7);
  });

  it('Shift+drop from inside a folder moves the item (leaves the folder you are in)', async () => {
    const { win } = ctx;
    const studies = findFolder(lib, 'Studies').folder.id;
    const heads = findFolder(lib, 'Portrait heads').folder.id;
    await folderRow(win, 'Studies').click();
    await win.locator('.tb .ttl').click();
    await menu(win, 'Show subfolder contents'); // off: only the folder's own items
    await waitCount(win, 2);
    await tile(win, ids[0]).locator('.th').click();
    await dragStartTile(win, ids[0]);
    const { files } = await waitNativeDrag(ctx.app, 2);
    await dropFiles(win, folderRow(win, 'Portrait heads'), files, { shift: true });
    await until(() => itemMeta(lib, ids[0]).folders.includes(heads), 'in the subfolder');
    assert.ok(!itemMeta(lib, ids[0]).folders.includes(studies), 'still in Studies after a move');
    await waitCount(win, 1);
    await win.locator('.tb .ttl').click();
    await menu(win, 'Show subfolder contents');
  });

  it('reorders items inside a folder by dragging (manual order in each item)', async () => {
    const { win } = ctx;
    const studies = findFolder(lib, 'Studies').folder.id;
    await ctx.call('updateItems', [ids[2], ids[3], ids[0]], { addFolders: [studies] });
    await folderRow(win, 'Studies').click();
    await waitCount(win, 4);
    // Manual order shows the result of a drag; pick it in the sort menu.
    await win.getByRole('button', { name: 'Sort' }).click();
    await menu(win, 'Manual');
    await sleep(400);
    const order0 = await tileIds(win);
    const last = order0.at(-1);
    // Drag the last tile to the front: drop on the left edge of the first tile.
    await tile(win, last).locator('.th').click();
    await dragStartTile(win, last);
    const { files } = await waitNativeDrag(ctx.app, 3);
    const box = await tile(win, order0[0]).locator('.th').boundingBox();
    const accepted = await dropFiles(win, win.locator('.scroller'), files, {
      at: { x: box.x + 4, y: box.y + box.height / 2 },
    });
    assert.ok(accepted, 'the grid refused the drag');
    await until(async () => (await tileIds(win))[0] === last, 'the tile to move to the front');
    const order = itemMeta(lib, last).order ?? {};
    assert.ok(order[studies], `no manual order written for the folder: ${JSON.stringify(order)}`);
    // The order survives a re-query (it comes from disk, not from the drag).
    await win.keyboard.press('Alt+ArrowLeft');
    await win.keyboard.press('Alt+ArrowRight');
    await until(async () => (await tileIds(win))[0] === last, 'order kept after navigating');
  });

  it('moves a folder by dragging it into another, and reorders siblings with Ctrl+] / Ctrl+[', async () => {
    const { win } = ctx;
    await ctx.call('createFolder', 'Landscapes', null);
    await until(async () => (await folderRow(win, 'Landscapes').count()) > 0, 'Landscapes row');
    await folderRow(win, 'Portrait heads').dragTo(folderRow(win, 'Landscapes'));
    await until(
      () => findFolder(lib, 'Portrait heads')?.parent?.name === 'Landscapes',
      'Portrait heads nested under Landscapes',
    );
    const names = () => rootMeta(lib).folders.map((f) => f.name);
    const before = names();
    await folderRow(win, 'Landscapes').click();
    await win.locator('.list[aria-label="Folders"]').focus();
    // Eagle's keys: Ctrl+] moves a folder up, Ctrl+[ down.
    await win.keyboard.press('Control+]');
    await until(() => {
      const n = names();
      return n.indexOf('Landscapes') === before.indexOf('Landscapes') - 1;
    }, `Landscapes to move up (was ${before})`);
    await win.keyboard.press('Control+[');
    await until(
      () => names().indexOf('Landscapes') === before.indexOf('Landscapes'),
      'Landscapes back down',
    );
  });

  it('a folder sort set from its menu is written as Eagle reads it and shown the same way', async () => {
    const { win } = ctx;
    const byImport = async (asc) => {
      const withTimes = ids.map((id) => [id, itemMeta(lib, id).modificationTime]);
      const inFolder = new Set(await tileIds(win));
      return withTimes
        .filter(([id]) => inFolder.has(id))
        .sort((a, b) => (asc ? a[1] - b[1] : b[1] - a[1]))
        .map(([id]) => id);
    };
    await folderRow(win, 'Studies').click();
    await folderRow(win, 'Studies').click({ button: 'right' });
    await menu(win, 'Sort this folder by', 'Date imported');
    // Eagle's sortIncrease:true means "Eagle's own order", which is newest first for dates.
    await until(() => findFolder(lib, 'Studies').folder.orderBy === 'IMPORT', 'orderBy on disk');
    assert.equal(findFolder(lib, 'Studies').folder.sortIncrease, true);
    await until(async () => {
      const want = await byImport(false);
      return JSON.stringify(await tileIds(win)) === JSON.stringify(want);
    }, 'newest first in the grid');
    await folderRow(win, 'Studies').click({ button: 'right' });
    await menu(win, 'Sort this folder by', 'Ascending');
    await until(() => findFolder(lib, 'Studies').folder.sortIncrease === false, 'flag flipped');
    await until(async () => {
      const want = await byImport(true);
      return JSON.stringify(await tileIds(win)) === JSON.stringify(want);
    }, 'oldest first in the grid');
    const label = await win.getByRole('button', { name: 'Sort' }).getAttribute('title');
    assert.match(label ?? '', /Date imported, ascending/);
  });

  it('deletes a folder (items stay, lose the folder), and Undo brings it back', async () => {
    const { win } = ctx;
    const studies = findFolder(lib, 'Studies').folder.id;
    const inIt = ids.filter((id) => itemMeta(lib, id).folders.includes(studies));
    assert.ok(inIt.length);
    await folderRow(win, 'Studies').click({ button: 'right' });
    await menu(win, 'Delete folder');
    await win.locator('.dg-panel').getByRole('button', { name: 'Delete folder' }).click();
    await until(() => !findFolder(lib, 'Studies'), 'Studies gone from metadata.json');
    for (const id of inIt) assert.ok(!itemMeta(lib, id).folders.includes(studies));
    assert.equal((await ctx.call('getCounts')).all, 7, 'deleting a folder removed items');
    await win
      .locator('.stack .toast', { hasText: 'Deleted “Studies”' })
      .getByRole('button', { name: 'Undo' })
      .click();
    await until(() => findFolder(lib, 'Studies'), 'Studies back after Undo');
    await until(
      () => inIt.every((id) => itemMeta(lib, id).folders.includes(studies)),
      'items back in Studies',
    );
  });
});
