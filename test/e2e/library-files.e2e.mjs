// Round 4 features in the real app, checked in the library's own files where they write:
// star a tag (tags.json), save a filter and apply it again (saved-filters.json), copy an item's
// Eagle link, and the keyboard shortcut sheet.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe } from 'node:test';
import {
  freshLibrary,
  importFiles,
  launch,
  makeFixtures,
  readClipboard,
  readJson,
  until,
  withShots,
} from './lib/harness.mjs';
import { menu, tile, waitCount } from './lib/ui.mjs';

describe('tags.json, saved filters, links, shortcuts', () => {
  let ctx;
  let lib;
  let ids;
  let total;
  const it = withShots(() => ctx);
  const file = (name) => (existsSync(join(lib, name)) ? readJson(join(lib, name)) : null);

  before(async () => {
    const f = makeFixtures();
    lib = freshLibrary('library-files');
    ctx = await launch({ name: 'library-files', open: lib });
    ids = await importFiles(ctx, [f('red.png'), f('blue.png'), f('green.jpg')]);
    await ctx.call('updateItems', [ids[0], ids[1]], { addTags: ['flat'], star: 4 });
    total = (await ctx.call('getCounts')).all;
    await waitCount(ctx.win, total);
  });
  after(() => ctx?.close());
  beforeEach(async () => {
    if (await ctx.win.$('.dg-scrim')) await ctx.win.keyboard.press('Escape');
  });

  it('stars a tag from the sidebar: tags.json holds it and the Starred block shows it', async () => {
    const { win } = ctx;
    await win.locator('.sb-sec-toggle', { hasText: 'All tags' }).click();
    await win
      .locator('.sb-taglist button.sb-row', { hasText: 'flat' })
      .first()
      .click({ button: 'right' });
    await menu(win, 'Star');
    await until(() => file('tags.json')?.starredTags?.includes('flat'), 'starredTags in tags.json');
    await win.locator('.sb-taglist .sb-sub', { hasText: 'Starred' }).waitFor();
  });

  it('saves the filter bar as a saved filter and applies it again from the funnel', async () => {
    const { win } = ctx;
    await win.locator('.scroller').focus();
    await win.keyboard.press('Alt+r');
    await win.locator('.pop [aria-label="4 stars"]').click();
    await win.keyboard.press('Escape');
    await waitCount(win, 2);
    await win.locator('.filt button', { hasText: 'Save filter…' }).click();
    await win.locator('.dg-panel input.dg-input').fill('Four stars');
    await win.locator('.dg-foot .dg-btn.pri').click();
    await until(
      () => file('saved-filters.json')?.some?.((f) => f.name === 'Four stars'),
      'the entry in saved-filters.json',
    );
    await win.locator('.filt button', { hasText: 'Clear all' }).click();
    await waitCount(win, total);
    await win.getByRole('button', { name: 'Filters' }).click();
    await win.locator('.saved .row', { hasText: 'Four stars' }).click();
    await waitCount(win, 2);
  });

  it('Copy link puts Eagle’s item link on the clipboard', async () => {
    const { win } = ctx;
    await win.locator('.filt button', { hasText: 'Clear all' }).click();
    await tile(win, ids[2]).locator('.th').click({ button: 'right' });
    await menu(win, 'Copy link');
    await until(
      () => readClipboard('UTF8_STRING').toString() === `http://localhost:41595/item?id=${ids[2]}`,
      'the link on the clipboard',
    );
  });

  it('Ctrl+/ shows the keyboard shortcuts, built from the commands', async () => {
    const { win } = ctx;
    await win.locator('.scroller').focus();
    await win.keyboard.press('Control+/');
    const sheet = win.locator('.dg-panel', { hasText: 'Keyboard shortcuts' });
    await sheet.waitFor();
    assert.ok((await sheet.textContent()).includes('Copy tags'));
    await win.keyboard.press('Escape');
  });
});
