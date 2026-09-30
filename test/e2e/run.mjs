#!/usr/bin/env node
// Runs the end-to-end suite against the REAL Electron app and the REAL core.
//
//   npm run e2e:full                      build, then every test/e2e/*.e2e.mjs
//   npm run e2e:full -- viewer search     only files whose name contains one of these words
//   npm run e2e:full -- --no-build        reuse the last build in .tmp/electron-qa/out
//   E2E_WORK=$PWD/.tmp/<you>/e2e npm run e2e:full   your own scratch + build folder (absolute path)
//
// It builds into .tmp/electron-qa/out, starts a private Xvfb display, and runs node's test
// runner on it with WAYLAND_DISPLAY removed, so no window, drag or clipboard write can reach
// the desktop. Screenshots land in .tmp/electron-qa/shots/.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT, ROOT, sleep } from './lib/harness.mjs';

const argv = process.argv.slice(2);
const filters = argv.filter((a) => !a.startsWith('--'));

if (!argv.includes('--no-build')) {
  console.log(`Building into ${OUT} ...`);
  const r = spawnSync('npx', ['electron-vite', 'build', '--outDir', OUT], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
// The build folder is launched as the app, so it needs its own package.json (ESM main).
writeFileSync(
  join(OUT, 'package.json'),
  JSON.stringify({ name: 'boogie-browser', type: 'module', main: 'main/index.js' }),
);

// A display number nobody uses (your desktop and any other Xvfbs have their own).
let display = null;
for (let n = 90; n < 200 && !display; n++)
  if (!existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`)) display = `:${n}`;
if (!display) throw new Error('no free X display number');
const xvfb = spawn('Xvfb', [display, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], {
  stdio: 'ignore',
});
for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${display.slice(1)}`); i++) await sleep(100);

const dir = join(ROOT, 'test/e2e');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.e2e.mjs'))
  .filter((f) => !filters.length || filters.some((w) => f.includes(w)))
  .sort()
  .map((f) => join(dir, f));

const env = { ...process.env, DISPLAY: display, E2E_DISPLAY: display };
delete env.WAYLAND_DISPLAY;
console.log(`Running ${files.length} file(s) on Xvfb ${display}`);
const test = spawn(
  process.execPath,
  ['--test', '--test-concurrency=1', '--test-timeout=300000', ...files],
  { cwd: ROOT, env, stdio: 'inherit' },
);
const code = await new Promise((res) => test.on('exit', (c) => res(c ?? 1)));
xvfb.kill();
process.exit(code);
