// The keyboard-first tools in the real app, checked on disk: the tag window (T), the folder picker
// (F, then Shift+D to repeat), go to folder (Ctrl+J), move (M) and remove from folder (Ctrl+Delete),
// rename (F2) and batch rename with tokens (Ctrl+R), new folder (Ctrl+Shift+N), panel toggles, and
// the command palette running commands, adding tags and jumping to folders.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe } from 'node:test';
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
import { folderRow, nav, tile, waitCount } from './lib/ui.mjs';

describe('pickers, rename, palette, shortcuts', () => {
  let ctx;
  let lib;
  let ids;
  const it = withShots(() => ctx);
  const folderId = (name) => {
    let id = null;
    const walk = (l) => l.forEach((f) => (f.name === name ? (id = f.id) : walk(f.children)));
    walk(rootMeta(lib).folders);
    return id;
  };
  const selectTwo = async () => {
    await tile(ctx.win, ids[0]).locator('.th').click();
    await tile(ctx.win, ids[1])
      .locator('.th')
      .click({ modifiers: ['Control'] });
  };

  before(async () => {
    const f = makeFixtures();
    lib = freshLibrary('pickers');
    ctx = await launch({ name: 'pickers', open: lib });
    ids = await importFiles(ctx, [f('red.png'), f('blue.png'), f('green.jpg')]);
    await waitCount(ctx.win, 6);
  });
  after(() => ctx?.close());
  beforeEach(async () => {
    for (let i = 0; i < 2 && (await ctx.win.$('.dg-scrim, .ov, [role=dialog]')); i++) {
      await ctx.win.keyboard.press('Escape');
      await sleep(150);
    }
  });

  it('T opens the tag window: adds a new tag to all, and a checked tag toggles off', async () => {
    const { win } = ctx;
    await selectTwo();
    await win.keyboard.press('t');
    const input = win.getByRole('textbox', { name: 'Add a tag' });
    await input.fill('batchy');
    await input.press('Enter');
    await until(
      () => ids.slice(0, 2).every((id) => itemMeta(lib, id).tags.includes('batchy')),
      'tag on both',
    );
    const row = win.locator('[role=listbox][aria-label=Tags] .row', { hasText: 'batchy' }).first();
    await row.click();
    await until(
      () => ids.slice(0, 2).every((id) => !itemMeta(lib, id).tags.includes('batchy')),
      'toggled off',
    );
    await win.keyboard.press('Escape');
  });

  it('F adds the selection to a folder it creates; Shift+D repeats it on another item', async () => {
    const { win } = ctx;
    await selectTwo();
    await win.keyboard.press('f');
    const input = win.getByRole('textbox', { name: 'Find a folder' });
    await input.fill('Picked');
    await win
      .locator('[role=listbox][aria-label=Folders] .row', { hasText: 'Picked' })
      .first()
      .click();
    await until(() => folderId('Picked'), 'the new folder');
    const id = folderId('Picked');
    await until(
      () => ids.slice(0, 2).every((x) => itemMeta(lib, x).folders.includes(id)),
      'in Picked',
    );
    await tile(win, ids[2]).locator('.th').click();
    await win.keyboard.press('Shift+d');
    await until(() => itemMeta(lib, ids[2]).folders.includes(id), 'Shift+D repeat');
  });

  it('Ctrl+J goes to a folder; M moves out of it; Ctrl+Delete removes from it', async () => {
    const { win } = ctx;
    await ctx.call('createFolder', 'Elsewhere', null);
    await win.keyboard.press('Control+j');
    await win.getByRole('textbox', { name: 'Go to a folder' }).fill('Picked');
    await win.keyboard.press('Enter');
    await until(
      async () => (await win.locator('.tb .ttl .nm').innerText()) === 'Picked',
      'Picked open',
    );
    await waitCount(win, 3);
    const picked = folderId('Picked');
    const elsewhere = folderId('Elsewhere');
    await tile(win, ids[0]).locator('.th').click();
    await win.keyboard.press('m');
    await win.getByRole('textbox', { name: 'Find a folder' }).fill('Elsewhere');
    await win.keyboard.press('Enter');
    await until(() => itemMeta(lib, ids[0]).folders.includes(elsewhere), 'moved to Elsewhere');
    assert.ok(!itemMeta(lib, ids[0]).folders.includes(picked), 'M kept it in Picked');
    await waitCount(win, 2);
    await tile(win, ids[1]).locator('.th').click();
    await win.keyboard.press('Control+Delete');
    await until(() => !itemMeta(lib, ids[1]).folders.includes(picked), 'removed from Picked');
    assert.equal(itemMeta(lib, ids[1]).isDeleted, false, 'Ctrl+Delete trashed the item');
    await nav(win, 'All');
  });

  it('F2 renames one item; Ctrl+R batch-renames with %N', async () => {
    const { win } = ctx;
    await tile(win, ids[2]).locator('.th').click();
    await win.keyboard.press('F2');
    const name = win.getByRole('textbox', { name: 'Name' }).last();
    await name.fill('Leaf');
    await name.press('Enter');
    await until(() => itemMeta(lib, ids[2]).name === 'Leaf', 'F2 rename on disk');
    await selectTwo();
    await win.keyboard.press('Control+r');
    const tpl = win.locator('#rn-tpl');
    await tpl.fill('Study %N');
    const preview = await win.getByRole('table', { name: 'Preview of the new names' }).innerText();
    assert.match(preview, /Study 1/);
    await win
      .getByRole('button', { name: /^Rename|^Apply/ })
      .last()
      .click();
    await until(() => {
      const names = ids
        .slice(0, 2)
        .map((id) => itemMeta(lib, id).name)
        .sort();
      return names[0] === 'Study 1' && names[1] === 'Study 2';
    }, 'batch names on disk');
  });

  it('Ctrl+Shift+N makes a folder inside the open one; Ctrl+Alt+1/2 toggle the panels', async () => {
    const { win } = ctx;
    await folderRow(win, 'Elsewhere').click();
    await win.keyboard.press('Control+Shift+n');
    await win.getByRole('textbox', { name: 'New folder name' }).fill('Inner');
    await win.keyboard.press('Enter');
    await until(() => {
      const e = rootMeta(lib).folders.find((f) => f.name === 'Elsewhere');
      return e?.children.some((c) => c.name === 'Inner');
    }, 'Inner under Elsewhere');
    await win.locator('.scroller').focus();
    await win.keyboard.press('Control+Alt+1');
    await until(async () => !(await win.locator('aside.side').count()), 'sidebar hidden');
    await win.keyboard.press('Control+Alt+1');
    await win.keyboard.press('Control+Alt+2');
    await until(async () => !(await win.locator('aside.insp').count()), 'inspector hidden');
    await win.keyboard.press('Control+Alt+2');
    await win.locator('aside.side').waitFor();
    await win.locator('aside.insp').waitFor();
    await nav(win, 'All');
  });

  it('the command palette runs commands, tags the selection and goes to folders', async () => {
    const { win } = ctx;
    const palette = async (text) => {
      await win.keyboard.press('Control+k');
      await win.getByRole('combobox', { name: 'Search, filter, or run a command' }).fill(text);
      await sleep(250);
    };
    await palette('layout list');
    await win.locator('.po', { hasText: 'Layout: List' }).first().click();
    await until(async () => (await ctx.call('getSettings')).layout === 'list', 'list layout');
    await palette('layout justified');
    await win.locator('.po', { hasText: 'Layout: Justified' }).first().click();

    await tile(win, ids[0]).click();
    await palette('paletteTag');
    await win
      .locator('.po', { hasText: /Create tag “paletteTag”|Add tag/ })
      .first()
      .click();
    await until(() => itemMeta(lib, ids[0]).tags.includes('paletteTag'), 'tag from the palette');

    await palette('Elsewh');
    await win.locator('.po', { hasText: /Go to/ }).first().click();
    await until(
      async () => (await win.locator('.tb .ttl .nm').innerText()) === 'Elsewhere',
      'palette go to',
    );
    // Recent commands come back when the palette opens empty.
    await win.keyboard.press('Control+k');
    await sleep(200);
    assert.match(await win.locator('.pg').innerText(), /Layout: Justified|Layout: List/);
    await win.keyboard.press('Escape');
  });
});
