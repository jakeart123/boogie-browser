// Selection with the mouse and keyboard in the real grid (Art Archive copy, read-only): click,
// Ctrl+click, Shift+click, rubber band (plain and Ctrl-additive), Ctrl+A, Escape, arrow keys,
// and the inspector following the primary item.
import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import { artLibrary, launch, sleep, until, withShots } from './lib/harness.mjs';
import { selectedIds, tile, tileIds } from './lib/ui.mjs';

describe('selection', () => {
  let ctx;
  const it = withShots(() => ctx);
  let ids;
  const selbar = () => ctx.win.locator('.selbar .n');

  before(async () => {
    ctx = await launch({ name: 'selection', open: artLibrary(), readOnly: true });
    ids = await tileIds(ctx.win);
  });
  after(() => ctx?.close());

  it('click selects one and the inspector shows it', async () => {
    const { win } = ctx;
    await tile(win, ids[2]).locator('.th').click();
    assert.deepEqual(await selectedIds(win), [ids[2]]);
    const item = await ctx.call('getItem', ids[2]);
    // Read-only library: the inspector shows plain text instead of fields.
    await until(
      async () => (await win.locator('.insp').innerText()).includes(item.name),
      'the inspector to show it',
    );
  });

  it('Ctrl+click toggles, Shift+click selects the range in display order', async () => {
    const { win } = ctx;
    await tile(win, ids[5])
      .locator('.th')
      .click({ modifiers: ['Control'] });
    assert.deepEqual(await selectedIds(win), [ids[2], ids[5]]);
    assert.equal(await selbar().innerText(), '2 selected');
    await tile(win, ids[5])
      .locator('.th')
      .click({ modifiers: ['Control'] });
    assert.deepEqual(await selectedIds(win), [ids[2]]);
    // Ctrl+click moved the anchor (Explorer/Finder rule), so start the range from a plain click.
    await tile(win, ids[2]).locator('.th').click();
    await tile(win, ids[7])
      .locator('.th')
      .click({ modifiers: ['Shift'] });
    assert.deepEqual(await selectedIds(win), ids.slice(2, 8));
    assert.match(await win.locator('.insp').innerText(), /6 items/);
  });

  it('Escape clears; Ctrl+A selects everything', async () => {
    const { win } = ctx;
    await win.keyboard.press('Escape');
    assert.deepEqual(await selectedIds(win), []);
    assert.equal(await win.locator('.selbar').count(), 0);
    await win.keyboard.press('Control+a');
    const total = (await ctx.call('getCounts')).all;
    assert.equal(await selbar().innerText(), `${total.toLocaleString('en-US')} selected`);
    await win.keyboard.press('Escape');
  });

  it('rubber band selects what it touches, and Ctrl adds to the selection', async () => {
    const { win } = ctx;
    const box = async (id) => tile(win, id).locator('.th').boundingBox();
    const a = await box(ids[0]);
    const b = await box(ids[1]);
    // Start in the gap left of the first tile, drag across the first two tiles.
    await win.mouse.move(a.x - 8, a.y + 10);
    await win.mouse.down();
    await win.mouse.move(b.x + 20, b.y + 30, { steps: 6 });
    await win.mouse.up();
    const got = await selectedIds(win);
    assert.ok(got.includes(ids[0]) && got.includes(ids[1]), `band selected ${got}`);
    const c = await box(ids[4]);
    await win.mouse.move(c.x - 8, c.y + c.height - 4);
    await win.keyboard.down('Control');
    await win.mouse.down();
    await win.mouse.move(c.x + 20, c.y + c.height - 20, { steps: 4 });
    await win.mouse.up();
    await win.keyboard.up('Control');
    const more = await selectedIds(win);
    assert.ok(more.includes(ids[0]) && more.includes(ids[4]), `Ctrl band gave ${more}`);
    // A plain click on empty space clears.
    await win.mouse.click(a.x - 8, a.y + 10);
    assert.deepEqual(await selectedIds(win), []);
  });

  it('arrow keys move the primary, Shift+arrow extends, Home/End jump', async () => {
    const { win } = ctx;
    await tile(win, ids[0]).locator('.th').click();
    await win.keyboard.press('ArrowRight');
    assert.deepEqual(await selectedIds(win), [ids[1]]);
    await win.keyboard.press('Shift+ArrowRight');
    assert.deepEqual(await selectedIds(win), [ids[1], ids[2]]);
    await win.keyboard.press('ArrowDown');
    const below = await selectedIds(win);
    assert.equal(below.length, 1);
    const [y0, y1] = await Promise.all(
      [ids[2], below[0]].map(async (id) => (await tile(win, id).boundingBox()).y),
    );
    assert.ok(y1 > y0 + 20, 'ArrowDown did not move to the row below');
    await win.keyboard.press('End');
    await sleep(300);
    const r = await ctx.call('query', { scope: { kind: 'all' }, filter: {}, sort: null });
    assert.deepEqual(await selectedIds(win), [r.ids.at(-1)]);
    await win.keyboard.press('Home');
    await sleep(300);
    assert.deepEqual(await selectedIds(win), [ids[0]]);
    await win.keyboard.press('Escape');
  });
});
