// Search and filters in the real app on a small library with known contents: the keyword grammar
// (AND, -exclude, OR / ||, "phrases", parentheses, any case, name/tag/note/url/folder/ext), and
// every filter popover (tags, rating, type, shape, dimensions, size, date, URL/notes, color,
// folders), with the filter bar's chips, counts and Clear all.
import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import {
  freshLibrary,
  importFiles,
  launch,
  makeFixtures,
  sleep,
  until,
  withShots,
} from './lib/harness.mjs';
import { shownCount, waitCount } from './lib/ui.mjs';

describe('search and filters', () => {
  let ctx;
  let id; // name -> id of the imported fixtures
  const TOTAL = 9;
  const it = withShots(() => ctx);

  before(async () => {
    const f = makeFixtures();
    ctx = await launch({ name: 'search', open: freshLibrary('search') });
    const names = ['red.png', 'blue.png', 'green.jpg', 'wide.png', 'anim.gif', 'clip.mp4'];
    const added = await importFiles(ctx, names.map(f));
    id = Object.fromEntries(names.map((n, i) => [n.split('.')[0], added[i]]));
    const { id: cool } = await ctx.call('createFolder', 'Cool', null);
    await ctx.call('updateItems', [id.red], {
      addTags: ['red', 'flat'],
      star: 5,
      annotation: 'a warm study',
      url: 'https://example.com/red',
    });
    await ctx.call('updateItems', [id.blue], {
      addTags: ['blue', 'flat'],
      star: 3,
      annotation: 'cool tones',
      addFolders: [cool],
    });
    await ctx.call('updateItems', [id.green], { addTags: ['green'] });
    await waitCount(ctx.win, TOTAL);
  });
  after(() => ctx?.close());

  /** Type a search in the command palette and pick "Search for …". */
  async function search(text) {
    const { win } = ctx;
    await win.keyboard.press('Control+k');
    const input = win.getByRole('combobox', { name: 'Search, filter, or run a command' });
    await input.fill(text);
    await win.locator('.po', { hasText: 'Search for' }).first().waitFor();
    await win.keyboard.press('Enter');
    await sleep(350);
  }
  const clearAll = async () => {
    const btn = ctx.win.locator('.filt .clear');
    if (await btn.count()) await btn.click();
    await waitCount(ctx.win, TOTAL);
  };

  it('keyword grammar matches what Eagle would', async () => {
    const cases = [
      ['red', 1],
      ['prank', 2],
      ['prank -julius', 1],
      ['red OR blue', 2],
      ['red || blue', 2],
      ['"prank at"', 1],
      ['(red || blue) flat', 2],
      ['(red || blue) -blue', 1],
      ['GEROME', 3], // tag "Atelier Gerome" and names, any case
      ['gif', 1], // extension
      ['cool', 1], // note and folder name
      ['example.com', 1], // source URL
      ['nothing-like-this', 0],
    ];
    const bad = [];
    for (const [q, n] of cases) {
      await search(q);
      await until(async () => !(await ctx.win.locator('.po').count()), 'palette to close', 3000);
      await sleep(300);
      const got = await shownCount(ctx.win);
      if (got !== n) bad.push(`${q} -> ${got} (want ${n})`);
    }
    assert.deepEqual(bad, []);
    // The chip shows the keywords, and "N of 9" on the right.
    await search('prank');
    await waitCount(ctx.win, 2);
    const bar = await ctx.win.locator('.filt').innerText();
    assert.match(bar, /prank/);
    assert.match(bar, /2\s*of\s*9/);
    // Ctrl+F reopens the palette with the current keywords.
    await ctx.win.keyboard.press('Control+f');
    const input = ctx.win.getByRole('combobox', { name: 'Search, filter, or run a command' });
    assert.equal(await input.inputValue(), 'prank');
    await ctx.win.keyboard.press('Escape');
    await clearAll();
  });

  it('tags filter: include, exclude, all', async () => {
    const { win } = ctx;
    await win.keyboard.press('Alt+t');
    const pop = win.locator('.pop[role=dialog]');
    await pop.locator('.row', { hasText: 'flat' }).click();
    await waitCount(win, 2);
    await pop.locator('.row', { hasText: /^\s*red/ }).click();
    await waitCount(win, 2); // any
    await pop.getByRole('button', { name: 'All' }).click();
    await waitCount(win, 1);
    await pop.locator('.row', { hasText: /^\s*red/ }).click(); // off again
    await pop.locator('.row', { hasText: 'flat' }).click({ button: 'right' }); // exclude
    await waitCount(win, TOTAL - 2);
    await win.keyboard.press('Escape');
    await clearAll();
  });

  it('rating, type and shape filters', async () => {
    const { win } = ctx;
    const pop = win.locator('.pop[role=dialog]');
    await win.keyboard.press('Alt+r');
    await pop.getByRole('button', { name: '5 stars' }).click();
    await waitCount(win, 1);
    await pop.getByRole('button', { name: '3 stars' }).click();
    await waitCount(win, 2);
    await win.keyboard.press('Escape');
    await clearAll();

    await win.keyboard.press('Alt+e');
    await pop.getByRole('button', { name: 'Videos' }).click();
    await waitCount(win, 1);
    await pop.getByRole('button', { name: 'Videos' }).click();
    await pop.getByRole('button', { name: 'GIF' }).click();
    await waitCount(win, 1);
    await win.keyboard.press('Escape');
    await clearAll();

    await win.keyboard.press('Alt+s');
    await pop.getByRole('button', { name: 'Square' }).click();
    await waitCount(win, 1); // the 64x64 GIF
    await pop.getByRole('button', { name: 'Square' }).click();
    await pop.getByRole('button', { name: 'Portrait', exact: true }).click();
    await waitCount(win, 4); // blue.png and the three scans
    await win.keyboard.press('Escape');
    await clearAll();
  });

  it('dimensions, size, date and URL/notes filters from the + Filter menu', async () => {
    const { win } = ctx;
    const pop = win.locator('.pop[role=dialog]');
    const pick = async (label) => {
      await win.keyboard.press('Control+Shift+f');
      await win.locator('.menu button[role=menuitem]', { hasText: label }).click();
    };
    await pick('Dimensions');
    await pop.getByRole('spinbutton', { name: 'Width minimum' }).fill('300');
    await waitCount(win, 4); // the scans and the 320 px video
    await win.keyboard.press('Escape');
    await clearAll();

    await pick('File size');
    await pop.getByRole('spinbutton', { name: 'Size maximum' }).fill('0.001');
    await waitCount(win, 4); // the tiny generated images and the GIF
    await win.keyboard.press('Escape');
    await clearAll();

    await pick('Duration');
    await pop.getByRole('spinbutton', { name: 'Length minimum' }).fill('1');
    await waitCount(win, 1); // the 2 s video
    await win.keyboard.press('Escape');
    await clearAll();

    await win.keyboard.press('Alt+s');
    await pop.getByRole('button', { name: '1:1' }).click();
    await waitCount(win, 1); // the 64x64 GIF
    await win.keyboard.press('Escape');
    await clearAll();

    await win.keyboard.press('Alt+d');
    await pop.getByRole('button', { name: 'Today' }).click();
    await waitCount(win, 6); // everything imported by this test
    await win.keyboard.press('Escape');
    await clearAll();

    await pick('Source URL and notes');
    await pop
      .getByRole('group', { name: 'Source URL' })
      .getByRole('button', { name: 'Has one' })
      .click();
    await waitCount(win, 1);
    await pop
      .getByRole('group', { name: 'Source URL' })
      .getByRole('button', { name: 'Any' })
      .click();
    await pop.getByRole('textbox', { name: 'Note contains' }).fill('cool');
    await waitCount(win, 1);
    await win.keyboard.press('Escape');
    await clearAll();
  });

  it('folder and color filters, chips remove one filter at a time', async () => {
    const { win } = ctx;
    const pop = win.locator('.pop[role=dialog]');
    await win.keyboard.press('Control+Shift+f');
    await win.locator('.menu button[role=menuitem]', { hasText: 'Folders' }).click();
    await pop.locator('.row', { hasText: 'Cool' }).click();
    await waitCount(win, 1);
    await win.keyboard.press('Escape');
    await clearAll();

    // Color: the red square's palette is (almost) all #d02020.
    await win.keyboard.press('Alt+c');
    const hex = pop.getByRole('textbox', { name: 'Hex color' });
    await hex.fill('#d02020');
    await hex.press('Enter');
    await until(async () => {
      const n = await shownCount(win);
      return n >= 1 && n < 5; // the GIF and the test video have red in them too
    }, 'the color filter to find the red square').catch(async (e) => {
      const bar = await win
        .locator('.filt')
        .innerText()
        .catch(() => '(no filter bar)');
      throw new Error(`${e.message}: shows ${await shownCount(win)}, bar: ${bar}`);
    });
    const ids = await win.$$eval('.scroller [data-id]', (els) => els.map((e) => e.dataset.id));
    assert.ok(ids.includes(id.red), 'red square not found by color');
    await win.keyboard.press('Escape');

    // Two filters, then remove one chip: the other stays.
    await win.keyboard.press('Alt+r');
    await pop.getByRole('button', { name: '5 stars' }).click();
    await win.keyboard.press('Escape');
    await waitCount(win, 1);
    const chips = win.locator('.filt [aria-label^="Remove filter"]');
    assert.equal(await chips.count(), 2);
    await chips.first().click();
    await until(async () => (await chips.count()) === 1, 'one chip left');
    await clearAll();
    assert.equal(await win.locator('.filt').count(), 0, 'the filter bar did not go away');
  });
});
