// Getting files in, in the real app: dropping files on the grid and on a folder, the duplicate
// question, "+ > Import files…" and "Import a folder…" (folders recreated), pasting files and a
// picture from the clipboard (the private X display's), and links dragged from a browser (a
// local web server, and a data: URL).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe } from 'node:test';
import {
  WORK,
  freshLibrary,
  itemMeta,
  launch,
  makeFixtures,
  rootMeta,
  scanItems,
  setClipboard,
  sleep,
  until,
  withShots,
} from './lib/harness.mjs';
import {
  dropFiles,
  dropUrl,
  folderRow,
  menu,
  nav,
  stubOpenDialog,
  waitCount,
  waitToast,
} from './lib/ui.mjs';

describe('import', () => {
  let ctx;
  let lib;
  let f;
  let server;
  let base;
  const it = withShots(() => ctx);
  const live = () => scanItems(lib).filter((m) => !m.isDeleted);
  const byName = (name) => live().find((m) => m.name === name);
  const started = Date.now();

  before(async () => {
    f = makeFixtures();
    lib = freshLibrary('import');
    ctx = await launch({ name: 'import', open: lib });
    // Pictures nothing else imports, so none of them counts as a duplicate.
    const make = (name, color, size) =>
      execFileSync('magick', ['-size', size, `xc:${color}`, join(WORK, name)]);
    make('paste-pic.png', '#123456', '57x33');
    make('web-pic.png', '#654321', '70x35');
    make('data-pic.png', '#abcdef', '9x9');
    // A tiny web server standing in for a website: one picture, and one page that isn't one.
    const png = readFileSync(join(WORK, 'web-pic.png'));
    server = createServer((req, res) => {
      if (req.url === '/art/wide-from-web.png') {
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
        res.end(png);
      } else res.writeHead(404).end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await ctx?.close();
    server?.close();
  });

  it('drops files from a file manager onto the grid', async () => {
    const { win } = ctx;
    const n0 = live().length;
    const accepted = await dropFiles(win, win.locator('.scroller'), [f('red.png'), f('blue.png')]);
    assert.ok(accepted, 'the grid did not accept a file drag');
    await until(() => byName('red') && byName('blue'), 'both files in the library');
    await waitCount(win, n0 + 2);
    await waitToast(win, /Imported 2 items/);
    const red = byName('red');
    assert.equal(red.ext, 'png');
    assert.equal(red.width, 64);
    assert.equal(red.height, 48);
  });

  it('asks about duplicates, and "Import anyway" keeps both', async () => {
    const { win } = ctx;
    const n0 = live().length;
    await dropFiles(win, win.locator('.scroller'), [f('red.png')]);
    await waitToast(win, /already in the library/);
    assert.equal(live().length, n0, 'a duplicate was imported without asking');
    await win
      .locator('.stack .toast', { hasText: 'already in the library' })
      .getByRole('button', { name: 'Review' })
      .click();
    const dlg = win.locator('.dg-panel');
    await dlg.getByRole('button', { name: 'Import anyway' }).click();
    await until(() => live().length === n0 + 1, 'the copy to be imported');
    await win.keyboard.press('Escape');
  });

  it('drops files on a folder row: imported into that folder', async () => {
    const { win } = ctx;
    const { id: folder } = await ctx.call('createFolder', 'Drops', null);
    await until(async () => (await folderRow(win, 'Drops').count()) > 0, 'Drops row');
    await dropFiles(win, folderRow(win, 'Drops'), [f('green.jpg')]);
    await until(() => byName('green')?.folders.includes(folder), 'green.jpg in Drops');
  });

  it('+ > Import files… and Import a folder… (subfolders become folders)', async () => {
    const { win, app } = ctx;
    await nav(win, 'All');
    await stubOpenDialog(app, [f('anim.gif'), f('clip.mp4')]);
    await win.locator('.tb [aria-label="Add"]').click();
    await menu(win, 'Import files');
    await until(() => byName('anim') && byName('clip'), 'the picked files');
    const clip = byName('clip');
    assert.ok(clip.duration > 1.5, `video duration ${clip.duration}`);

    await stubOpenDialog(app, [f('tree')]);
    await win.locator('.tb [aria-label="Add"]').click();
    await menu(win, 'Import a folder');
    await until(() => ['a1', 'a2', 'b1', 'top'].every(byName), 'the folder tree');
    const names = new Map();
    const walk = (list, path) =>
      list.forEach((x) => {
        names.set(x.id, [...path, x.name].join('/'));
        walk(x.children, [...path, x.name]);
      });
    walk(rootMeta(lib).folders, []);
    const where = (n) =>
      byName(n)
        .folders.map((id) => names.get(id))
        .join(',');
    assert.match(where('a2'), /Sub A\/Deeper$/, `a2 is in ${where('a2')}`);
    assert.match(where('b1'), /Sub B$/, `b1 is in ${where('b1')}`);
    assert.match(where('a1'), /Sub A$/, `a1 is in ${where('a1')}`);
  });

  it('pastes files and a picture from the clipboard (Ctrl+V)', async () => {
    const { win } = ctx;
    await nav(win, 'All');
    const list = join(WORK, 'clip-uris.txt');
    writeFileSync(list, `file://${encodeURI(f('wide.png'))}\r\n`);
    let stop = await setClipboard('text/uri-list', list);
    try {
      await win.locator('.scroller').focus();
      await win.keyboard.press('Control+v');
      await until(() => byName('wide'), 'the pasted file');
    } finally {
      stop();
    }
    stop = await setClipboard('image/png', join(WORK, 'paste-pic.png'));
    const n0 = live().length;
    try {
      await win.keyboard.press('Control+v');
      await until(() => live().length === n0 + 1, 'the pasted picture');
    } finally {
      stop();
    }
    const pasted = live().find((m) => /^Pasted image/.test(m.name));
    assert.ok(pasted, `pasted picture name: ${live().map((m) => m.name)}`);
    assert.equal(pasted.width, 57);
  });

  it('imports a link dragged from a browser, and a data: URL', async () => {
    const { win } = ctx;
    const url = `${base}/art/wide-from-web.png`;
    await dropUrl(win, win.locator('.scroller'), url);
    const item = await until(() => live().find((m) => m.url === url), 'the downloaded picture');
    assert.equal(item.width, 70);
    const dataUrl = `data:image/png;base64,${readFileSync(join(WORK, 'data-pic.png')).toString('base64')}`;
    const n0 = live().length;
    await dropUrl(win, win.locator('.scroller'), dataUrl);
    await until(() => live().length === n0 + 1, 'the data: URL picture');
    // A link that isn't a picture fails with a plain message instead of adding junk.
    await dropUrl(win, win.locator('.scroller'), `${base}/nothing-here.png`);
    await waitToast(win, /failed|couldn’t (be )?import/i);
    assert.equal(live().length, n0 + 1);
    await waitCount(win, live().length);
  });

  it('a file named like a picture that is not one is added as an icon, and Review says so', async () => {
    const { win } = ctx;
    const broken = join(WORK, 'broken.jpg');
    writeFileSync(broken, 'plain text, not a picture\n');
    await dropFiles(win, win.locator('.scroller'), [broken]);
    await until(() => byName('broken'), 'broken.jpg in the library');
    await waitToast(win, /1 only as an icon/);
    await win
      .locator('.stack .toast', { hasText: 'only as an icon' })
      .getByRole('button', { name: 'Review' })
      .click();
    const dlg = win.locator('.dg-panel');
    await dlg.getByRole('heading', { name: 'Added as icons only' }).waitFor({ timeout: 5000 });
    assert.match(await dlg.innerText(), /broken\.jpg/);
    await sleep(500); // the dialog fades in; the screenshot should show it settled
    await ctx.shot('icons-only');
    await win.keyboard.press('Escape');
  });

  it('every new item follows the Eagle rules on disk (mtime.json, lastModified)', async () => {
    const ours = live().filter((m) => m.modificationTime > started);
    assert.ok(ours.length >= 10, `only ${ours.length} new items`);
    // mtime.json is written a moment after the last change (Eagle does the same).
    const lagging = () => {
      const mtime = JSON.parse(readFileSync(join(lib, 'mtime.json'), 'utf8'));
      return ours.filter((m) => mtime[m.id] !== m.lastModified).map((m) => m.name);
    };
    await until(() => lagging().length === 0, 'mtime.json to list every new item').catch(() => {
      assert.deepEqual(lagging(), []);
    });
    assert.equal(JSON.parse(readFileSync(join(lib, 'mtime.json'), 'utf8')).all, live().length);
    for (const m of live().slice(0, 3)) assert.equal(itemMeta(lib, m.id).id, m.id);
  });
});
