// The inspector's other jobs in the real app: palette swatches search by color, the preview
// opens the viewer, and with nothing selected in a folder it edits the folder itself (color,
// description, auto-tags, its sort) straight into the library's metadata.json.
import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import {
  freshLibrary,
  importFiles,
  launch,
  makeFixtures,
  rootMeta,
  sleep,
  until,
  withShots,
} from './lib/harness.mjs';
import { folderRow, menu, shownCount, tile, waitCount } from './lib/ui.mjs';

describe('inspector', () => {
  let ctx;
  let lib;
  let ids;
  const it = withShots(() => ctx);
  const insp = () => ctx.win.locator('.insp');
  const folder = () => rootMeta(lib).folders.find((f) => f.name === 'Colors');

  before(async () => {
    const f = makeFixtures();
    lib = freshLibrary('inspector');
    ctx = await launch({ name: 'inspector', open: lib });
    ids = await importFiles(ctx, [f('red.png'), f('blue.png')]);
    const { id } = await ctx.call('createFolder', 'Colors', null);
    await ctx.call('updateItems', ids, { addFolders: [id] });
    await waitCount(ctx.win, 5);
  });
  after(() => ctx?.close());

  it('a palette swatch searches by that color; the preview opens the viewer', async () => {
    const { win } = ctx;
    await tile(win, ids[1]).locator('.th').click();
    const sw = insp().locator('.pal .sw').first();
    await sw.waitFor();
    assert.match((await sw.getAttribute('aria-label')) ?? '', /100 percent/);
    await sw.click();
    await until(async () => (await win.locator('.filt').innerText()).includes('Color'), 'chip');
    await until(async () => {
      const n = await shownCount(win);
      return n >= 1 && n < 5;
    }, 'color results');
    const shown = await win.$$eval('.scroller [data-id]', (els) => els.map((e) => e.dataset.id));
    assert.ok(shown.includes(ids[1]), 'the blue square is not in its own color search');
    assert.ok(!shown.includes(ids[0]), 'the red square matched blue');
    await win.locator('.filt .clear').click();
    await waitCount(win, 5);
    await tile(win, ids[1]).locator('.th').click();
    await insp().getByRole('button', { name: 'Open blue' }).click();
    await win.locator('.detail').waitFor();
    await win.keyboard.press('Escape');
  });

  it('with nothing selected in a folder, edits the folder: color, description, auto-tag, sort', async () => {
    const { win } = ctx;
    await folderRow(win, 'Colors').click();
    await win.locator('.scroller').click({ position: { x: 700, y: 600 } }); // empty space: select nothing
    await sleep(200);
    await insp().getByRole('button', { name: 'green' }).click();
    await until(() => folder().iconColor === 'green', 'folder color from the inspector');
    const desc = insp().getByPlaceholder('Add a description…');
    await desc.fill('Flat color swatches');
    await desc.blur();
    await until(() => folder().description === 'Flat color swatches', 'description on disk');
    const tag = insp().getByPlaceholder('Add an auto-tag');
    await tag.fill('swatch');
    await tag.press('Enter');
    await until(() => folder().tags.includes('swatch'), 'auto-tag on disk');
    await insp().getByTitle('Change how this folder sorts').click();
    await menu(win, 'Name');
    await until(
      () => folder().orderBy === 'NAME' && folder().sortIncrease === true,
      'sort on disk',
    );
    assert.match(await insp().innerText(), /Name, ascending/);
  });
});
