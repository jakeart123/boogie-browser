// Read-only libraries in the real app: a library outside the places Boogie may edit opens
// read-only with a banner; every way of changing it is refused with a reason and nothing on disk
// changes; browsing still works; "Allow editing…" turns editing on; "Open read-only" from the
// Libraries dialog works too. A library in a Dropbox folder stays read-only until the Settings
// switch for Dropbox and external drives is turned on (toolbar button, confirmation), and goes
// back when it's turned off.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe } from 'node:test';
import {
  ROOT,
  WORK,
  freshLibrary,
  itemMeta,
  launch,
  makeFixtures,
  readJson,
  sleep,
  until,
  withShots,
} from './lib/harness.mjs';
import { dropFiles, menu, nav, tile, tileIds, waitCount, waitToast } from './lib/ui.mjs';

/** Every file under a folder with its size and mtime, to prove nothing was touched. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const s = statSync(p);
        out[p] = `${s.size}:${s.mtimeMs}`;
      }
    }
  };
  walk(dir);
  return out;
}

describe('read-only libraries', () => {
  let ctx;
  let lib;
  let before0;
  const it = withShots(() => ctx);
  // Only WORK/editable is writable in this run; the library lives next to it, outside.
  const editable = join(WORK, 'editable');

  before(async () => {
    makeFixtures();
    lib = freshLibrary('readonly');
    before0 = snapshot(lib);
    ctx = await launch({
      name: 'readonly',
      open: lib,
      settings: { writableRoots: [editable] },
      env: { BOOGIE_WRITABLE_ROOTS: editable },
    });
  });
  after(() => ctx?.close());

  it('opens read-only with a banner and says so in the sidebar', async () => {
    const { win } = ctx;
    const st = await ctx.call('getLibraryState');
    assert.equal(st.readOnly, true);
    assert.equal(st.readOnlyKind, 'guard');
    const banner = win.locator('.bar.warn');
    assert.match(await banner.innerText(), /Editing is off/);
    assert.ok(await banner.getByRole('button', { name: 'Allow editing…' }).count());
    assert.match(await win.locator('.lib .sub').innerText(), /Read-only/);
  });

  it('refuses every kind of edit with the reason, and browsing still works', async () => {
    const { win } = ctx;
    const ids = await tileIds(win);
    await tile(win, ids[0]).locator('.th').click();
    // Keys: rate, trash, tag window, new folder, rename (the rename window opens to say why).
    for (const key of ['3', 'Delete', 't', 'Control+Shift+n', 'F2']) {
      await win.keyboard.press(key);
      await sleep(150);
      if (await win.$('.dg-scrim, [aria-modal=true]')) {
        assert.match(await win.locator('[aria-modal=true]').first().innerText(), /Read-only/);
        await win.keyboard.press('Escape');
      }
    }
    await waitToast(win, /Read-only/);
    // Menus show edits disabled, with the reason as the tooltip.
    await tile(win, ids[0]).locator('.th').click({ button: 'right' });
    const trash = win.locator('.menu button[role=menuitem]', { hasText: 'Move to trash' });
    assert.ok(await trash.isDisabled());
    assert.match((await trash.getAttribute('title')) ?? '', /Read-only/);
    await win.keyboard.press('Escape');
    // The inspector shows text, not fields.
    assert.equal(await win.locator('.insp input[aria-label="Name"]').count(), 0);
    // Drops are refused (and must not navigate away).
    await dropFiles(win, win.locator('.scroller'), [join(WORK, 'fixtures/red.png')]);
    await sleep(800);
    assert.equal((await ctx.call('getCounts')).all, 3);
    assert.match(win.url(), /index\.html/);
    // The core refuses too, whatever the UI does.
    const err = await ctx.callErr('updateItems', [ids[0]], { star: 5 });
    assert.ok(err, 'the core accepted an edit on a read-only library');
    // Browsing works.
    await nav(win, 'Untagged');
    await nav(win, 'All');
    await waitCount(win, 3);
    assert.deepEqual(snapshot(lib), before0, 'a file in the read-only library changed');
  });

  it('"Allow editing…" adds the library to the editable places and reopens it for editing', async () => {
    const { win } = ctx;
    await win.locator('.bar.warn').getByRole('button', { name: 'Allow editing…' }).click();
    await win.locator('.dg-panel').getByRole('button', { name: 'Allow editing' }).click();
    await until(async () => (await ctx.call('getLibraryState')).readOnly === false, 'editable');
    await until(async () => !(await win.locator('.bar.warn').count()), 'the banner to go');
    const settings = await ctx.call('getSettings');
    assert.ok(
      settings.writableRoots.some((r) => lib.startsWith(r)),
      JSON.stringify(settings.writableRoots),
    );
  });

  it('"Open read-only" from the Libraries dialog, then "Open for editing"', async () => {
    const { win } = ctx;
    await win.locator('button.lib').click();
    await menu(win, 'Manage libraries');
    const dlg = win.locator('.dg-panel');
    await dlg.getByRole('button', { name: 'More for readonly' }).click();
    await menu(win, 'Open read-only');
    await until(
      async () => (await ctx.call('getLibraryState'))?.readOnlyKind === 'user',
      'user read-only',
    );
    const banner = win.locator('.bar.warn');
    assert.match(await banner.innerText(), /You opened it for viewing only/);
    await banner.getByRole('button', { name: 'Open for editing' }).click();
    await until(
      async () => (await ctx.call('getLibraryState')).readOnly === false,
      'editable again',
    );
  });
});

describe('libraries in Dropbox and on drives', () => {
  let ctx;
  let lib;
  const it = withShots(() => ctx);
  // Its own folder with Dropbox's marker file, so no other test's library counts as Dropbox.
  const dropboxDir = join(WORK, 'protected');

  before(async () => {
    rmSync(dropboxDir, { recursive: true, force: true }); // only ever WORK/protected
    mkdirSync(dropboxDir, { recursive: true });
    writeFileSync(join(dropboxDir, '.dropbox'), '{}');
    lib = join(dropboxDir, 'shared.library');
    execFileSync('cp', [
      '-a',
      '--reflink=auto',
      join(ROOT, 'research/sandbox/templates/sample.library'),
      lib,
    ]);
    // Allowed as an editable place, but no environment root covers it (the last test takes it out).
    ctx = await launch({
      name: 'protected',
      open: lib,
      settings: { writableRoots: [dropboxDir] },
      env: { BOOGIE_WRITABLE_ROOTS: join(WORK, 'editable') },
    });
  });
  after(() => ctx?.close());

  it('the Settings button, then the switch with its confirmation, makes it editable at once', async () => {
    const { win } = ctx;
    assert.equal((await ctx.call('getLibraryState')).readOnlyKind, 'protected');
    assert.match(await win.locator('.bar.warn').innerText(), /Dropbox and on external drives/);

    await win.locator('.tb').getByRole('button', { name: 'Settings' }).click();
    const dlg = win.locator('.dg-panel');
    const box = dlg
      .locator('label.dg-check', { hasText: 'Allow editing libraries in Dropbox' })
      .locator('input');
    await box.click();
    // Nothing changes until the question is answered.
    const ask = dlg.locator('.ask');
    assert.match(await ask.innerText(), /Allow editing in Dropbox and on drives\?/);
    assert.equal(await box.isChecked(), false);
    assert.equal((await ctx.call('getSettings')).allowProtectedWrites, false);
    await ask.getByRole('button', { name: 'Allow editing' }).click();

    await until(async () => (await ctx.call('getLibraryState')).readOnly === false, 'editable');
    assert.equal(await box.isChecked(), true);
    assert.equal(readJson(join(ctx.home, 'config/settings.json')).allowProtectedWrites, true);
    await dlg.getByRole('button', { name: 'Done' }).click();
    await until(async () => !(await win.locator('.bar.warn').count()), 'the banner to go');
    // A real edit lands on disk.
    const [id] = (await ctx.call('query', { scope: { kind: 'all' }, filter: {}, sort: null })).ids;
    await ctx.call('updateItems', [id], { star: 4 });
    await until(() => itemMeta(lib, id).star === 4, 'the rating on disk');
  });

  it('turning it off needs no question and makes it read-only again; the banner turns it back on', async () => {
    const { win } = ctx;
    await win.locator('.scroller').focus();
    await win.keyboard.press('Control+,');
    const box = win
      .locator('.dg-panel label.dg-check', { hasText: 'Allow editing libraries in Dropbox' })
      .locator('input');
    await box.uncheck();
    await until(
      async () => (await ctx.call('getLibraryState')).readOnlyKind === 'protected',
      'read-only again',
    );
    await win.keyboard.press('Escape');
    const banner = win.locator('.bar.warn');
    await until(async () => (await banner.count()) === 1, 'the banner');

    await banner.getByRole('button', { name: 'Allow editing…' }).click();
    await win.locator('.dg-panel').getByRole('button', { name: 'Allow editing' }).click();
    await until(async () => (await ctx.call('getLibraryState')).readOnly === false, 'editable');
    await until(async () => !(await banner.count()), 'the banner to go');
    assert.equal((await ctx.call('getSettings')).allowProtectedWrites, true);
  });

  it('a Dropbox library not allowed yet: "Allow editing…" asks for the folder, then for Dropbox', async () => {
    const { win } = ctx;
    await ctx.call('setSettings', { writableRoots: [], allowProtectedWrites: false });
    const banner = win.locator('.bar.warn');
    await until(
      async () => /Editing is off for this library/.test(await banner.innerText()),
      'guard',
    );
    await banner.getByRole('button', { name: 'Allow editing…' }).click();
    const dlg = win.locator('.dg-panel');
    assert.match(await dlg.innerText(), /Allow editing this library\?/);
    await dlg.getByRole('button', { name: 'Allow editing' }).click();
    await until(
      async () => /Allow editing in Dropbox and on drives\?/.test(await dlg.innerText()),
      'the second question',
    );
    await dlg.getByRole('button', { name: 'Allow editing' }).click();
    await until(async () => (await ctx.call('getLibraryState')).readOnly === false, 'editable');
    const settings = await ctx.call('getSettings');
    assert.equal(settings.allowProtectedWrites, true);
    assert.ok(
      settings.writableRoots.some((r) => lib.startsWith(r)),
      JSON.stringify(settings),
    );
  });
});
