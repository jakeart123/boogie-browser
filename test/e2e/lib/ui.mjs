// Small helpers for driving the Boogie UI through the DOM, shared by the e2e files.
import { until } from './harness.mjs';

/** The number in the toolbar next to the scope name (view.result.total). */
export async function shownCount(win) {
  const t = await win.locator('[aria-label="Items shown"]').innerText();
  return Number(t.replace(/[^\d]/g, ''));
}

/** Wait until the toolbar count reads `n`. */
export async function waitCount(win, n, ms = 10_000) {
  await until(async () => (await shownCount(win)) === n, `the grid to show ${n} items`, ms);
}

/** Ids of the tiles (or list rows) currently in the DOM, in DOM order. */
export async function tileIds(win) {
  return win.$$eval('.scroller [data-id]', (els) => els.map((e) => e.getAttribute('data-id')));
}

export const tile = (win, id) => win.locator(`.scroller [data-id="${id}"]`);

/** Click one of All / Uncategorized / Untagged / Random / Trash in the sidebar. */
export async function nav(win, name) {
  await win
    .locator('nav[aria-label="Library views"] button', { hasText: new RegExp(`^\\s*${name}\\b`) })
    .click();
}

export const folderRow = (win, name) => win.locator(`.sb-row.tree[title="${name}"]`).first();

/** Click through a context menu (and its submenus) by labels. */
export async function menu(win, ...labels) {
  for (let i = 0; i < labels.length; i++) {
    const item = win
      .locator('.menu[role=menu] button[role=menuitem]', {
        has: win.locator('.lb', { hasText: labels[i] }),
      })
      .last();
    if (i < labels.length - 1) await item.hover();
    else await item.click();
  }
}

/** Selected tile ids (aria-selected), in DOM order. */
export async function selectedIds(win) {
  return win.$$eval('.scroller [data-id][aria-selected="true"]', (els) =>
    els.map((e) => e.getAttribute('data-id')),
  );
}

/** Text of every visible toast. */
export async function toasts(win) {
  return win.$$eval('.stack > *', (els) => els.map((e) => e.textContent?.trim() ?? ''));
}

export async function waitToast(win, re, ms = 8000) {
  return until(async () => (await toasts(win)).find((t) => re.test(t)), `a toast ${re}`, ms);
}

/** Close whatever dialog is open (Escape), and wait for it to go. */
export async function closeDialog(win) {
  await win.keyboard.press('Escape');
  await win.waitForSelector('.dg-scrim', { state: 'detached', timeout: 5000 });
}

/** The main-process dialog module, stubbed: every open dialog returns `paths` (null = cancel). */
export async function stubOpenDialog(app, paths) {
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: paths === null, filePaths: paths ?? [] });
  }, paths);
}

/** Record shell calls in the main process instead of opening things on the desktop. */
export async function stubShell(app) {
  await app.evaluate(({ shell }) => {
    globalThis.__shell = [];
    shell.showItemInFolder = (p) => void globalThis.__shell.push(['reveal', p]);
    shell.openPath = async (p) => (globalThis.__shell.push(['open', p]), '');
    shell.openExternal = async (u) => void globalThis.__shell.push(['external', u]);
  });
}
export const shellCalls = (app) => app.evaluate(() => globalThis.__shell ?? []);

/** Focus the grid without selecting anything (click the empty area below the tiles). */
export async function focusGrid(win) {
  await win.locator('.scroller').focus();
}

/**
 * Drop real files on an element the way a file manager drop arrives: File objects backed by the
 * paths on disk (made by a hidden file input, so webUtils.getPathForFile sees the real paths),
 * then dragenter / dragover / drop at the element's center. `at` = {x, y} overrides the point.
 */
export async function dropFiles(win, target, paths, { shift = false, at = null } = {}) {
  const input = await win.evaluateHandle(() => {
    const i = document.createElement('input');
    i.type = 'file';
    i.multiple = true;
    i.style.display = 'none';
    document.body.append(i);
    return i;
  });
  await input.setInputFiles(paths);
  const el = await target.elementHandle();
  return win.evaluate(
    ([input, el, shift, at]) => {
      const dt = new DataTransfer();
      for (const f of input.files) dt.items.add(f);
      input.remove();
      const r = el.getBoundingClientRect();
      const opts = {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
        clientX: at ? at.x : r.left + r.width / 2,
        clientY: at ? at.y : r.top + r.height / 2,
        shiftKey: shift,
      };
      el.dispatchEvent(new DragEvent('dragenter', opts));
      const over = new DragEvent('dragover', opts);
      el.dispatchEvent(over);
      const accepted = over.defaultPrevented;
      el.dispatchEvent(new DragEvent('drop', opts));
      return accepted;
    },
    [input, el, shift, at],
  );
}

/** Drop a link (text/uri-list), as dragged from a browser. */
export async function dropUrl(win, target, url) {
  const el = await target.elementHandle();
  return win.evaluate(
    ([el, url]) => {
      const dt = new DataTransfer();
      dt.setData('text/uri-list', url);
      const r = el.getBoundingClientRect();
      const opts = {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
        clientX: r.left + 5,
        clientY: r.top + 5,
      };
      el.dispatchEvent(new DragEvent('dragover', opts));
      el.dispatchEvent(new DragEvent('drop', opts));
    },
    [el, url],
  );
}

/** Replace the native drag (webContents.startDrag) with a recorder, so a tile drag never grabs X. */
export async function stubNativeDrag(app) {
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__drags = [];
    const proto = Object.getPrototypeOf(BrowserWindow.getAllWindows()[0].webContents);
    proto.startDrag = function (item) {
      globalThis.__drags.push({ files: item.files ?? [item.file], icon: !item.icon?.isEmpty?.() });
    };
  });
}
export const nativeDrags = (app) => app.evaluate(() => globalThis.__drags ?? []);

/** The app starts the native drag asynchronously (it looks the files up first): wait for drag #n. */
export async function waitNativeDrag(app, n) {
  return until(async () => (await nativeDrags(app))[n - 1], `native drag #${n}`, 5000);
}

/** Start dragging a tile (fires the tile's dragstart; the app hands it to startDrag). */
export async function dragStartTile(win, id) {
  await win.evaluate((id) => {
    const th = document.querySelector(`.scroller [data-id="${id}"] .th`);
    const r = th.getBoundingClientRect();
    th.dispatchEvent(
      new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        dataTransfer: new DataTransfer(),
        clientX: r.left + 5,
        clientY: r.top + 5,
      }),
    );
  }, id);
}
