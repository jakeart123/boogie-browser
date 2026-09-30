// Formats a browser can't show on its own, in the real app on the Art Archive copy (read-only):
// PSD and TIFF get a rendered boogie://preview, AVIF and WebP show as they are, and a PDF opens in
// Electron's own PDF viewer. Thumbnails of all of them load in the grid.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe } from 'node:test';
import { artLibrary, launch, sleep, until, withShots } from './lib/harness.mjs';
import { tile, tileIds } from './lib/ui.mjs';

describe('formats', () => {
  let ctx;
  const it = withShots(() => ctx);

  before(async () => {
    ctx = await launch({ name: 'formats', open: artLibrary(), readOnly: true });
  });
  after(() => ctx?.close());
  beforeEach(async () => {
    const { win } = ctx;
    if (await win.$('.detail')) await win.keyboard.press('Escape');
    if (await win.$('.filt .clear')) await win.locator('.filt .clear').click();
  });

  /** Filter the grid to one extension with the type popover, and open the first item. */
  async function openFirst(ext) {
    const { win } = ctx;
    await win.locator('.scroller').focus();
    await win.keyboard.press('Alt+e');
    await win.locator('.pop[role=dialog]').getByRole('button', { name: ext, exact: true }).click();
    await win.keyboard.press('Escape');
    await until(async () => {
      const ids = await tileIds(win);
      return ids.length && (await ctx.call('getItem', ids[0])).ext.toUpperCase() === ext && ids;
    }, `${ext} items in the grid`);
    const ids = await tileIds(win);
    // A tile asks for its thumbnail once it has been in view a moment: wait until every tile has
    // its picture (or its file-type placeholder), then report the pictures' widths.
    const thumbs = await until(async () => {
      const w = await win.$$eval('.scroller .tile', (tiles) =>
        tiles.map((t) => {
          const i = t.querySelector('img');
          return i ? (i.complete ? i.naturalWidth : -1) : t.querySelector('.ph') ? null : -1;
        }),
      );
      return w.length && w.every((x) => x !== -1) && w.filter((x) => x !== null);
    }, `${ext} thumbnails`);
    await tile(win, ids[0]).locator('.th').dblclick();
    await win.locator('.detail').waitFor();
    return { ids, thumbs };
  }

  const stageImage = () =>
    ctx.win.evaluate(() => {
      const img = document.querySelector('.detail .stage .content img');
      return img && { w: img.naturalWidth, src: img.getAttribute('src') ?? '' };
    });

  for (const [ext, scheme] of [
    ['PSD', 'preview'],
    ['TIF', 'preview'],
    ['AVIF', 'file'],
    ['WEBP', 'file'],
  ]) {
    it(`${ext}: thumbnails load and the detail view shows boogie://${scheme}`, async () => {
      const { thumbs } = await openFirst(ext);
      await sleep(300);
      assert.ok(thumbs.length && thumbs.every((w) => w !== 0), `broken thumbnails: ${thumbs}`);
      const img = await until(async () => {
        const s = await stageImage();
        return s && s.w > 0 && s.src.startsWith(`boogie://${scheme}/`) && s;
      }, `the ${ext} picture from boogie://${scheme}`);
      assert.ok(img.w > 100);
    });
  }

  it('PDF: opens in Electron’s PDF viewer, with a preview image one click away', async () => {
    const { win } = ctx;
    await openFirst('PDF');
    await until(
      () =>
        win
          .frames()
          .some((f) => f.url().startsWith('chrome-extension://') && f.url().includes('index.html')),
      'the PDF viewer',
    );
    await win.locator('.detail').getByRole('button', { name: 'Show preview image' }).click();
    await until(async () => {
      const s = await stageImage();
      return s && s.w > 0 && s.src.startsWith('boogie://preview/');
    }, 'the rendered first page');
  });
});
