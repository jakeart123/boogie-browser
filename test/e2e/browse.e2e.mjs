// Browsing the 5.4k-item Art Archive copy (opened read-only): every scope agrees with what is on
// disk, the four layouts lay tiles out the way they should, zoom works, and scrolling stays smooth.
import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import {
  artLibrary,
  launch,
  rootMeta,
  scanItems,
  sleep,
  until,
  withShots,
} from './lib/harness.mjs';
import { folderRow, menu, nav, shownCount, tileIds, waitCount } from './lib/ui.mjs';

describe('browse', () => {
  let ctx;
  const it = withShots(() => ctx);
  let lib;
  let items;
  const live = () => items.filter((m) => !m.isDeleted);

  before(async () => {
    lib = artLibrary();
    items = scanItems(lib);
    ctx = await launch({ name: 'browse', open: lib, readOnly: true, size: [1600, 1000] });
  });
  after(() => ctx?.close());

  it('All, Uncategorized, Untagged and Trash match the library files', async () => {
    const { win } = ctx;
    const folderIds = new Set();
    const walk = (fs) => fs.forEach((f) => (folderIds.add(f.id), walk(f.children)));
    walk(rootMeta(lib).folders);
    const expect = {
      All: live().length,
      // Eagle counts an item whose folders all no longer exist as uncategorized too.
      Uncategorized: live().filter((m) => !m.folders?.some((f) => folderIds.has(f))).length,
      Untagged: live().filter((m) => !m.tags?.length).length,
      Trash: items.filter((m) => m.isDeleted).length,
    };
    for (const [name, n] of Object.entries(expect)) {
      await nav(win, name);
      await waitCount(win, n);
      const badge = await win
        .locator('nav[aria-label="Library views"] button', { hasText: name })
        .locator('.sb-ct')
        .innerText()
        .catch(() => '0');
      assert.equal(Number(badge.replace(/\D/g, '')), n, `${name} sidebar count`);
    }
  });

  it('Random shows everything, in a new order on every click', async () => {
    const { win } = ctx;
    await nav(win, 'All');
    await waitCount(win, live().length);
    const all = await tileIds(win);
    await nav(win, 'Random');
    await waitCount(win, live().length);
    await sleep(300);
    const r1 = await tileIds(win);
    assert.notDeepEqual(r1.slice(0, 20), all.slice(0, 20), 'Random is in the same order as All');
    await nav(win, 'All');
    await nav(win, 'Random');
    await sleep(500);
    const r2 = await tileIds(win);
    assert.notDeepEqual(r2.slice(0, 20), r1.slice(0, 20), 'a second click did not reshuffle');
  });

  it('a folder shows its own items, or its subfolders too, per "Show subfolder contents"', async () => {
    const { win } = ctx;
    const root = rootMeta(lib);
    const parent = root.folders.find((f) => f.children.length);
    const childIds = new Set();
    const walk = (fs) => fs.forEach((f) => (childIds.add(f.id), walk(f.children)));
    walk(parent.children);
    const own = live().filter((m) => m.folders?.includes(parent.id)).length;
    const deep = live().filter(
      (m) => m.folders?.includes(parent.id) || m.folders?.some((f) => childIds.has(f)),
    ).length;
    assert.ok(deep > own, 'fixture: the folder should have items only in its subfolder');
    await folderRow(win, parent.name).click();
    await waitCount(win, deep); // on by default
    assert.ok(await win.locator('.subfolders').count(), 'no subfolder strip');
    await win.locator('.tb .ttl').click();
    await menu(win, 'Show subfolder contents');
    await waitCount(win, own);
    await win.locator('.tb .ttl').click();
    await menu(win, 'Show subfolder contents');
    await waitCount(win, deep);
    // Clicking a subfolder card opens it.
    await win.locator('.subfolders .subf').first().click();
    await until(
      async () => (await win.locator('.tb .ttl .nm').innerText()) === parent.children[0].name,
      'the subfolder to open',
    );
  });

  it('a tag shows the items carrying it', async () => {
    const { win } = ctx;
    const counts = new Map();
    for (const m of live()) for (const t of m.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    const [tag, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
    const section = win.locator('section[aria-label="All tags"]');
    await section.locator('.sb-sec-toggle').click();
    await section.locator('button.sb-row', { hasText: tag }).first().click();
    await waitCount(win, n);
    assert.equal(await win.locator('.tb .ttl .nm').innerText(), tag);
    await section.locator('.sb-sec-toggle').click();
  });

  it('back and forward walk the scopes visited', async () => {
    const { win } = ctx;
    await nav(win, 'All');
    await nav(win, 'Trash');
    await win.keyboard.press('Alt+ArrowLeft');
    await until(async () => (await win.locator('.tb .ttl .nm').innerText()) === 'All', 'back');
    await win.keyboard.press('Alt+ArrowRight');
    await until(async () => (await win.locator('.tb .ttl .nm').innerText()) === 'Trash', 'fwd');
    await nav(win, 'All');
  });

  /** Tile boxes currently in the DOM: { x, y, w, h (image), top } relative to the scroller. */
  const boxes = () =>
    ctx.win.$$eval('.scroller .tile', (els) =>
      els.map((e) => {
        const th = e.querySelector('.th').getBoundingClientRect();
        return { x: th.left, y: th.top, w: th.width, h: th.height };
      }),
    );

  it('four layouts: justified rows fill the width, waterfall columns, square grid, list rows', async () => {
    const { win } = ctx;
    const setLayout = async (label) => {
      await win.locator('.tb .ttl').click();
      await menu(win, label);
      await sleep(400);
    };
    await setLayout('Justified');
    let b = await boxes();
    const rows = new Map();
    for (const t of b) rows.set(Math.round(t.y), [...(rows.get(Math.round(t.y)) ?? []), t]);
    const full = [...rows.values()].filter((r) => r.length > 2).slice(0, 3);
    const widths = full.map((r) => Math.round(r.at(-1).x + r.at(-1).w - r[0].x));
    assert.ok(new Set(widths.map((w) => Math.round(w / 3))).size === 1, `row widths ${widths}`);
    for (const r of full) assert.equal(new Set(r.map((t) => Math.round(t.h))).size, 1);

    await setLayout('Waterfall');
    b = await boxes();
    const ws = b.map((t) => t.w);
    assert.ok(Math.max(...ws) - Math.min(...ws) <= 1.5, `waterfall column widths ${ws}`);
    assert.ok(new Set(b.map((t) => Math.round(t.h))).size > 3, 'waterfall heights all equal');

    await setLayout('Grid');
    b = await boxes();
    assert.ok(
      b.every((t) => Math.abs(t.w - t.h) < 1.5),
      'grid cells are not square',
    );

    await setLayout('List');
    const rowsH = await win.$$eval('.scroller [data-id]', (els) =>
      els.slice(0, 5).map((e) => Math.round(e.getBoundingClientRect().height)),
    );
    assert.ok(rowsH.length && rowsH.every((h) => h === 44), `list rows ${rowsH}`);
    // List columns sort by clicking the header.
    const before = await tileIds(win);
    await win
      .locator('.scroller [role=columnheader], .scroller .head button', { hasText: 'Name' })
      .first()
      .click();
    await sleep(500);
    const after = await tileIds(win);
    assert.notDeepEqual(after.slice(0, 10), before.slice(0, 10), 'clicking Name did not sort');
    const settings = await ctx.call('getSettings');
    assert.equal(settings.layout, 'list', 'layout choice was not saved');
    await setLayout('Justified');
  });

  it('zoom slider and Ctrl+= / Ctrl+- resize thumbnails and are remembered', async () => {
    const { win } = ctx;
    // Grid cells are exactly the thumbnail size (justified rows are rescaled to fill the width).
    await win.locator('.tb .ttl').click();
    await menu(win, 'Grid');
    await sleep(300);
    const h0 = (await boxes())[0].h;
    const slider = win.locator('input[aria-label="Thumbnail size"]');
    await slider.fill('320');
    await sleep(300);
    const h1 = (await boxes())[0].h;
    assert.ok(h1 > h0 * 1.3, `slider: ${h0} -> ${h1}`);
    // The keys step the size (cells snap to whole columns, so check the size itself).
    await win.locator('.scroller').focus();
    await win.keyboard.press('Control+-');
    await win.keyboard.press('Control+-');
    assert.equal(Number(await slider.inputValue()), 280, 'Ctrl+- did not step the size');
    await win.keyboard.press('Control+=');
    assert.equal(Number(await slider.inputValue()), 300, 'Ctrl+= did not step the size');
    await until(
      async () => (await ctx.call('getSettings')).thumbSize < 320,
      'thumbSize saved',
      3000,
    );
    await slider.fill('190');
    await win.locator('.tb .ttl').click();
    await menu(win, 'Justified');
  });

  it('scrolls 5.4k items smoothly with a bounded DOM and loads thumbnails where it lands', async () => {
    const { win } = ctx;
    await nav(win, 'All');
    await waitCount(win, live().length);
    const stats = await win.evaluate(async () => {
      const sc = document.querySelector('.scroller');
      const max = sc.scrollHeight - sc.clientHeight;
      const frames = [];
      let maxTiles = 0;
      let last = performance.now();
      const t0 = last;
      // Scroll the whole grid top to bottom in ~4 s, one step per frame (like a fast wheel/fling).
      await new Promise((done) => {
        const step = () => {
          const now = performance.now();
          frames.push(now - last);
          last = now;
          const f = Math.min(1, (now - t0) / 4000);
          sc.scrollTop = f * max;
          maxTiles = Math.max(maxTiles, sc.querySelectorAll('.tile').length);
          if (f < 1) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      });
      frames.shift();
      frames.sort((a, b) => a - b);
      const pct = (p) => frames[Math.floor((frames.length - 1) * p)];
      return {
        height: sc.scrollHeight,
        frames: frames.length,
        median: pct(0.5),
        p95: pct(0.95),
        worst: frames.at(-1),
        over50: frames.filter((f) => f > 50).length,
        maxTiles,
      };
    });
    console.log('scroll stats', JSON.stringify(stats));
    await sleep(1500);
    const loaded = await win.$$eval('.scroller .tile img', (imgs) => {
      const sc = document.querySelector('.scroller').getBoundingClientRect();
      const vis = imgs.filter((i) => {
        const r = i.getBoundingClientRect();
        return r.bottom > sc.top && r.top < sc.bottom;
      });
      return { visible: vis.length, ok: vis.filter((i) => i.naturalWidth > 0).length };
    });
    console.log('thumbs at the bottom', JSON.stringify(loaded));
    assert.ok(stats.maxTiles < 400, `the DOM held ${stats.maxTiles} tiles`);
    assert.ok(stats.median < 34, `median frame ${stats.median.toFixed(1)} ms`);
    assert.ok(loaded.visible > 0 && loaded.ok === loaded.visible, JSON.stringify(loaded));
  });
});
