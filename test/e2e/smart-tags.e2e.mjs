// Smart folders, quick access, the tag manager and tag groups in the real app, checked in the
// library's files: create and edit a smart folder with the rule builder and see it match, add
// and remove Quick Access entries, rename / merge / delete tags, and make a tag group.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe } from 'node:test';
import {
  freshLibrary,
  importFiles,
  launch,
  makeFixtures,
  rootMeta,
  scanItems,
  sleep,
  until,
  withShots,
} from './lib/harness.mjs';
import { folderRow, menu, waitCount, waitToast } from './lib/ui.mjs';

describe('smart folders, quick access, tags', () => {
  let ctx;
  let lib;
  let ids;
  const it = withShots(() => ctx);
  const smart = (name) => rootMeta(lib).smartFolders.find((s) => s.name === name);
  const smartRow = (name) =>
    ctx.win
      .locator(
        `section[aria-label="Smart Folders"] .sb-row[title="${name}"], .sb-row.tree[title="${name}"]`,
      )
      .first();
  const tagged = (t) => scanItems(lib).filter((m) => !m.isDeleted && m.tags.includes(t)).length;

  before(async () => {
    const f = makeFixtures();
    lib = freshLibrary('smart');
    ctx = await launch({ name: 'smart', open: lib });
    ids = await importFiles(ctx, [f('red.png'), f('blue.png'), f('green.jpg')]);
    await ctx.call('updateItems', [ids[0], ids[1]], { addTags: ['flat'] });
    await ctx.call('updateItems', [ids[2]], { addTags: ['matte'] });
    await waitCount(ctx.win, 6);
  });
  after(() => ctx?.close());
  beforeEach(async () => {
    if (await ctx.win.$('.dg-scrim')) await ctx.win.keyboard.press('Escape');
  });

  it('creates a smart folder with the rule builder; it matches and keeps up to date', async () => {
    const { win } = ctx;
    await win.getByRole('button', { name: 'Folder options' }).click();
    await menu(win, 'New smart folder');
    const dlg = win.locator('.dg-panel');
    await dlg.locator('#sf-name').fill('Reds');
    await dlg.getByRole('textbox', { name: 'Text to look for' }).fill('red');
    await dlg.getByRole('button', { name: 'Create' }).click();
    await until(() => smart('Reds'), 'the smart folder in metadata.json');
    const rule = smart('Reds').conditions[0].rules[0];
    assert.deepEqual([rule.property, rule.method, rule.value], ['name', 'contain', 'red']);
    await smartRow('Reds').click();
    await waitCount(win, 1);
    // A new matching item shows up without touching the smart folder.
    await ctx.call('updateItems', [ids[1]], { name: 'blue but red' });
    await waitCount(win, 2);
  });

  it('edits the rules (property, method, value) and the result follows', async () => {
    const { win } = ctx;
    await smartRow('Reds').click({ button: 'right' });
    await menu(win, 'Edit');
    const dlg = win.locator('.dg-panel');
    await dlg.getByRole('combobox', { name: 'Property' }).selectOption({ label: 'Tags' });
    await sleep(200);
    const tagIn = dlg.getByPlaceholder('Add a tag').first();
    await tagIn.fill('flat');
    await tagIn.press('Enter');
    await dlg.locator('#sf-name').fill('Flat ones');
    await dlg.getByRole('button', { name: 'Save' }).click();
    await until(() => smart('Flat ones')?.conditions[0].rules[0].property === 'tags', 'saved rule');
    await smartRow('Flat ones').click();
    await waitCount(win, 2);
  });

  it('Quick Access: add a folder and a smart folder, then remove one', async () => {
    const { win } = ctx;
    await ctx.call('createFolder', 'Favs', null);
    await until(async () => (await folderRow(win, 'Favs').count()) > 0, 'Favs row');
    await folderRow(win, 'Favs').click({ button: 'right' });
    await menu(win, 'Add to Quick Access');
    await smartRow('Flat ones').click({ button: 'right' });
    await menu(win, 'Add to Quick Access');
    await until(() => rootMeta(lib).quickAccess.length === 2, 'two quick access entries');
    const qa = win.locator('section[aria-label="Quick Access"]');
    await qa.waitFor();
    assert.match(await qa.innerText(), /Favs/);
    await qa.locator('.sb-row', { hasText: 'Favs' }).click({ button: 'right' });
    await menu(win, 'Remove from Quick Access');
    await until(() => rootMeta(lib).quickAccess.length === 1, 'one left');
  });

  it('deletes the smart folder (items untouched)', async () => {
    const { win } = ctx;
    await smartRow('Flat ones').click({ button: 'right' });
    await menu(win, 'Delete');
    await win.locator('.dg-panel').getByRole('button', { name: 'Delete smart folder' }).click();
    await until(() => !smart('Flat ones'), 'gone from metadata.json');
    assert.equal(tagged('flat'), 2);
  });

  /** The row's buttons only show on hover. */
  const tagAction = async (dlg, tag, action) => {
    await dlg
      .locator('.row', { has: ctx.win.locator('.nm', { hasText: new RegExp(`^${tag}$`) }) })
      .hover();
    await dlg.getByRole('button', { name: `${action} ${tag}` }).click();
  };

  it('tag manager: rename, merge into an existing tag, delete', async () => {
    const { win } = ctx;
    await win.getByRole('button', { name: 'Manage tags' }).click();
    const dlg = win.locator('.dg-panel');
    await tagAction(dlg, 'flat', 'Rename');
    await dlg.getByRole('textbox', { name: 'New name for flat' }).fill('plain');
    await dlg.getByRole('button', { name: 'Rename', exact: true }).click();
    await until(() => tagged('plain') === 2 && tagged('flat') === 0, 'renamed on disk');
    await tagAction(dlg, 'matte', 'Rename');
    await dlg.getByRole('textbox', { name: 'New name for matte' }).fill('plain');
    await dlg.getByRole('button', { name: 'Rename', exact: true }).click();
    await dlg.getByRole('button', { name: 'Merge tags' }).click();
    await until(() => tagged('plain') === 3 && tagged('matte') === 0, 'merged on disk');
    await tagAction(dlg, 'Atelier Gerome', 'Delete');
    await dlg.getByRole('button', { name: 'Delete tag' }).click();
    await until(() => tagged('Atelier Gerome') === 0, 'deleted from every item');
    assert.equal(
      scanItems(lib).filter((m) => !m.isDeleted).length,
      6,
      'deleting a tag removed items',
    );
  });

  it('tag groups: create one and put a tag in it (with the Eagle warning)', async () => {
    const { win } = ctx;
    const dlg = win.locator('.dg-panel');
    if (!(await dlg.count())) await win.getByRole('button', { name: 'Manage tags' }).click();
    await dlg.getByRole('button', { name: 'New group' }).click();
    await dlg.getByRole('textbox', { name: 'Group name' }).fill('Finishes');
    await dlg.getByRole('button', { name: 'Add', exact: true }).click();
    await until(() => rootMeta(lib).tagsGroups.some((g) => g.name === 'Finishes'), 'group saved');
    await tagAction(dlg, 'plain', 'Groups for');
    await menu(win, 'Add to group', 'Finishes');
    await until(
      () =>
        rootMeta(lib)
          .tagsGroups.find((g) => g.name === 'Finishes')
          ?.tags.includes('plain'),
      'tag in the group',
    );
    assert.match(await dlg.innerText(), /don.t reach Eagle/);
    await win.keyboard.press('Escape');
    // The sidebar's tag list shows the group as a heading.
    const tags = win.locator('section[aria-label="All tags"]');
    await tags.locator('.sb-sec-toggle').click();
    await until(async () => (await tags.innerText()).includes('Finishes'), 'group heading');
    await waitToast(win, /./).catch(() => {});
  });
});
