// The detail view's item keys and menu in the real app: Ctrl+C, Delete (trash, Undo, and delete
// for good in the Trash), Shift+1-5, Ctrl+Delete in a folder, Ctrl+Shift+O, the right-click menu,
// double-click to close, Illustrator/EPS files drawn through the preview, a play-once GIF with a
// big first frame, video frames (copy, save, use as the thumbnail), and the reference window
// stepping through the viewer's list.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it as plainIt } from 'node:test';
import {
  FIXTURES,
  WORK,
  freshLibrary,
  importFiles,
  itemMeta,
  launch,
  makeFixtures,
  readClipboard,
  sleep,
  until,
  withShots,
} from './lib/harness.mjs';
import { menu, shellCalls, stubShell, tile, toasts, waitCount, waitToast } from './lib/ui.mjs';

describe('viewer keys', () => {
  let ctx;
  let lib;
  let id;
  const it = withShots(() => ctx);
  const idx = () => ctx.win.locator('.detail .idx').innerText();
  const title = () => ctx.win.locator('.detail .name').innerText();
  const open = async (itemId) => {
    await tile(ctx.win, itemId).locator('.th').dblclick();
    await ctx.win.locator('.detail').waitFor();
  };

  before(async () => {
    const f = makeFixtures();
    // An EPS (icon-only for Eagle) and a play-once GIF whose first frame is over 64 KB.
    const eps = join(FIXTURES, 'drawing.eps');
    if (!existsSync(eps)) execFileSync('magick', [f('wide.png'), eps]);
    // Two frames of noise (over 100 KB each) and no loop block: it plays once.
    const bigOnce = join(FIXTURES, 'bigonce.gif');
    if (!existsSync(bigOnce)) {
      const frame = (seed) => {
        const out = join(FIXTURES, `noise${seed}.png`);
        execFileSync(
          'magick',
          ['-size', '300x300', 'plasma:fractal', '-seed', String(seed)].concat([
            '+noise',
            'Random',
            out,
          ]),
        );
        return out;
      };
      execFileSync('magick', ['-delay', '50', frame(3), frame(4), '-loop', '1', bigOnce]);
    }
    const names = ['red.png', 'blue.png', 'green.jpg', 'wide.png', 'clip.mp4'];
    const paths = [...names.map(f), eps, bigOnce];
    lib = freshLibrary('viewer-keys');
    ctx = await launch({ name: 'viewer-keys', open: lib });
    const added = await importFiles(ctx, paths);
    id = Object.fromEntries(paths.map((p, i) => [p.split('/').pop(), added[i]]));
    await waitCount(ctx.win, 3 + paths.length);
    await ctx.call('updateItems', [id['green.jpg']], { url: 'https://example.com/green' });
    await stubShell(ctx.app);
  });
  after(() => ctx?.close());
  beforeEach(async () => {
    for (let i = 0; i < 3 && (await ctx.win.$('.detail, .menu[role=menu], .dg-scrim')); i++) {
      await ctx.win.keyboard.press('Escape');
      await sleep(200);
    }
  });

  it('Ctrl+C copies the item on screen; Shift+3 rates it and moves on', async () => {
    const { win } = ctx;
    await open(id['red.png']);
    await win.keyboard.press('Control+c');
    await waitToast(win, /Copied 1 item/);
    assert.match(readClipboard('TARGETS').toString(), /image\/png/);
    const before = await idx();
    await win.keyboard.press('Shift+3');
    await until(() => itemMeta(lib, id['red.png']).star === 3, 'the rating on disk');
    await until(async () => (await idx()) !== before, 'the next item');
  });

  it('Delete trashes and shows the next item, with Undo; in the Trash it deletes for good', async () => {
    const { win } = ctx;
    await open(id['blue.png']);
    const [, total] = (await idx()).split('/').map((s) => Number(s.trim()));
    await win.keyboard.press('Delete');
    await until(() => itemMeta(lib, id['blue.png']).isDeleted === true, 'isDeleted on disk');
    await until(
      async () => Number((await idx()).split('/')[1]) === total - 1,
      'the viewer list to lose it',
    );
    assert.notEqual(await title(), 'blue');
    const toast = await waitToast(win, /Moved to the trash/);
    assert.match(toast, /Undo/);
    await win
      .locator('.stack > *', { hasText: 'Moved to the trash' })
      .locator('button', { hasText: 'Undo' })
      .click();
    await until(() => itemMeta(lib, id['blue.png']).isDeleted === false, 'undone on disk');
    await win.keyboard.press('Escape');

    // In the Trash: Delete asks, then the item leaves the library.
    await ctx.call('trashItems', [id['blue.png']]);
    await win.locator('nav[aria-label="Library views"] button', { hasText: /^\s*Trash\b/ }).click();
    await open(id['blue.png']);
    await win.keyboard.press('Delete');
    await win.locator('.dg-scrim').waitFor();
    await win.locator('.dg-scrim button', { hasText: /^Delete$/ }).click();
    await until(
      () => !existsSync(join(lib, 'images', `${id['blue.png']}.info`)),
      'the item folder to leave the library',
    );
    await win.locator('nav[aria-label="Library views"] button', { hasText: /^\s*All\b/ }).click();
  });

  it('Ctrl+Delete takes the item out of the folder you are in', async () => {
    const { win } = ctx;
    const { id: folder } = await ctx.call('createFolder', 'Keys test', null);
    await ctx.call('updateItems', [id['wide.png'], id['green.jpg']], { addFolders: [folder] });
    await win.locator(`.sb-row.tree[title="Keys test"]`).first().click();
    await waitCount(win, 2);
    await open(id['wide.png']);
    await win.keyboard.press('Control+Delete');
    await until(
      () => !itemMeta(lib, id['wide.png']).folders.includes(folder),
      'the folder gone from the item on disk',
    );
    await until(async () => (await idx()) === '1 / 1', 'the viewer list to lose it');
    await win.keyboard.press('Escape');
    await win.locator('nav[aria-label="Library views"] button', { hasText: /^\s*All\b/ }).click();
  });

  it('Ctrl+Shift+O opens the source link; the right-click menu acts on the item on screen', async () => {
    const { win, app } = ctx;
    const item = (await ctx.call('getItems', [id['green.jpg']]))[0];
    await open(id['green.jpg']);
    await win.keyboard.press('Control+Shift+O');
    await until(
      async () =>
        (await shellCalls(app)).some(
          ([k, u]) => k === 'external' && u === 'https://example.com/green',
        ),
      'shell.openExternal with the source link',
    );
    await win.locator('.detail .body').click({ button: 'right', position: { x: 200, y: 200 } });
    await menu(win, 'Copy file path');
    await until(() => readClipboard('UTF8_STRING').toString() === item.filePath, 'the path');
    await win.locator('.detail .body').click({ button: 'right', position: { x: 200, y: 200 } });
    await menu(win, 'Rate', '★★★★★');
    await until(() => itemMeta(lib, id['green.jpg']).star === 5, 'rated 5 from the menu');
    await ctx.shot('detail-menu');
  });

  it('double-click on the picture closes the detail view', async () => {
    const { win } = ctx;
    await open(id['red.png']);
    await win.locator('.detail .stage').first().dblclick();
    await win.locator('.detail').waitFor({ state: 'detached' });
  });

  it('shows an EPS through the preview Boogie draws, not as a file icon', async () => {
    const { win } = ctx;
    await open(id['drawing.eps']);
    await until(
      () =>
        win.evaluate(() =>
          [...document.querySelectorAll('.detail .stage img')].some(
            (i) => /^boogie:\/\/preview\//.test(i.src) && i.naturalWidth > 0,
          ),
        ),
      'the rendered EPS',
      30_000,
    );
    assert.equal(await win.$('.detail .fp'), null);
  });

  it('a play-once GIF with a big first frame gets the frame player', async () => {
    const { win } = ctx;
    await open(id['bigonce.gif']);
    const pill = win.locator('.detail .gif');
    await pill.waitFor({ timeout: 15_000 });
    assert.match(await pill.innerText(), /\/ 2/);
  });

  it('video: Shift+C copies the frame, Shift+S saves it', async () => {
    const { win, app } = ctx;
    const saveTo = join(WORK, 'viewer-keys-frame.png');
    // A download asks where to save it; answer for the test instead of showing a dialog.
    await app.evaluate(({ session }, path) => {
      session.defaultSession.on('will-download', (_e, item) => item.setSavePath(path));
    }, saveTo);
    await open(id['clip.mp4']);
    await until(
      () => win.evaluate(() => document.querySelector('.detail video')?.readyState >= 2),
      'the video to load',
    );
    await win.keyboard.press('Shift+C');
    await waitToast(win, /Copied the frame/);
    const png = readClipboard('image/png');
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    await win.keyboard.press('Shift+S');
    await until(
      () => existsSync(saveTo) && readFileSync(saveTo).subarray(1, 4).toString() === 'PNG',
      'the saved frame',
    );
    assert.deepEqual(
      (await toasts(win)).filter((x) => /Could not/.test(x)),
      [],
    );
  });

  plainIt('video: "Use this frame as the thumbnail" writes the item thumbnail', async () => {
    const { win } = ctx;
    await open(id['clip.mp4']);
    await win.locator('.detail .body').click({ button: 'right', position: { x: 200, y: 150 } });
    await menu(win, 'Use this frame as the thumbnail');
    await until(() => itemMeta(lib, id['clip.mp4']).customThumbnail === true, 'customThumbnail');
  });

  it('reference window: steps through the list the viewer was on (Left/Right, A/D)', async () => {
    const { win, app } = ctx;
    await open(id['red.png']);
    const opened = app.waitForEvent('window');
    await win.keyboard.press('Control+o');
    const ref = await opened;
    await ref.waitForLoadState('domcontentloaded');
    const kind = await ref.evaluate(() => window.boogie.windowKind);
    assert.ok(kind.itemIds.length > 1, `the window got ${kind.itemIds.length} ids`);
    const pos = () => ref.locator('.pos').innerText();
    const name = () => ref.locator('.name').innerText();
    await until(async () => (await name()) === 'red', 'the opened item');
    const start = await pos();
    const at = Number(start.split('/')[0]);
    await ref.keyboard.press(at > 1 ? 'ArrowLeft' : 'ArrowRight');
    await until(async () => (await pos()) !== start && (await name()) !== 'red', 'a step');
    await ref.keyboard.press(at > 1 ? 'd' : 'a');
    await until(async () => (await pos()) === start && (await name()) === 'red', 'back again');
    await ref.keyboard.press('Shift+H');
    await until(
      () =>
        ref.evaluate(() =>
          /scaleX\(-1\)/.test(document.querySelector('.content')?.getAttribute('style') ?? ''),
        ),
      'Shift+H flips like in the detail view',
    );
    await ref.keyboard.press('Escape').catch(() => {}); // the page closes itself mid-press
    await until(() => app.windows().length === 1, 'the reference window to close');
  });
});
