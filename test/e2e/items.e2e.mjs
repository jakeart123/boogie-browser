// Editing items in the real app, checked on disk the Eagle way (metadata.json + mtime.json):
// rename, notes, source link, tags, rating, batch edits on a multi-selection, and the trash
// (move to trash, restore, delete permanently, empty trash, and undoing each).
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe } from 'node:test';
import {
  assertEagleWrite,
  freshLibrary,
  importFiles,
  itemMeta,
  launch,
  makeFixtures,
  sleep,
  until,
  withShots,
} from './lib/harness.mjs';
import { menu, nav, selectedIds, tile, tileIds, waitCount, waitToast } from './lib/ui.mjs';

describe('item edits', () => {
  let ctx;
  const it = withShots(() => ctx);
  let lib;
  let ids; // [red, blue, green, wide] imported fixtures
  const insp = () => ctx.win.locator('.insp');
  const select = async (id, modifiers = []) => {
    await tile(ctx.win, id).locator('.th').click({ modifiers });
    await sleep(150);
  };

  before(async () => {
    const f = makeFixtures();
    lib = freshLibrary('items');
    ctx = await launch({ name: 'items', open: lib });
    ids = await importFiles(ctx, ['red.png', 'blue.png', 'green.jpg', 'wide.png'].map(f));
    await waitCount(ctx.win, 7);
  });
  after(() => ctx?.close());

  it('renames an item from the inspector (metadata, files on disk, mtime.json)', async () => {
    const { win } = ctx;
    const id = ids[0];
    const before = itemMeta(lib, id);
    const dir = join(lib, 'images', `${id}.info`);
    const filesBefore = readdirSync(dir).sort();
    await select(id);
    const name = insp().getByRole('textbox', { name: 'Name' });
    await name.fill('Crimson square');
    await name.press('Enter');
    await until(() => itemMeta(lib, id).name === 'Crimson square', 'the new name on disk');
    await assertEagleWrite(lib, id, before);
    // Eagle renames the original (and the thumbnail, when there is one) to follow the name.
    const expected = filesBefore.map((f) => f.replace(before.name, 'Crimson square')).sort();
    assert.deepEqual(readdirSync(dir).sort(), expected);
    await until(
      async () => (await tile(win, id).innerText()).includes('Crimson square'),
      'tile name',
    );
  });

  it('saves notes (with a newline) and the source link', async () => {
    const id = ids[1];
    const before = itemMeta(lib, id);
    await select(id);
    const notes = insp().getByRole('textbox', { name: 'Notes' });
    await notes.fill('Date: 1880\nStudent of: Gerome');
    await notes.blur();
    await until(() => itemMeta(lib, id).annotation === 'Date: 1880\nStudent of: Gerome', 'notes');
    const mid = await assertEagleWrite(lib, id, before);
    const url = insp().getByRole('textbox', { name: 'Source link' });
    await url.fill('https://example.com/blue');
    await url.press('Enter');
    await until(() => itemMeta(lib, id).url === 'https://example.com/blue', 'url');
    await assertEagleWrite(lib, id, mid);
  });

  it('adds tags with the tag input and removes one with its x', async () => {
    const id = ids[2];
    const before = itemMeta(lib, id);
    await select(id);
    const input = insp().getByRole('combobox', { name: 'Add a tag' });
    await input.fill('landscape, sketch');
    await input.press('Enter');
    await until(
      () => ['landscape', 'sketch'].every((t) => itemMeta(lib, id).tags.includes(t)),
      'both tags on disk',
    );
    const mid = await assertEagleWrite(lib, id, before);
    await insp().getByRole('button', { name: 'Remove sketch' }).click();
    await until(() => !itemMeta(lib, id).tags.includes('sketch'), 'sketch removed');
    await assertEagleWrite(lib, id, mid);
    assert.deepEqual(itemMeta(lib, id).tags, ['landscape']);
  });

  it('rates with the inspector stars and the 1-5 / 0 keys', async () => {
    const { win } = ctx;
    const id = ids[3];
    await select(id);
    await insp().getByRole('button', { name: '4 stars' }).click();
    await until(() => itemMeta(lib, id).star === 4, 'star 4 on disk');
    await select(id);
    await win.keyboard.press('2');
    await until(() => itemMeta(lib, id).star === 2, 'star 2 on disk');
    await until(async () => (await tile(win, id).locator('.stars').innerText()) === '2', 'badge');
    await win.keyboard.press('0');
    await until(() => !itemMeta(lib, id).star, 'rating cleared on disk');
  });

  it('batch-edits a multi-selection: tags, rating and notes (asks first)', async () => {
    const { win } = ctx;
    await select(ids[0]);
    await select(ids[1], ['Control']);
    assert.match(await insp().innerText(), /2 items/);
    const input = insp().getByRole('combobox', { name: 'Add a tag' });
    await input.fill('batch');
    await input.press('Enter');
    await until(
      () => [ids[0], ids[1]].every((id) => itemMeta(lib, id).tags.includes('batch')),
      'batch tag on both',
    );
    await insp().getByRole('button', { name: '5 stars' }).click();
    await until(() => [ids[0], ids[1]].every((id) => itemMeta(lib, id).star === 5), 'both 5');
    const notes = insp().getByRole('textbox', { name: 'Notes' });
    assert.equal(await notes.getAttribute('placeholder'), 'Multiple values');
    await notes.fill('same note');
    await notes.blur();
    const confirm = win.locator('.dg-panel');
    await confirm.waitFor();
    assert.match(await confirm.innerText(), /Change 2 items/);
    await confirm.getByRole('button', { name: 'Continue' }).click();
    await until(
      () => [ids[0], ids[1]].every((id) => itemMeta(lib, id).annotation === 'same note'),
      'notes on both',
    );
    // A tag only one of them has shows as partial; clicking it adds it to both.
    await select(ids[2]);
    await select(ids[0], ['Control']);
    const partial = insp().locator('.chip button.main[title^="On 1 of 2"]', {
      hasText: 'landscape',
    });
    await partial.click();
    await until(() => itemMeta(lib, ids[0]).tags.includes('landscape'), 'partial tag added');
  });

  it('moves to the trash, restores, deletes permanently, and undoes each', async () => {
    const { win } = ctx;
    const id = ids[3];
    await select(id);
    await win.keyboard.press('Delete');
    await until(() => itemMeta(lib, id).isDeleted === true, 'isDeleted on disk');
    assert.ok(itemMeta(lib, id).deletedTime > 0, 'no deletedTime');
    const toast = await waitToast(win, /Moved 1 item to the trash/);
    assert.match(toast, /Undo/);
    await win
      .locator('.stack .toast', { hasText: 'to the trash' })
      .getByRole('button', { name: 'Undo' })
      .click();
    await until(() => itemMeta(lib, id).isDeleted === false, 'undo restored it');

    await select(id);
    await win.keyboard.press('Delete');
    await until(() => itemMeta(lib, id).isDeleted === true, 'trashed again');
    await nav(win, 'Trash');
    await waitCount(win, 1);
    await tile(win, id).locator('.th').click({ button: 'right' });
    await menu(win, 'Restore');
    await until(() => itemMeta(lib, id).isDeleted === false, 'restored from the menu');
    await waitCount(win, 0);

    await nav(win, 'All');
    await select(id);
    await win.keyboard.press('Delete');
    await until(() => itemMeta(lib, id).isDeleted === true, 'trashed a third time');
    await nav(win, 'Trash');
    await waitCount(win, 1);
    await select(id);
    await win.keyboard.press('Delete');
    await win.locator('.dg-panel').getByRole('button', { name: 'Delete' }).click();
    const info = join(lib, 'images', `${id}.info`);
    await until(() => !existsSync(info), 'the .info folder to leave the library');
    await waitCount(win, 0);
    // Undo brings the folder back from Boogie's store.
    await win
      .locator('.stack .toast', { hasText: 'Deleted' })
      .getByRole('button', { name: 'Undo' })
      .click();
    await until(() => existsSync(join(info, 'metadata.json')), 'undo to bring it back');
    await waitCount(win, 1);
  });

  it('empties the trash from the Trash row menu', async () => {
    const { win } = ctx;
    const id = ids[3];
    await win
      .locator('nav[aria-label="Library views"] button', { hasText: 'Trash' })
      .click({ button: 'right' });
    await menu(win, 'Empty trash');
    await win.locator('.dg-panel').getByRole('button', { name: 'Empty trash' }).click();
    await until(() => !existsSync(join(lib, 'images', `${id}.info`)), 'the trash to be emptied');
    await waitCount(win, 0);
    assert.equal((await ctx.call('getCounts')).trash, 0);
  });
});
