// Library management in the real app: the startup picker, open, switch, recent order, create,
// "Open other library…", remove from list, and what a restart brings back.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe } from 'node:test';
import { WORK, freshLibrary, launch, rootMeta, sleep, until, withShots } from './lib/harness.mjs';
import { menu, shownCount, stubOpenDialog, waitCount } from './lib/ui.mjs';

describe('library management', () => {
  let ctx;
  const it = withShots(() => ctx);
  let libA;
  let libB;
  let libC;
  const createdParent = join(WORK, 'created');

  before(async () => {
    libA = freshLibrary('lib-a');
    libB = freshLibrary('lib-b');
    libC = freshLibrary('lib-c');
    mkdirSync(createdParent, { recursive: true });
    const made = join(createdParent, 'Fresh one.library');
    if (existsSync(made)) (await import('node:fs')).rmSync(made, { recursive: true });
    ctx = await launch({ name: 'library', known: [libA, libB] });
  });
  after(() => ctx?.close());

  it('starts with the library picker, which cannot be dismissed, and opens the clicked library', async () => {
    const { win } = ctx;
    const dlg = win.locator('.dg-panel');
    await dlg.waitFor();
    assert.match(await dlg.innerText(), /Open a library/);
    assert.equal(await win.locator('.dg-x').count(), 0, 'startup picker shows a close button');
    await win.keyboard.press('Escape');
    await sleep(200);
    assert.equal(await dlg.count(), 1, 'Escape closed the startup picker');
    await dlg.locator('button.main', { hasText: 'lib-a' }).click();
    await win.waitForSelector('.dg-scrim', { state: 'detached' });
    const counts = await ctx.call('getCounts');
    await waitCount(win, counts.all);
    assert.equal(await win.locator('.lib .nm').innerText(), 'lib-a');
    const st = await ctx.call('getLibraryState');
    assert.equal(st.ref.path, realpathSync(libA));
    assert.equal(st.readOnly, false, `opened read-only: ${st.readOnlyReason}`);
  });

  it('switches library from the sidebar header and keeps a most-recent-first list', async () => {
    const { win } = ctx;
    await win.locator('button.lib').click();
    await menu(win, 'lib-b');
    await until(async () => (await win.locator('.lib .nm').innerText()) === 'lib-b', 'lib-b open');
    const known = await ctx.call('listLibraries');
    assert.deepEqual(
      known.map((k) => k.name).slice(0, 2),
      ['lib-b', 'lib-a'],
      'recent list is not most-recent first',
    );
    assert.ok(
      known.every((k) => k.lastOpenedAt),
      'lastOpenedAt not recorded',
    );
    // The view starts over in the new library.
    assert.equal(await win.locator('.tb .ttl .nm').innerText(), 'All');
  });

  it('adds and opens another library with "Open other library…"', async () => {
    const { win, app } = ctx;
    await stubOpenDialog(app, [libC]);
    await win.locator('button.lib').click();
    await menu(win, 'Open other library');
    await until(async () => (await win.locator('.lib .nm').innerText()) === 'lib-c', 'lib-c open');
    const known = await ctx.call('listLibraries');
    assert.ok(known.some((k) => k.name === 'lib-c'));
    // A folder that isn't a library says so in plain English.
    await stubOpenDialog(app, [WORK]);
    const err = await ctx.callErr('pickLibraryFolder');
    assert.match(err ?? '', /not an Eagle library/);
  });

  it('creates a new library through the Libraries dialog and opens it empty', async () => {
    const { win, app } = ctx;
    await stubOpenDialog(app, [createdParent]);
    await win.locator('button.lib').click();
    await menu(win, 'Create new library');
    const dlg = win.locator('.dg-panel');
    await dlg.locator('#nl-name').fill('Fresh one');
    await dlg.getByRole('button', { name: 'Choose…' }).click();
    await until(
      async () => (await dlg.innerText()).includes('Fresh one.library'),
      'the location preview',
    );
    await dlg.getByRole('button', { name: 'Create library' }).click();
    await win.waitForSelector('.dg-scrim', { state: 'detached' });
    const path = join(createdParent, 'Fresh one.library');
    const root = rootMeta(path);
    assert.equal(root.applicationVersion, '4.0.0');
    assert.ok(existsSync(join(path, 'images')) && existsSync(join(path, 'mtime.json')));
    assert.equal(await win.locator('.lib .nm').innerText(), 'Fresh one');
    assert.equal(await shownCount(win), 0);
    assert.ok(await win.locator('.empty').count(), 'no empty state for an empty library');
    const st = await ctx.call('getLibraryState');
    assert.equal(st.readOnly, false, st.readOnlyReason);
    // A name Windows can't store is refused before anything is created.
    await win.locator('button.lib').click();
    await menu(win, 'Create new library');
    await dlg.locator('#nl-name').fill('bad:name?');
    assert.ok(await dlg.locator('.dg-err').count(), 'no error for a Windows-unsafe name');
    assert.ok(await dlg.getByRole('button', { name: 'Create library' }).isDisabled());
    await win.keyboard.press('Escape'); // closes the form
    await win.keyboard.press('Escape'); // closes the dialog
  });

  it('removes a library from the list (but never the open one)', async () => {
    const { win } = ctx;
    await win.locator('button.lib').click();
    await menu(win, 'Manage libraries');
    const dlg = win.locator('.dg-panel');
    await dlg.getByRole('button', { name: 'More for lib-a' }).click();
    await menu(win, 'Remove from list');
    await until(async () => !(await dlg.innerText()).includes('lib-a'), 'lib-a to leave the list');
    await dlg.getByRole('button', { name: 'More for Fresh one' }).click();
    const removeOpen = win.locator('.menu button[role=menuitem]', { hasText: 'Remove from list' });
    assert.ok(await removeOpen.isDisabled(), 'the open library can be removed from the list');
    await win.keyboard.press('Escape');
    await win.keyboard.press('Escape');
    assert.ok(existsSync(join(libA, 'metadata.json')), 'removing from the list touched the files');
    const saved = JSON.parse(readFileSync(join(ctx.home, 'config/libraries.json'), 'utf8'));
    assert.ok(!saved.some((k) => k.path === realpathSync(libA)));
  });

  it('reopens the last library after a restart', async () => {
    await ctx.close();
    ctx = await launch({ name: 'library', keepHome: true });
    const { win } = ctx;
    await sleep(2500);
    const st = await ctx.call('getLibraryState');
    assert.ok(
      st && st.ref.name === 'Fresh one',
      `after a restart the app shows ${st ? st.ref.name : 'the library picker again, with nothing open'}`,
    );
    assert.equal(await win.locator('.dg-scrim').count(), 0);
  });
});
