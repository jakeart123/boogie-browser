// The duplicate finder in the real app: exact copies (same bytes, another name) and similar
// images (a smaller copy), merging through the dialog (keeper gets the union of tags, folders,
// notes and rating; the rest go to the trash), Undo, and "Merge all exact groups".
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe } from 'node:test';
import {
  freshLibrary,
  importFiles,
  itemMeta,
  launch,
  makeFixtures,
  scanItems,
  until,
  withShots,
} from './lib/harness.mjs';
import { menu, waitCount } from './lib/ui.mjs';

describe('duplicates', () => {
  let ctx;
  let lib;
  const it = withShots(() => ctx);
  const ORIGINAL = 'LT24XY3DPJFLK'; // 0051.jpg in the sample library
  let copy;
  let smaller;
  let folder;

  before(async () => {
    const f = makeFixtures();
    lib = freshLibrary('dupes');
    ctx = await launch({ name: 'dupes', open: lib });
    [copy, smaller] = await importFiles(ctx, [f('copy of 0051.jpg'), f('smaller 0051.jpg')]);
    ({ id: folder } = await ctx.call('createFolder', 'Keepers', null));
    await ctx.call('updateItems', [copy], {
      addTags: ['from the copy'],
      addFolders: [folder],
      star: 4,
      annotation: 'note on the copy',
    });
    await waitCount(ctx.win, 5);
  });
  after(() => ctx?.close());
  beforeEach(async () => {
    if (await ctx.win.$('.dg-scrim'))
      await ctx.win
        .locator('.dg-x')
        .click()
        .catch(() => {});
  });

  async function findDupes(mode) {
    const { win } = ctx;
    await win.locator('.tb [aria-label="Add"]').click();
    await menu(win, 'Find duplicates');
    const dlg = win.locator('.dg-panel');
    await dlg.locator(`input[name=mode][value=${mode}]`).check();
    await dlg.getByRole('button', { name: 'Find duplicates' }).click();
    // The results phase has a "New search" button.
    await dlg.getByRole('button', { name: 'New search' }).waitFor({ timeout: 30_000 });
    return dlg;
  }

  it('finds exact copies whatever their name, and merges them (union, trash, undo)', async () => {
    const { win } = ctx;
    const dlg = await findDupes('exact');
    const groups = dlg.locator('section.grp');
    assert.equal(await groups.count(), 1, await dlg.innerText());
    const g = groups.first();
    // The group fades in: wait for its text rather than reading it the moment it exists.
    await until(
      async () => /copy of 0051/.test(await g.innerText()),
      'the group to show its items',
    );
    assert.match(await g.innerText(), /\b0051\b/);
    // Keep the original; the copy's tags, folder, note and rating move onto it.
    await g
      .locator('.m')
      .filter({ has: win.locator('.nm', { hasText: /^0051$/ }) })
      .locator('input[type=radio]')
      .check();
    await g.getByRole('button', { name: 'Merge' }).click();
    await until(() => itemMeta(lib, copy).isDeleted === true, 'the copy in the trash');
    const kept = itemMeta(lib, ORIGINAL);
    assert.ok(kept.tags.includes('from the copy'), `tags ${kept.tags}`);
    assert.ok(kept.tags.includes('Atelier Gerome'));
    assert.ok(kept.folders.includes(folder), 'folder not merged');
    assert.equal(kept.star, 4);
    assert.match(kept.annotation, /note on the copy/);
    // Undo from the merged group's line.
    await dlg.locator('.done').getByRole('button', { name: 'Undo' }).click();
    await until(() => itemMeta(lib, copy).isDeleted === false, 'the copy back');
    await until(
      () => !itemMeta(lib, ORIGINAL).tags.includes('from the copy'),
      'the keeper restored',
    );
    await win.keyboard.press('Escape');
  });

  it('finds the smaller copy as a similar image', async () => {
    const { win } = ctx;
    const dlg = await findDupes('similar');
    const text = await dlg.locator('section.grp').first().innerText();
    assert.match(text, /Similar images/);
    assert.match(text, /smaller 0051/);
    assert.match(text, /\b0051\b/);
    await win.keyboard.press('Escape');
  });

  it('"Merge all exact groups" merges every exact group in one go', async () => {
    const { win } = ctx;
    const dlg = await findDupes('exact');
    await dlg.getByRole('button', { name: 'Merge all exact groups' }).click();
    await dlg
      .getByRole('alertdialog')
      .getByRole('button', { name: /^Merge 1 group/ })
      .click();
    await until(
      () => scanItems(lib).filter((m) => m.isDeleted).length === 1,
      'one copy in the trash',
    );
    const hist = await ctx.call('listHistory', { limit: 1 });
    assert.equal(hist[0].kind, 'merge');
    await win.keyboard.press('Escape');
    // Ctrl+Z undoes the whole merge.
    await win.locator('.scroller').focus();
    await win.keyboard.press('Control+z');
    await until(() => scanItems(lib).every((m) => !m.isDeleted), 'the merge undone');
  });
});
