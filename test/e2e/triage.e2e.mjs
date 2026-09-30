// Triage mode in the real app, checked on disk: Ctrl+Shift+T starts on the view, 0 files into a
// picked folder, an empty number key asks for its folder and keeps it, letter keys tag and untag,
// Shift+digits rate, X trashes and U takes it back, S skips, Enter finishes, every change is one
// History entry, and Esc goes back to the grid as it was.
import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import {
  freshLibrary,
  importFiles,
  itemMeta,
  launch,
  makeFixtures,
  sleep,
  until,
  withShots,
} from './lib/harness.mjs';
import { selectedIds, tile, waitCount } from './lib/ui.mjs';

describe('triage', () => {
  let ctx;
  let lib;
  let folders;
  let selectedBefore;
  const it = withShots(() => ctx);
  const pos = () => ctx.win.locator('.tri .stage .pos').innerText();
  const current = async () => {
    const s = await ctx.win.evaluate(() =>
      document.querySelector('.qr.now')?.getAttribute('title'),
    );
    const all = await ctx.call('query', { scope: { kind: 'all' }, filter: {}, sort: null });
    const items = await ctx.call('getItems', all.ids);
    return items.find((i) => i.name === s)?.id;
  };
  const press = async (key) => {
    await ctx.win.keyboard.press(key);
    await sleep(250);
  };

  before(async () => {
    const f = makeFixtures();
    lib = freshLibrary('triage');
    ctx = await launch({ name: 'triage', open: lib });
    await importFiles(ctx, ['red.png', 'blue.png', 'green.jpg', 'wide.png'].map(f));
    await waitCount(ctx.win, 7);
    folders = {
      portraits: (await ctx.call('createFolder', 'Portraits', null)).id,
      landscapes: (await ctx.call('createFolder', 'Landscapes', null)).id,
    };
  });
  after(() => ctx?.close());

  it('starts on the view, files with 0 and with a new number key, and remembers the key', async () => {
    const { win } = ctx;
    const first = (await ctx.call('query', { scope: { kind: 'all' }, filter: {}, sort: null })).ids;
    await tile(win, first[2]).locator('.th').click(); // a selection to come back to
    selectedBefore = await selectedIds(win);
    await win.keyboard.press('Control+Shift+T');
    await win.locator('.tri').waitFor();
    assert.equal(await pos(), '1 of 7');

    const a = await current();
    await press('0');
    await win.locator('.chooser input').fill('Portraits');
    await win.keyboard.press('Enter');
    await until(() => itemMeta(lib, a).folders.includes(folders.portraits), 'filed on disk');
    await until(async () => (await pos()) === '2 of 7', 'on to the next item');

    // Key 9 has no folder yet (the library had none when triage started): it asks, then files.
    const b = await current();
    await press('9');
    await win.locator('.chooser').waitFor();
    await win.locator('.chooser input').fill('Landscapes');
    await win.keyboard.press('Enter');
    await until(() => itemMeta(lib, b).folders.includes(folders.landscapes), 'filed with key 9');
    assert.equal(await win.locator('.krow.f .key').nth(8).locator('.nm').innerText(), 'Landscapes');
    const c = await current();
    await press('9');
    await until(() => itemMeta(lib, c).folders.includes(folders.landscapes), 'key 9 remembered');
  });

  it('tags and untags with a letter, rates with Shift+digits, stays on the item', async () => {
    const { win } = ctx;
    const d = await current();
    const at = await pos();
    // Key D is empty in this small library: it asks for a tag; a new name makes a new tag.
    await press('d');
    await win.locator('.chooser input').fill('Triaged');
    await win.keyboard.press('Enter');
    await until(() => itemMeta(lib, d).tags.includes('Triaged'), 'tagged on disk');
    await press('d');
    await until(() => !itemMeta(lib, d).tags.includes('Triaged'), 'untagged on disk');
    await press('Shift+4');
    await until(() => itemMeta(lib, d).star === 4, 'rated on disk');
    assert.equal(await pos(), at, 'tags and ratings stay on the item');
    await press('Enter');
    await until(async () => (await pos()) !== at, 'Enter goes on');
  });

  it('X trashes and moves on, U takes it back and shows it again, S skips', async () => {
    const { win } = ctx;
    const e = await current();
    const at = await pos();
    await press('x');
    await until(() => itemMeta(lib, e).isDeleted === true, 'trashed on disk');
    await until(async () => (await pos()) !== at, 'moved on');
    await press('u');
    await until(() => itemMeta(lib, e).isDeleted === false, 'restored on disk');
    await until(async () => (await pos()) === at, 'back on that item');
    await press('s');
    await until(async () => (await pos()) !== at, 'skipped');
    await ctx.shot('mid-session');
    const history = await ctx.call('listHistory', { limit: 20 });
    // file (0), file (9), file (9), tag, untag, rate, trash, undo of the trash.
    assert.ok(history.length >= 8, `${history.length} history entries`);
    assert.equal(history[0].kind, 'undo');
    assert.equal(history[1].kind, 'trash');
    assert.match(await win.locator('.sess').innerText(), /3\s*filed/);
  });

  it('Esc goes back to the grid with the selection it had', async () => {
    const { win } = ctx;
    await press('Escape');
    await win.locator('.tri').waitFor({ state: 'detached' });
    assert.deepEqual(await selectedIds(win), selectedBefore);
    // The grid's own keys work again.
    await win.keyboard.press('Control+a');
    await until(async () => (await selectedIds(win)).length === 7, 'Ctrl+A in the grid');
  });

  it('suggests the tag a note names and Shift+its key tags every queued item with that note', async () => {
    const { win } = ctx;
    const all = await ctx.call('query', { scope: { kind: 'all' }, filter: {}, sort: null });
    const items = await ctx.call('getItems', all.ids);
    const byName = (n) => items.find((i) => i.name === n).id;
    const [red, green] = [byName('red'), byName('green')];
    await ctx.call('updateItems', [red, green], { annotation: 'Student of: Gerome' });
    await win.keyboard.press('Control+Shift+T');
    await win.locator('.tri').waitFor();
    for (let i = 0; i < 7 && (await current()) !== red; i++) await press('ArrowRight');
    assert.equal(await current(), red);
    const card = win.locator('.sg', { hasText: 'Tag Atelier Gerome' });
    await card.waitFor();
    // The core counts the queued items whose note says Gerome and that lack the tag: red, green.
    await until(async () => /Tag all 2/.test(await card.innerText()), 'the "Tag all 2" count');
    await press('Shift+A'); // key A holds Atelier Gerome (seeded from the library's tags)
    await win.locator('.dg-scrim button', { hasText: 'Continue' }).click();
    await until(
      () => [red, green].every((id) => itemMeta(lib, id).tags.includes('Atelier Gerome')),
      'both tagged on disk',
    );
    const [entry] = await ctx.call('listHistory', { limit: 1 });
    assert.equal(entry.itemCount, 2, 'one history entry for both');
    await press('Escape');
  });

  it('a held key acts once, and the keys of the app behind Triage do nothing', async () => {
    const { win } = ctx;
    const inTrash = async () =>
      (await ctx.call('query', { scope: { kind: 'trash' }, filter: {}, sort: null })).ids.length;
    const before = await inTrash();
    await win.keyboard.press('Control+Shift+T');
    await win.locator('.tri').waitFor();
    // One press and six auto-repeats, like holding X for a moment.
    await win.keyboard.down('x');
    for (let i = 0; i < 6; i++) (await sleep(30), await win.keyboard.down('x'));
    await win.keyboard.up('x');
    await sleep(1000);
    assert.equal((await inTrash()) - before, 1, 'one item trashed, not seven');
    await press('u');
    await until(async () => (await inTrash()) === before, 'U brought it back');
    // F5 (slideshow) and Ctrl+Shift+N (new folder field in the sidebar) belong to the app behind.
    await press('F5');
    await press('Control+Shift+N');
    assert.equal(await win.$('[aria-label=Slideshow]'), null, 'no slideshow over Triage');
    assert.equal(await win.$('.sb-input'), null, 'no hidden new-folder field');
    assert.ok(await win.evaluate(() => document.querySelector('.main')?.inert), 'the app is inert');
    await press('Escape');
    await win.locator('.tri').waitFor({ state: 'detached' });
  });
});
