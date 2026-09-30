// Looking at items in the real app: detail view (zoom, fit, 100%, flip, grayscale, prev/next,
// rating keys), quick look, video playback through boogie:// (MP4 and WebM), GIF playback,
// compare, the slideshow (real full screen), and the floating reference window.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe } from 'node:test';
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
import { tile, waitCount } from './lib/ui.mjs';

describe('viewer', () => {
  let ctx;
  let lib;
  let id;
  const it = withShots(() => ctx);
  const stage = () =>
    ctx.win.evaluate(() => {
      const c = document.querySelector('.stage .content');
      const img = c?.querySelector('img');
      return {
        style: c?.getAttribute('style') ?? '',
        loaded: !!img && img.complete && img.naturalWidth > 0,
        src: img?.getAttribute('src') ?? null,
      };
    });
  const zoomLabel = () => ctx.win.locator('.detail .zoom').innerText();
  const idx = () => ctx.win.locator('.detail .idx').innerText();

  before(async () => {
    const f = makeFixtures();
    lib = freshLibrary('viewer');
    ctx = await launch({ name: 'viewer', open: lib });
    const names = ['red.png', 'wide.png', 'anim.gif', 'clip.mp4', 'clip.webm'];
    const added = await importFiles(ctx, names.map(f));
    id = Object.fromEntries(names.map((n, i) => [n.replace('.', '_'), added[i]]));
    await waitCount(ctx.win, 8);
  });
  after(() => ctx?.close());
  // A failed test must not leave a viewer open over the grid for the next one.
  beforeEach(async () => {
    for (let i = 0; i < 3; i++) {
      if (!(await ctx.win.$('.detail, .ql, .cmp, .present'))) break;
      await ctx.win.keyboard.press('Escape');
      await sleep(200);
    }
  });

  it('detail view: opens on double-click, zooms, fits, flips, grays, steps, rates', async () => {
    const { win } = ctx;
    await tile(win, id.wide_png).locator('.th').dblclick();
    await win.locator('.detail').waitFor();
    // The thumbnail shows first, then the full picture (served from boogie://file) replaces it.
    await until(async () => {
      const s = await stage();
      return s.loaded && /^boogie:\/\/file\//.test(s.src ?? '');
    }, 'the full picture to load');
    const fit = await zoomLabel();
    await win.keyboard.press('Control+0');
    await until(async () => (await zoomLabel()) === '100%', `100% (was ${fit})`);
    await win.keyboard.press('Control+=');
    await until(async () => parseInt(await zoomLabel()) > 100, 'zoomed in');
    await win.keyboard.press('Control+9');
    await until(async () => (await zoomLabel()) === fit, 'back to fit');
    await win.keyboard.press('Shift+H');
    await until(async () => /scaleX\(-1\)/.test((await stage()).style), 'flipped');
    await win.keyboard.press('Control+Alt+g');
    await until(async () => /grayscale\(1\)/.test((await stage()).style), 'grayscale');
    await win.keyboard.press('Shift+H');
    await win.keyboard.press('Control+Alt+g');
    const first = await idx();
    await win.keyboard.press('ArrowRight');
    await until(async () => (await idx()) !== first, 'next item');
    await win.keyboard.press('ArrowLeft');
    await until(async () => (await idx()) === first, 'previous item');
    await win.keyboard.press('3');
    await until(() => itemMeta(lib, id.wide_png).star === 3, 'rating key in the viewer');
    await win.keyboard.press('Escape');
    await win.locator('.detail').waitFor({ state: 'detached' });
  });

  it('quick look: Space opens, arrows step, Enter goes to detail', async () => {
    const { win } = ctx;
    await tile(win, id.red_png).locator('.th').click();
    await win.keyboard.press('Space');
    const ql = win.locator('.ql');
    await ql.waitFor();
    const n0 = await ql.locator('.cap .n').innerText();
    assert.equal(n0, 'red');
    await win.keyboard.press('ArrowRight');
    await until(async () => (await ql.locator('.cap .n').innerText()) !== n0, 'quick look step');
    await win.keyboard.press('Enter');
    await win.locator('.detail').waitFor();
    await win.keyboard.press('Escape');
    await tile(win, id.red_png).locator('.th').click();
    await win.keyboard.press('Space');
    await ql.waitFor();
    await win.keyboard.press('Space');
    await ql.waitFor({ state: 'detached' });
  });

  for (const [key, label] of [
    ['clip_mp4', 'MP4 (H.264)'],
    ['clip_webm', 'WebM (VP9)'],
  ]) {
    it(`plays a ${label} video from boogie:// with seeking`, async () => {
      const { win } = ctx;
      await tile(win, id[key]).locator('.th').dblclick();
      await win.locator('.detail video').waitFor();
      const v = await until(
        () =>
          win.evaluate(() => {
            const v = document.querySelector('.detail video');
            return v.readyState >= 2 && { w: v.videoWidth, d: v.duration, src: v.currentSrc };
          }),
        'the video to load',
      );
      assert.equal(v.w, 320);
      assert.ok(v.d > 1.5 && v.d < 2.5, `duration ${v.d}`);
      assert.match(v.src, /^boogie:\/\/file\//);
      await win.locator('.detail [aria-label="Play"]').click();
      await until(
        () => win.evaluate(() => document.querySelector('.detail video').currentTime > 0.3),
        'playback to advance',
      );
      // Seeking needs Range support in the protocol handler.
      const seeked = await win.evaluate(
        () =>
          new Promise((res) => {
            const v = document.querySelector('.detail video');
            v.pause();
            v.addEventListener('seeked', () => res(v.currentTime), { once: true });
            v.currentTime = 1.5;
            setTimeout(() => res(-1), 4000);
          }),
      );
      assert.ok(Math.abs(seeked - 1.5) < 0.1, `seek landed at ${seeked}`);
      await win.keyboard.press('Escape');
    });
  }

  it('plays a GIF (frames change) and the grid previews it on hover', async () => {
    const { win } = ctx;
    await tile(win, id.anim_gif).locator('.th').dblclick();
    await win.locator('.detail').waitFor();
    // Screenshots of the stage over about a second must show more than one frame.
    const seen = new Set();
    for (let i = 0; i < 12 && seen.size < 2; i++) {
      seen.add((await win.locator('.detail .stage').screenshot()).toString('base64'));
      await sleep(120);
    }
    assert.ok(seen.size >= 2, 'the GIF did not animate');
    await win.keyboard.press('Escape');
    // Hover in the grid swaps the tile to the original GIF after a moment.
    await tile(win, id.anim_gif).locator('.th').hover();
    await until(
      () =>
        win.evaluate(
          (id) =>
            /^boogie:\/\/file\//.test(document.querySelector(`[data-id="${id}"] img`)?.src ?? ''),
          id.anim_gif,
        ),
      'the hover preview',
    );
    // A video tile swaps in a muted <video> that scrubs with the pointer.
    await tile(win, id.clip_mp4).locator('.th').hover();
    await until(
      () =>
        win.evaluate(
          (id) => document.querySelector(`[data-id="${id}"] video.pv`)?.readyState >= 1,
          id.clip_mp4,
        ),
      'the video hover preview',
    );
    const box = await tile(win, id.clip_mp4).locator('.th').boundingBox();
    await win.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2);
    await until(
      () =>
        win.evaluate(
          (id) => document.querySelector(`[data-id="${id}"] video.pv`)?.currentTime > 1,
          id.clip_mp4,
        ),
      'scrubbing to 3/4 of the clip',
    );
  });

  it('compare: C with two selected shows them side by side, with split and overlay', async () => {
    const { win } = ctx;
    await tile(win, id.red_png).locator('.th').click();
    await tile(win, id.wide_png)
      .locator('.th')
      .click({ modifiers: ['Control'] });
    await win.keyboard.press('c');
    const cmp = win.locator('.cmp');
    await cmp.waitFor();
    assert.match(await cmp.locator('.ttl').innerText(), /Compare 2 items/);
    await until(
      () =>
        win.evaluate(
          () =>
            [...document.querySelectorAll('.cmp .stage img')].filter((i) => i.naturalWidth > 0)
              .length === 2,
        ),
      'both pictures to load',
    );
    const modes = cmp.getByRole('group', { name: 'Compare mode' });
    for (const m of await modes.getByRole('button').all()) await m.click();
    await win.keyboard.press('Escape');
    await cmp.waitFor({ state: 'detached' });
  });

  it('slideshow: F5 goes full screen, advances by itself, Esc leaves full screen', async () => {
    const { win, app } = ctx;
    await tile(win, id.red_png).locator('.th').click();
    await win.keyboard.press('F5');
    const show = win.locator('.present');
    await show.waitFor();
    const full = () =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen());
    await until(full, 'the window to go full screen');
    const c0 = await show.locator('.hud .c').innerText();
    await until(
      async () => (await show.locator('.hud .c').innerText()) !== c0,
      'auto-advance',
      8000,
    );
    await win.keyboard.press('Escape');
    await show.waitFor({ state: 'detached' });
    await until(async () => !(await full()), 'full screen to end');
  });

  it('reference window: always on top, shows the item, opacity keys, closes', async () => {
    const { win, app } = ctx;
    await tile(win, id.wide_png).locator('.th').click();
    const opened = app.waitForEvent('window');
    await win.keyboard.press('Control+o');
    const ref = await opened;
    await ref.waitForLoadState('domcontentloaded');
    await until(
      () => ref.evaluate(() => [...document.images].some((i) => i.naturalWidth > 0)),
      'the reference image to load',
    );
    const props = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Boogie Reference');
      return w && { onTop: w.isAlwaysOnTop(), frame: w.isResizable() };
    });
    assert.ok(props?.onTop, 'reference window is not always on top');
    await ref.keyboard.press('5');
    await until(
      async () => (await ref.locator('.pct').innerText()) === '50%',
      'opacity 50% from the 5 key',
    );
    const imgOpacity = await ref.evaluate(() => {
      const i = [...document.images].find((x) => x.naturalWidth > 0);
      let el = i;
      let o = 1;
      while (el) {
        o *= Number(getComputedStyle(el).opacity);
        el = el.parentElement;
      }
      return o;
    });
    assert.ok(Math.abs(imgOpacity - 0.5) < 0.05, `image opacity ${imgOpacity}`);
    await ref.keyboard.press('Escape').catch(() => {}); // the page closes itself mid-press
    await until(() => app.windows().length === 1, 'the reference window to close');
  });
});
