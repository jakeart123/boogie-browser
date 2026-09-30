#!/usr/bin/env node
// End-to-end smoke test of the Electron shell: launches the BUILT app under a private X server
// (never on your desktop), and checks the parts only a real Electron process can prove:
// window, preload bridge, IPC dispatch, boogie:// files + Range, clipboard, export, reference
// window, remembered window size, single instance + eagle:// links, clean quit.
//
//   npm run build && npm run e2e                       (the real core on a copy of sample)
//   node scripts/e2e-smoke.mjs --app .tmp/app/out      (test another build folder)
//   ... --work .tmp/<you>                              (scratch folder; default .tmp/app)
//   node scripts/e2e-smoke.mjs --exe dist/linux-unpacked/boogie-browser   (test the packaged app)
//   ... --sigterm      quit with SIGTERM instead of a normal quit (must still flush)
//   ... --compat       real core: also start the Eagle-compatible servers (needs ports 41595/41593)
//
// Uses BOOGIE_HOME=<work>/home so nothing touches your real config, cache or libraries. The real
// core opens a private copy of the library in <work>, and edits it only when BOOGIE_WRITABLE_ROOTS
// covers <work> (then it also checks an edit lands on disk and quit flushes mtime.json).
// Screenshot: <work>/smoke.png. Exits non-zero on failure.
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);

// Re-run ourselves inside xvfb-run so a window never pops up on the desktop.
if (!process.env.BOOGIE_SMOKE_INNER) {
  const r = spawnSync(
    'xvfb-run',
    [
      '-a',
      '-s',
      '-screen 0 1920x1080x24',
      process.execPath,
      fileURLToPath(import.meta.url),
      ...argv,
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, BOOGIE_SMOKE_INNER: '1' },
    },
  );
  if (r.error) console.error('Could not run xvfb-run:', r.error.message);
  process.exit(r.status ?? 1);
}

const { _electron: electron } = await import('playwright');
const electronPath = (await import('electron')).default; // the electron package exports the binary's path

const appDir = resolve(root, opt('--app', '.'));
const exe = opt('--exe', null) && resolve(root, opt('--exe', null)); // a packaged build instead of `electron <appDir>`
const work = resolve(root, opt('--work', '.tmp/app'));
const home = join(work, 'home');
const exportDir = join(work, 'export-out');
const privateSample = join(root, 'research/sandbox/templates/sample.library');
const library = resolve(
  root,
  process.env.SMOKE_LIBRARY ??
    (existsSync(privateSample) ? privateSample : 'test/fixtures/libraries/sample.library'),
);
const sigterm = argv.includes('--sigterm');
mkdirSync(work, { recursive: true });
rmSync(exportDir, { recursive: true, force: true });
mkdirSync(exportDir, { recursive: true });
rmSync(join(home, 'config/window.json'), { force: true });

const env = { ...process.env, BOOGIE_HOME: home };

// The real core gets a private COPY of the library (it may write an index, thumbnails...), opened read-only,
// and settings that only start the agent server, on a free port, so the smoke never takes 41595/41593/41597.
const openPath = join(work, 'lib.library');
const writable = (process.env.BOOGIE_WRITABLE_ROOTS ?? '')
  .split(':')
  .filter(Boolean)
  .some((r) => openPath.startsWith(resolve(r) + '/'));
rmSync(openPath, { recursive: true, force: true });
cpSync(library, openPath, { recursive: true });
const mcpPort = await new Promise((res) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => res(port));
  });
});
mkdirSync(join(home, 'config'), { recursive: true });
writeFileSync(
  join(home, 'config/settings.json'),
  JSON.stringify({ eagleCompatApi: argv.includes('--compat'), mcpEnabled: true, mcpPort }),
);
delete env.ELECTRON_RUN_AS_NODE;
delete env.BOOGIE_SMOKE_INNER;
const flags = ['--ozone-platform=x11'];

const results = [];
// A check that hangs must fail, not hang the run.
async function check(name, fn) {
  let timer;
  try {
    const detail = await Promise.race([
      fn(),
      new Promise(
        (_, reject) =>
          (timer = setTimeout(() => reject(new Error('timed out after 30 s')), 30_000)),
      ),
    ]);
    results.push({ name, ok: true, detail });
  } catch (e) {
    results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
  } finally {
    clearTimeout(timer);
  }
  const r = results.at(-1);
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${name}${r.detail ? `  (${r.detail})` : ''}`);
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

// Whole-run watchdog: never leave an Electron process behind.
setTimeout(() => {
  console.error('FAIL  the smoke run took longer than 3 minutes, giving up');
  process.exit(1);
}, 180_000).unref();

console.log(`Launching ${exe ?? appDir} (library=${library})`);
const bin = exe ?? electronPath;
const binArgs = exe ? flags : [...flags, appDir];
const app = await electron.launch({
  executablePath: bin,
  args: binArgs,
  env,
  cwd: root,
  timeout: 60_000,
});
let stdout = '';
app.process().stdout?.on('data', (d) => (stdout += d));
app.process().stderr?.on('data', (d) => (stdout += d));

let exitCode = 0;
try {
  const win = await app.firstWindow();
  const consoleErrors = [];
  win.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  win.on('pageerror', (e) => consoleErrors.push(String(e)));
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(1500);
  // The page's own helper: call an app/core method the way the UI does.
  const call = (method, ...args) =>
    win.evaluate(([m, a]) => window.boogie.invoke(m, a), [method, args]);
  const callErr = (method, ...args) =>
    win.evaluate(
      ([m, a]) =>
        window.boogie.invoke(m, a).then(
          () => null,
          (e) => String(e.message ?? e),
        ),
      [method, args],
    );

  await check('window opens with the preload bridge and a sandboxed renderer', async () => {
    const info = await win.evaluate(() => ({
      bridge: typeof window.boogie?.invoke,
      kind: window.boogie?.windowKind,
    }));
    assert(info.bridge === 'function', 'window.boogie.invoke is missing');
    assert(info.kind?.kind === 'main', `windowKind is ${JSON.stringify(info.kind)}`);
    const frameless = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return {
        title: w.getTitle(),
        sandbox: w.webContents.getLastWebPreferences().sandbox,
        isolation: w.webContents.getLastWebPreferences().contextIsolation,
      };
    });
    assert(
      frameless.sandbox && frameless.isolation,
      `webPreferences: ${JSON.stringify(frameless)}`,
    );
    return frameless.title;
  });

  await check('a library is open and indexed', async () => {
    const st = await call('getLibraryState');
    if (st?.ref.path !== openPath) await call('openLibrary', openPath, { readOnly: !writable });
    const state = await until(
      async () => {
        const st = await call('getLibraryState');
        return st && st.indexing === null && st;
      },
      'the index to be ready',
      25_000,
    );
    return `${state.ref.name}, read-only=${state.readOnly}`;
  });

  await win.screenshot({ path: join(work, 'smoke.png') });

  let briefs = [];
  await check('getCounts over IPC', async () => {
    const counts = await call('getCounts');
    console.log(
      'getCounts ->',
      JSON.stringify({
        all: counts.all,
        uncategorized: counts.uncategorized,
        untagged: counts.untagged,
        trash: counts.trash,
      }),
    );
    assert(typeof counts.all === 'number' && counts.all > 0, 'no items counted');
    const q = await call('query', { scope: { kind: 'all' }, filter: {}, sort: null });
    briefs = await call('getBriefs', q.ids.slice(0, 4));
    assert(briefs.length > 0, 'getBriefs returned nothing');
    return `${counts.all} items`;
  });
  const ids = briefs.map((b) => b.id);

  await check('boogie://thumb images load in the page', async () => {
    const sizes = await win.evaluate(
      async (urls) => {
        const load = (u) =>
          new Promise((res, rej) => {
            const i = new Image();
            i.onload = () => res(i.naturalWidth);
            i.onerror = () => rej(new Error(`image failed: ${u}`));
            i.src = u;
          });
        return Promise.all(urls.map(load));
      },
      briefs.map((b) => b.thumbUrl),
    );
    assert(
      briefs.every((b) => b.thumbUrl.startsWith('boogie://thumb/')),
      `unexpected thumb url ${briefs[0]?.thumbUrl}`,
    );
    assert(
      sizes.every((w) => w > 0),
      `naturalWidth ${sizes}`,
    );
    const inPage = await win.evaluate(
      () =>
        [...document.images].filter(
          (i) => i.src.startsWith('boogie://thumb/') && i.naturalWidth > 0,
        ).length,
    );
    return `naturalWidth ${sizes.join(',')}; ${inPage} boogie:// images already in the UI`;
  });

  await check('boogie:// Range, 404s and cache headers', async () => {
    const item = await call('getItem', ids[0]);
    const r = await win.evaluate(async (url) => {
      const full = await fetch(url);
      const part = await fetch(url, { headers: { Range: 'bytes=10-109' } });
      const tail = await fetch(url, { headers: { Range: 'bytes=-5' } });
      const bad = await fetch(url, { headers: { Range: 'bytes=999999999-' } });
      const missing = await fetch(url.replace(/\/[^/]+\?/, '/NOSUCHITEM000?'));
      const wrongKind = await fetch(url.replace('boogie://file/', 'boogie://bogus/'));
      return {
        fullStatus: full.status,
        fullLen: (await full.arrayBuffer()).byteLength,
        cache: full.headers.get('cache-control'),
        type: full.headers.get('content-type'),
        partStatus: part.status,
        partRange: part.headers.get('content-range'),
        partLen: (await part.arrayBuffer()).byteLength,
        tailLen: (await tail.arrayBuffer()).byteLength,
        badStatus: bad.status,
        missingStatus: missing.status,
        wrongKindStatus: wrongKind.status,
      };
    }, item.fileUrl);
    assert(
      r.fullStatus === 200 && r.fullLen === item.size,
      `full: ${r.fullStatus} ${r.fullLen} vs ${item.size}`,
    );
    assert(
      r.partStatus === 206 && r.partLen === 100 && r.partRange === `bytes 10-109/${item.size}`,
      `range: ${r.partStatus} ${r.partLen} ${r.partRange}`,
    );
    assert(r.tailLen === 5, `suffix range gave ${r.tailLen} bytes`);
    assert(r.badStatus === 416, `unsatisfiable range gave ${r.badStatus}`);
    assert(
      r.missingStatus === 404 && r.wrongKindStatus === 404,
      `404s: ${r.missingStatus} ${r.wrongKindStatus}`,
    );
    assert(/immutable/.test(r.cache ?? ''), `cache-control ${r.cache}`);
    return `${r.type}, ${r.cache}`;
  });

  await check('IPC dispatcher refuses non-methods', async () => {
    for (const m of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'nope']) {
      const err = await callErr(m);
      assert(err && /Unknown method/.test(err), `${m}: ${err}`);
    }
    const bad = await win.evaluate(() =>
      window.boogie.invoke('getCounts', 'not-an-array').then(
        () => null,
        (e) => String(e.message),
      ),
    );
    assert(bad && /not understood/.test(bad), `bad args: ${bad}`);
    return 'ok';
  });

  await check('openExternalUrl only allows web links', async () => {
    for (const u of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'boogie://file/a/b',
      'not a url',
    ]) {
      const err = await callErr('openExternalUrl', u);
      assert(err && /Only web links/.test(err), `${u}: ${err}`);
    }
    return 'ok';
  });

  await check('folder pickers (dialog stubbed)', async () => {
    const stub = (paths) =>
      app.evaluate(({ dialog }, paths) => {
        dialog.showOpenDialog = async () => ({ canceled: paths === null, filePaths: paths ?? [] });
      }, paths);
    await stub([library]);
    assert((await call('pickLibraryFolder')) === library, 'a .library folder was not accepted');
    await stub([root]);
    const err = await callErr('pickLibraryFolder');
    assert(err && /not an Eagle library/.test(err), `non-library folder: ${err}`);
    await stub(null);
    assert((await call('pickDirectory', 'x')) === null, 'cancel should give null');
    await stub(['/a.png', '/b.png']);
    assert((await call('pickFiles')).length === 2, 'pickFiles');
    return 'ok';
  });

  const hasXclip = spawnSync('which', ['xclip']).status === 0;
  // xclip forks a background process that keeps owning the selection, so it must not be waited on.
  async function setSelection(args, input) {
    const p = spawn('xclip', ['-selection', 'clipboard', ...args], {
      stdio: [input ? 'pipe' : 'ignore', 'ignore', 'ignore'],
    });
    if (input) p.stdin.end(input);
    p.unref();
    await sleep(400);
  }
  await check('copyItems puts pixels + file list on the clipboard', async () => {
    const item = await call('getItem', ids[0]);
    await call('copyItems', [ids[0], ids[1]]);
    if (hasXclip) {
      const targets = spawnSync('xclip', [
        '-selection',
        'clipboard',
        '-o',
        '-t',
        'TARGETS',
      ]).stdout.toString();
      assert(
        /text\/uri-list/.test(targets) &&
          /image\/png/.test(targets) &&
          /x-special\/gnome-copied-files/.test(targets),
        `clipboard targets: ${targets.split('\n').join(' ')}`,
      );
      const gnome = spawnSync('xclip', [
        '-selection',
        'clipboard',
        '-o',
        '-t',
        'x-special/gnome-copied-files',
      ]).stdout.toString();
      assert(/^copy\nfile:\/\//.test(gnome), `gnome list ${JSON.stringify(gnome)}`);
      const uris = spawnSync('xclip', [
        '-selection',
        'clipboard',
        '-o',
        '-t',
        'text/uri-list',
      ]).stdout.toString();
      assert(
        uris.includes(encodeURI(item.filePath).replace(/#/g, '%23')),
        `uri-list ${JSON.stringify(uris)} lacks ${item.filePath}`,
      );
      const png = spawnSync('xclip', ['-selection', 'clipboard', '-o', '-t', 'image/png']).stdout;
      assert(png.subarray(1, 4).toString() === 'PNG', 'image/png is not a PNG');
    }
    const back = await call('readClipboardForImport');
    assert(
      back.paths.length === 2 && back.paths[0] === item.filePath,
      `read back paths ${JSON.stringify(back.paths)}`,
    );
    return hasXclip ? 'verified with xclip and read back' : 'read back only (xclip not installed)';
  });

  await check('copyText puts text on the clipboard', async () => {
    await call('copyText', 'boogie ñ 日本語');
    if (!hasXclip) return 'skipped (xclip not installed)';
    const text = spawnSync('xclip', [
      '-selection',
      'clipboard',
      '-o',
      '-t',
      'UTF8_STRING',
    ]).stdout.toString();
    assert(text === 'boogie ñ 日本語', `clipboard text ${JSON.stringify(text)}`);
    return 'ok';
  });

  await check('readClipboardForImport sees files and pictures from other apps', async () => {
    if (!hasXclip) return 'skipped (xclip not installed)';
    const item = await call('getItem', ids[0]);
    await setSelection(['-t', 'text/uri-list', '-i'], `file://${encodeURI(item.filePath)}\r\n`);
    const files = await call('readClipboardForImport');
    assert(files.paths[0] === item.filePath, `files: ${JSON.stringify(files.paths)}`);
    const png = join(work, 'clip.png');
    spawnSync('vips', ['thumbnail', item.filePath, png, '64'], {
      env: { ...process.env, VIPS_WARNING: '0' },
    });
    await setSelection(['-t', 'image/png', '-i', png]);
    const pic = await call('readClipboardForImport');
    const bytes = Object.values(pic.image ?? {});
    assert(
      pic.paths.length === 0 && bytes.length > 100 && bytes[1] === 0x50,
      `image: ${bytes.length} bytes, paths ${pic.paths.length}`,
    );
    return `${bytes.length} PNG bytes`;
  });

  await check('readClipboardForImport turns copied links into urls (Ctrl+V a link)', async () => {
    if (!hasXclip) return 'skipped (xclip not installed)';
    const links = 'https://example.com/a.jpg\nhttps://example.com/b.png\n';
    await setSelection(['-t', 'UTF8_STRING', '-i'], links);
    const got = await call('readClipboardForImport');
    assert(
      got.paths.length === 0 &&
        got.image === null &&
        JSON.stringify(got.urls) ===
          JSON.stringify(['https://example.com/a.jpg', 'https://example.com/b.png']),
      `got ${JSON.stringify(got)}`,
    );
    await setSelection(['-t', 'UTF8_STRING', '-i'], 'just some words https://example.com');
    const words = await call('readClipboardForImport');
    assert(!words.urls, `a sentence came back as links: ${JSON.stringify(words)}`);
    return got.urls.length + ' links';
  });

  await check('exportItems copies (never moves) with -01 clash suffixes', async () => {
    const jobs = await win.evaluate(() => {
      window.__jobs = [];
      window.boogie.on('job', (j) => window.__jobs.push(j));
    });
    void jobs;
    const { jobId } = await call('exportItems', [ids[0], ids[1], ids[0]], exportDir, {
      keepFolders: false,
    });
    await until(
      () =>
        win.evaluate(
          (id) => window.__jobs.some((j) => j.jobId === id && j.state !== 'running'),
          jobId,
        ),
      'export job to finish',
    );
    const last = await win.evaluate(
      (id) => window.__jobs.filter((j) => j.jobId === id).at(-1),
      jobId,
    );
    assert(last.state === 'done' && last.done === 3, `job ended ${JSON.stringify(last)}`);
    const files = readdirSync(exportDir).sort();
    assert(files.length === 3 && files.some((f) => /-01\.jpg$/.test(f)), `files: ${files}`);
    const item = await call('getItem', ids[0]);
    assert(existsSync(item.filePath), 'original is gone!');
    assert(
      statSync(
        join(
          exportDir,
          files.find((f) => /-01\.jpg$/.test(f)),
        ),
      ).size === item.size,
      'copy has a different size',
    );
    const err = await callErr('exportItems', [ids[0]], join(work, 'inside.library'));
    assert(err && /outside any Eagle library/.test(err), `library target: ${err}`);
    return files.join(', ');
  });

  if (writable) {
    await check('exporting a folder makes a folder named after it, subfolders inside', async () => {
      const top = await call('createFolder', 'Smoke Export', null);
      const sub = await call('createFolder', 'Inner', top.id);
      await call('updateItems', [ids[0]], { addFolders: [top.id] });
      await call('updateItems', [ids[1]], { addFolders: [sub.id] });
      const out = join(work, 'export-folder');
      rmSync(out, { recursive: true, force: true });
      mkdirSync(out);
      const { jobId } = await call('exportItems', [ids[0], ids[1]], out, {
        keepFolders: true,
        baseFolderId: top.id,
      });
      const last = await until(
        () =>
          win.evaluate(
            (id) => window.__jobs.filter((j) => j.jobId === id && j.state !== 'running').at(-1),
            jobId,
          ),
        'folder export to finish',
      );
      assert(last.state === 'done', `job ${JSON.stringify(last)}`);
      assert(last.result?.dir === join(out, 'Smoke Export'), `result dir ${last.result?.dir}`);
      const inner = readdirSync(join(out, 'Smoke Export', 'Inner'));
      assert(inner.length === 1, `Inner holds ${inner}`);
      return readdirSync(join(out, 'Smoke Export')).join(', ');
    });
  }

  await check(
    'showFolder opens a folder in the file manager (shell stubbed), refuses a missing one',
    async () => {
      await app.evaluate(({ shell }) => {
        globalThis.__opened = [];
        shell.openPath = async (p) => (globalThis.__opened.push(p), '');
      });
      await call('showFolder', exportDir);
      const opened = await app.evaluate(() => globalThis.__opened);
      assert(opened.length === 1 && opened[0] === exportDir, `opened ${JSON.stringify(opened)}`);
      const err = await callErr('showFolder', join(work, 'no-such-folder'));
      assert(err && /does not exist/.test(err), `missing folder: ${err}`);
      return 'ok';
    },
  );

  await check('reference window is separate, frameless, always on top', async () => {
    const opened = app.waitForEvent('window', { timeout: 10_000 });
    await call('openReferenceWindow', ids[0], [ids[1], ids[0], ids[2]]);
    const ref = await opened;
    await ref.waitForLoadState('domcontentloaded');
    const kind = await ref.evaluate(() => window.boogie.windowKind);
    assert(
      kind.kind === 'reference' &&
        kind.itemId === ids[0] &&
        JSON.stringify(kind.itemIds) === JSON.stringify([ids[1], ids[0], ids[2]]),
      `windowKind ${JSON.stringify(kind)}`,
    );
    const props = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Boogie Reference');
      return w && { onTop: w.isAlwaysOnTop(), size: w.getSize(), title: w.getTitle() };
    });
    assert(
      props?.onTop && props.size[0] === 640 && props.size[1] === 640,
      `props ${JSON.stringify(props)}`,
    );
    await call('openReferenceWindow', ids[0]); // same item again: focuses, no second window
    assert(app.windows().length === 2, `expected 2 windows, have ${app.windows().length}`);
    // The page closes itself, so its own evaluate never returns.
    ref.evaluate(() => window.boogie.invoke('windowControl', ['close'])).catch(() => {});
    await until(() => app.windows().length === 1, 'reference window to close');
    return 'ok';
  });

  await check('window size and position are remembered', async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1234, 777));
    const file = join(home, 'config/window.json');
    const read = () => {
      try {
        return JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        return null; // not written yet
      }
    };
    const saved = await until(
      () => read()?.width === 1234 && read(),
      'window.json to hold the new size',
    );
    assert(
      saved.height === 777 && saved.maximized === false,
      `window.json ${JSON.stringify(saved)}`,
    );
    return JSON.stringify(saved);
  });

  let edited = null;
  if (writable) {
    await check('an edit over IPC lands in the library copy and can be undone', async () => {
      const meta = () =>
        JSON.parse(readFileSync(join(openPath, 'images', `${ids[0]}.info/metadata.json`), 'utf8'));
      const res = await call('updateItems', [ids[0]], { addTags: ['smoke test'] });
      assert(
        res.changed === 1 && meta().tags.includes('smoke test'),
        `edit ${JSON.stringify(res)}`,
      );
      const undo = await call('undo');
      assert(undo.reverted === 1 && !meta().tags.includes('smoke test'), 'undo did not revert it');
      edited = { id: ids[0], lastModified: meta().lastModified };
      return `lastModified ${edited.lastModified}`;
    });
  }

  await check(
    'agent server starts from settings, needs a token, stops when switched off',
    async () => {
      const ports = await until(
        async () => (await call('getStatus')).ports.mcp === mcpPort,
        'MCP port in status',
        10_000,
      );
      void ports;
      const url = `http://127.0.0.1:${mcpPort}/mcp`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert(res.status === 401, `no token gave ${res.status}`);
      const tokenFile = join(home, 'config/api-token');
      assert(
        existsSync(tokenFile) && (statSync(tokenFile).mode & 0o777) === 0o600,
        'api-token missing or not 0600',
      );
      await call('setSettings', { mcpEnabled: false });
      await until(async () => (await call('getStatus')).ports.mcp === null, 'MCP to stop', 10_000);
      const after = await fetch(url, { method: 'POST' }).then(
        () => 'still up',
        () => 'refused',
      );
      assert(after === 'refused', 'the agent server is still listening after being switched off');
      return `port ${mcpPort}`;
    },
  );
  if (argv.includes('--compat')) {
    await check(
      'Eagle-compatible servers: bound, or busy with a plain-English reason',
      async () => {
        const ports = await until(async () => (await call('getStatus')).ports, 'ports', 5000);
        void ports;
        const st = await call('getStatus');
        const bound = st.ports.eagleApi === 41595;
        assert(bound || /41595/.test(st.ports.reason ?? ''), `ports ${JSON.stringify(st.ports)}`);
        return JSON.stringify(st.ports);
      },
    );
  }

  await check(
    'a second instance quits and hands over its eagle:// link (the window reveals it)',
    async () => {
      await win.evaluate(() => {
        window.__reveals = [];
        window.boogie.on('reveal', (p) => window.__reveals.push(p));
      });
      const child = spawn(bin, [...binArgs, 'eagle://item/SMOKE123'], {
        env,
        cwd: root,
        stdio: 'ignore',
      });
      const code = await new Promise((res) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          res('timeout');
        }, 20_000);
        child.on('exit', (c) => {
          clearTimeout(t);
          res(c);
        });
      });
      assert(code === 0, `second instance exit code ${code}`);
      await until(
        () => /link received: eagle:\/\/item\/SMOKE123/.test(stdout),
        'eagle:// link in the first instance log',
        5000,
      );
      const reveals = await until(
        () => win.evaluate(() => window.__reveals.length && window.__reveals),
        'the reveal event in the window',
        5000,
      );
      assert(
        JSON.stringify(reveals) === JSON.stringify([{ kind: 'item', id: 'SMOKE123' }]),
        `reveal ${JSON.stringify(reveals)}`,
      );
      return JSON.stringify(reveals[0]);
    },
  );

  // The 404/416 lines come from the Range test above, on purpose.
  const unexpected = consoleErrors.filter(
    (e) => !/Failed to load resource: the server responded with a status of (404|416)/.test(e),
  );
  console.log(`page console errors (besides the expected 404/416): ${unexpected.length}`);
  for (const e of unexpected.slice(0, 8)) console.log('  ', e.slice(0, 200));

  const t0 = Date.now();
  if (sigterm) {
    const proc = app.process();
    const exited = new Promise((res) => proc.once('exit', res));
    proc.kill('SIGTERM');
    await exited;
  } else await app.close();
  const record = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  };
  record(
    `app quits cleanly${sigterm ? ' (SIGTERM)' : ''}`,
    Date.now() - t0 < 8000,
    `${Date.now() - t0} ms`,
  );
  if (edited) {
    const mtime = JSON.parse(readFileSync(join(openPath, 'mtime.json'), 'utf8'));
    record(
      'quit flushed mtime.json for the edit',
      mtime[edited.id] === edited.lastModified,
      `${mtime[edited.id]} vs ${edited.lastModified}`,
    );
  }
  record('window.json exists after quit', existsSync(join(home, 'config/window.json')));
} catch (e) {
  results.push({ name: 'smoke run', ok: false, detail: e instanceof Error ? e.stack : String(e) });
  console.log('--- app output ---\n' + stdout.slice(-3000));
  await app.close().catch(() => app.process().kill('SIGKILL'));
}

console.log('');
const failed = results.filter((r) => !r.ok).length;
console.log(
  failed
    ? `\n${failed} check(s) failed`
    : `\nAll ${results.length} checks passed. Screenshot: ${join(work, 'smoke.png')}`,
);
if (failed) exitCode = 1;
process.exit(exitCode);
