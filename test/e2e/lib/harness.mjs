// Shared launch helper for the end-to-end suite: starts the BUILT Electron app with the REAL core
// on a private copy of a sandbox library, on the private Xvfb display that run.mjs started.
//
// Safety: refuses to launch unless DISPLAY is run.mjs's Xvfb and WAYLAND_DISPLAY is unset, so no
// test window, drag or clipboard write ever reaches your desktop. Everything the app writes
// (config, index, journal, library copies) lands under .tmp/electron-qa/.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { _electron as electron } from 'playwright';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// E2E_WORK (an absolute path under .tmp/) gives a run its own scratch and build folder, so two
// agents can run the suite at once without sharing .tmp/electron-qa.
const work = process.env.E2E_WORK ? resolve(process.env.E2E_WORK) : join(ROOT, '.tmp/electron-qa');
if (!work.startsWith(join(ROOT, '.tmp') + sep))
  throw new Error(`E2E_WORK must be under ${ROOT}/.tmp`);
export const WORK = work;
export const OUT = join(WORK, 'out');
export const LIBS = join(WORK, 'libs');
export const SHOTS = join(WORK, 'shots');
const TEMPLATES = join(ROOT, 'research/sandbox/templates');
const ELECTRON = join(ROOT, 'node_modules/electron/dist/electron');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function assertPrivateDisplay() {
  const d = process.env.E2E_DISPLAY;
  if (!d || process.env.DISPLAY !== d)
    throw new Error('Run the suite through test/e2e/run.mjs: it starts a private Xvfb display.');
  if (process.env.WAYLAND_DISPLAY)
    throw new Error(
      'WAYLAND_DISPLAY is set: refusing to launch (the app could reach the desktop).',
    );
}

/** Only ever delete inside our scratch folder. */
function rmScratch(p) {
  const abs = resolve(p);
  if (!abs.startsWith(WORK + sep)) throw new Error(`refusing to delete outside ${WORK}: ${abs}`);
  rmSync(abs, { recursive: true, force: true });
}

/** Our cache id for a library (src/core/libraryId.ts): first 16 hex of sha256(realpath). */
export function libraryId(path) {
  return createHash('sha256').update(realpathSync(path)).digest('hex').slice(0, 16);
}

/** A fresh private copy of a sandbox template (reflinked, so even the 6 GB one is instant). */
export function freshLibrary(name, template = 'sample') {
  mkdirSync(LIBS, { recursive: true });
  const dest = join(LIBS, `${name}.library`);
  rmScratch(dest);
  execFileSync('cp', ['-a', '--reflink=auto', join(TEMPLATES, `${template}.library`), dest]);
  return dest;
}

/** The shared Art Archive copy (5.4k items). Tests only read it, so it is copied once and reused. */
export function artLibrary() {
  const dest = join(LIBS, 'art.library');
  if (!existsSync(join(dest, 'metadata.json'))) freshLibrary('art', 'art-archive');
  return dest;
}

export async function freePort() {
  return new Promise((res) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

export const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** Every item record in a library, read straight from disk (the ground truth for the index). */
export function scanItems(lib) {
  const out = [];
  for (const d of readdirSync(join(lib, 'images'))) {
    if (!d.endsWith('.info')) continue;
    try {
      out.push(readJson(join(lib, 'images', d, 'metadata.json')));
    } catch {
      /* half-synced item: the app skips it too */
    }
  }
  return out;
}
export const itemMeta = (lib, id) => readJson(join(lib, 'images', `${id}.info`, 'metadata.json'));
export const mtimeJson = (lib) => readJson(join(lib, 'mtime.json'));
export const rootMeta = (lib) => readJson(join(lib, 'metadata.json'));

/**
 * Launch the app. `name` picks the BOOGIE_HOME (.tmp/electron-qa/home/<name>), which starts
 * empty unless keepHome. `known` pre-seeds the library list (so first-run discovery never lists
 * your real libraries), `open` is opened over IPC and indexed before this returns.
 */
export async function launch({
  name,
  open = null,
  readOnly = false,
  known = open ? [open] : [],
  settings = {},
  keepHome = false,
  env = {},
  size = [1600, 1000],
} = {}) {
  assertPrivateDisplay();
  if (!existsSync(join(OUT, 'main/index.js')))
    throw new Error(`No build in ${OUT}: run test/e2e/run.mjs (it builds first).`);
  const home = join(WORK, 'home', name);
  if (!keepHome) rmScratch(home);
  mkdirSync(join(home, 'config'), { recursive: true });
  const mcpPort = settings.mcpPort ?? (await freePort());
  if (!keepHome) {
    writeFileSync(
      join(home, 'config/settings.json'),
      JSON.stringify({
        eagleCompatApi: false,
        mcpEnabled: false,
        mcpPort,
        writableRoots: [WORK],
        ...settings,
      }),
    );
    writeFileSync(
      join(home, 'config/libraries.json'),
      JSON.stringify(known.map((p) => ({ path: p, source: 'user' }))),
    );
    writeFileSync(
      join(home, 'config/window.json'),
      JSON.stringify({ width: size[0], height: size[1], x: 0, y: 0, maximized: false }),
    );
  }
  const childEnv = {
    ...process.env,
    BOOGIE_HOME: home,
    BOOGIE_WRITABLE_ROOTS: WORK,
    ELECTRON_OZONE_PLATFORM_HINT: 'x11',
    XDG_SESSION_TYPE: 'x11',
    ...env,
  };
  delete childEnv.WAYLAND_DISPLAY;
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: ['--ozone-platform=x11', OUT],
    env: childEnv,
    cwd: ROOT,
    timeout: 60_000,
  });
  let log = '';
  app.process().stdout?.on('data', (d) => (log += d));
  app.process().stderr?.on('data', (d) => (log += d));
  const win = await app.firstWindow();
  win.setDefaultTimeout(8000);
  const errors = [];
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  win.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await win.waitForLoadState('domcontentloaded');

  const ctx = {
    app,
    win,
    home,
    mcpPort,
    errors,
    get log() {
      return log;
    },
    /** Call a core/app method exactly the way the UI does (window.boogie.invoke). */
    call: (method, ...args) => win.evaluate(([m, a]) => window.boogie.invoke(m, a), [method, args]),
    /** Same, but resolves to the error message (or null when it succeeded). */
    callErr: (method, ...args) =>
      win.evaluate(
        ([m, a]) =>
          window.boogie.invoke(m, a).then(
            () => null,
            (e) => String(e.message ?? e),
          ),
        [method, args],
      ),
    until: (fn, what, ms = 10_000) => until(fn, what, ms),
    shot: async (file) => {
      mkdirSync(SHOTS, { recursive: true });
      await win.screenshot({ path: join(SHOTS, `${name}-${file}.png`) });
    },
    /** Open a library over IPC and wait for its index. */
    openLibrary: async (path, opts = {}) => {
      await ctx.call('openLibrary', path, opts);
      await until(
        async () => {
          const st = await ctx.call('getLibraryState');
          return st && st.ref.path === realpathSync(path) && st.indexing === null && st;
        },
        'the index to be ready',
        120_000,
      );
      // The renderer learns about the new library from the 'library' event; wait for its grid.
      await win.waitForSelector('.scroller [data-id], .empty', { timeout: 30_000 }).catch(() => {});
      await quiet(win);
      // The startup "Open a library" dialog stays up after an open that didn't come from it. It
      // can be closed once the page knows the library is open (its close button shows).
      if (await win.$('.dg-scrim')) {
        await until(
          async () => {
            if (!(await win.$('.dg-scrim'))) return true;
            await win.click('.dg-x', { timeout: 500 }).catch(() => {});
            return false;
          },
          'the startup library picker to close',
          10_000,
        );
      }
    },
    close: async () => {
      // Page errors don't fail a test by themselves, but they belong in the run log.
      const shown = errors.filter((e) => !/status of 40[0-9]|net::ERR_/.test(e));
      if (shown.length)
        console.log(`[${name}] page console errors:\n  ${shown.slice(0, 10).join('\n  ')}`);
      const crashes = log
        .split('\n')
        .filter((l) => /uncaught exception|unhandled rejection|\[boogie\] .* failed/i.test(l));
      if (crashes.length)
        console.log(`[${name}] main process problems:\n  ${crashes.slice(0, 10).join('\n  ')}`);
      await app.close().catch(() => app.process().kill('SIGKILL'));
    },
  };
  if (open) {
    try {
      await ctx.openLibrary(open, { readOnly });
    } catch (e) {
      await ctx.close(); // a failed setup must not leave Electron running (the test run would hang)
      throw e;
    }
    await sleep(300);
  }
  return ctx;
}

/**
 * Wait until the grid stops changing (no DOM changes for `ms`), so a test doesn't click a tile
 * that the first queries and thumbnail loads are about to re-render. Gives up quietly after 10 s.
 */
export async function quiet(win, ms = 600) {
  await win
    .evaluate(
      (ms) =>
        new Promise((done) => {
          const target = document.querySelector('.gridwrap') ?? document.body;
          let timer = setTimeout(finish, ms);
          const obs = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(finish, ms);
          });
          const cap = setTimeout(finish, 10_000);
          function finish() {
            obs.disconnect();
            clearTimeout(cap);
            done();
          }
          obs.observe(target, { subtree: true, childList: true, attributes: true });
        }),
      ms,
    )
    .catch(() => {});
}

export async function until(fn, what, ms = 10_000) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end)
      throw new Error(
        `timed out waiting for ${what}${last instanceof Error ? ` (last error: ${last.message})` : ''}`,
      );
    await sleep(100);
  }
}

/** Read the private display's clipboard with xclip (never your clipboard: see assertPrivateDisplay). */
export function readClipboard(target) {
  assertPrivateDisplay();
  return spawnSync('xclip', ['-selection', 'clipboard', '-o', '-t', target], {
    env: process.env,
    timeout: 5000,
  }).stdout;
}

/**
 * Put `file`'s bytes on the private display's clipboard as `target` (like another app copying).
 * xclip -quiet stays in the foreground and owns the selection until killed: call the returned stop().
 */
export async function setClipboard(target, file) {
  assertPrivateDisplay();
  const p = spawn('xclip', ['-quiet', '-selection', 'clipboard', '-t', target, '-i', file], {
    env: process.env,
    stdio: 'ignore',
  });
  p.unref(); // a forgotten stop() must not keep the test run alive
  await sleep(300);
  return () => p.kill();
}

export function mtimeOf(p) {
  return statSync(p).mtimeMs;
}

/** Wait for a core job (import, dupes, export...) to finish; returns its last progress. */
export async function waitJob(ctx, jobId, ms = 60_000) {
  const job = await until(
    async () => {
      const j = (await ctx.call('listJobs')).find((x) => x.jobId === jobId);
      return j && j.state !== 'running' && j;
    },
    `job ${jobId}`,
    ms,
  );
  if (job.state !== 'done') throw new Error(`job ${job.kind} ended ${job.state}: ${job.error}`);
  return job;
}

/** Import files through the core (setup for tests that need more items); returns the new ids. */
export async function importFiles(ctx, paths, opts = {}) {
  const { jobId } = await ctx.call('importPaths', paths, { onDuplicate: 'keep-both', ...opts });
  const job = await waitJob(ctx, jobId);
  return job.result.added;
}

export const FIXTURES = join(WORK, 'fixtures');

/** Small media files made with magick/ffmpeg, once: images, a GIF, videos, duplicates, a tree. */
export function makeFixtures() {
  const f = (name) => join(FIXTURES, name);
  if (existsSync(f('.done'))) return f;
  mkdirSync(join(FIXTURES, 'tree/Sub A/Deeper'), { recursive: true });
  mkdirSync(join(FIXTURES, 'tree/Sub B'), { recursive: true });
  const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'ignore' });
  run('magick', ['-size', '64x48', 'xc:#d02020', f('red.png')]);
  run('magick', ['-size', '48x64', 'xc:#2040d0', f('blue.png')]);
  run('magick', ['-size', '120x80', 'gradient:#20a040-#f0f0f0', f('green.jpg')]);
  run('magick', ['-size', '200x100', 'plasma:fractal', '-seed', '7', f('wide.png')]);
  run('magick', [
    '-delay',
    '20',
    '-size',
    '64x64',
    'xc:red',
    'xc:lime',
    'xc:blue',
    '-loop',
    '0',
    f('anim.gif'),
  ]);
  const src = join(TEMPLATES, 'sample.library/images/LT24XY3DPJFLK.info/0051.jpg');
  execFileSync('cp', [src, f('copy of 0051.jpg')]);
  run('vips', ['resize', src, f('smaller 0051.jpg'), '0.5']);
  run('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=320x240:rate=30',
    '-t',
    '2',
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    f('clip.mp4'),
  ]);
  run('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x240:rate=25',
    '-t',
    '2',
    '-c:v',
    'libvpx-vp9',
    f('clip.webm'),
  ]);
  run('magick', ['-size', '40x40', 'xc:orange', f('tree/Sub A/a1.png')]);
  run('magick', ['-size', '40x40', 'xc:purple', f('tree/Sub A/Deeper/a2.png')]);
  run('magick', ['-size', '40x40', 'xc:teal', f('tree/Sub B/b1.png')]);
  run('magick', ['-size', '40x40', 'xc:gray', f('tree/top.png')]);
  writeFileSync(f('.done'), '');
  return f;
}

/**
 * The Eagle write rules for one item, checked on disk: lastModified went up since `before`, and
 * mtime.json caught up to it (the core batches that write for about a second).
 */
export async function assertEagleWrite(lib, id, before) {
  const meta = itemMeta(lib, id);
  if (!(meta.lastModified > (before?.lastModified ?? 0)))
    throw new Error(
      `${id}: lastModified ${meta.lastModified} did not go up from ${before?.lastModified}`,
    );
  await until(
    () => mtimeJson(lib)[id] === meta.lastModified,
    `mtime.json[${id}] to reach ${meta.lastModified}`,
    8000,
  );
  return meta;
}

/**
 * `it`, plus a screenshot of the window when the test fails (.tmp/electron-qa/shots/<name>-FAIL-...).
 * Usage: const test = withShots(() => ctx); test('does a thing', async () => { ... });
 */
export function withShots(getCtx) {
  return (title, fn) =>
    it(title, async (t) => {
      try {
        await fn(t);
      } catch (e) {
        const slug = title.replace(/[^a-z0-9]+/gi, '-').slice(0, 50);
        await getCtx()
          ?.shot(`FAIL-${slug}`)
          .catch(() => {});
        throw e;
      }
    });
}
