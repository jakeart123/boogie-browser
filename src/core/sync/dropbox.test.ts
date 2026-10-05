import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDropboxStatus, parseDropboxStatus, parseFileStatus } from './dropbox';
import { SCRATCH } from './testUtil';

mkdirSync(SCRATCH, { recursive: true });
const scratch = mkdtempSync(join(SCRATCH, 'dbx-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
/** A bin folder holding one fake client that runs `body` (a shell snippet) when called. */
function fakeBin(body: string, name = 'dropbox-cli', header = ''): string {
  const dir = join(scratch, `bin${n++}`);
  mkdirSync(dir);
  writeFileSync(join(dir, name), `#!/bin/sh\n${header}\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
  return dir;
}

const say = (text: string) => `printf '%s\\n' "${text}"`;

describe('parseDropboxStatus', () => {
  it.each([
    ['Up to date', 'idle', 'Up to date'],
    ['Syncing...', 'syncing', 'Syncing...'],
    ['Syncing…', 'syncing', 'Syncing…'],
    [
      'Downloading 23 files (1.2 MB/sec, 3 minutes)',
      'syncing',
      'Downloading 23 files (1.2 MB/sec, 3 minutes)',
    ],
    [
      'Uploading 2 files (55 KB/sec, 1 minute)\nIndexing 4 files...',
      'syncing',
      'Uploading 2 files (55 KB/sec, 1 minute)',
    ],
    ["Dropbox isn't running!", 'offline', "Dropbox isn't running!"],
    [
      'Waiting to be linked to a Dropbox account...\nTo link this computer, visit https://x',
      'offline',
      'Waiting to be linked to a Dropbox account...',
    ],
    ['Syncing paused', 'offline', 'Syncing paused'],
    ['Uploading 1 file (paused.png)', 'syncing', 'Uploading 1 file (paused.png)'], // a file name is not a state
    ['Something new', 'unknown', 'Something new'],
    ['', 'unknown', 'Dropbox status unavailable'],
  ])('%j', (out, state, detail) => {
    expect(parseDropboxStatus(out)).toEqual({ state, detail });
  });
});

describe('createDropboxStatus', () => {
  it('runs `status` on the client and maps the answer', async () => {
    // The fake echoes back the argument it was given, so this also proves we call `status`.
    const bin = fakeBin('[ "$1" = status ] && echo "Up to date" || echo "wrong args: $*"');
    expect(await createDropboxStatus({ binDirs: [bin] }).check()).toEqual({
      state: 'idle',
      detail: 'Up to date',
    });
  });

  it('is unknown when there is no client, when it fails to start, and when it hangs (2 s limit)', async () => {
    const none = await createDropboxStatus({ binDirs: [join(scratch, 'empty')] }).check();
    expect(none).toEqual({ state: 'unknown', detail: 'Dropbox status unavailable' });

    const noOutput = fakeBin('exit 3');
    expect(await createDropboxStatus({ binDirs: [noOutput] }).check()).toEqual({
      state: 'unknown',
      detail: 'Dropbox status unavailable',
    });

    // `sleep` as a child of the script: the timeout must not wait for it either.
    const hang = fakeBin('sleep 31');
    const t0 = Date.now();
    const r = await createDropboxStatus({ binDirs: [hang], timeoutMs: 300 }).check();
    expect(r).toEqual({ state: 'unknown', detail: 'Dropbox status unavailable' });
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('also accepts the stock `dropbox` frontend script, but not a `dropbox` that is something else', async () => {
    const frontend = fakeBin(say('Syncing...'), 'dropbox', '# Dropbox frontend script');
    expect(await createDropboxStatus({ binDirs: [frontend] }).check()).toEqual({
      state: 'syncing',
      detail: 'Syncing...',
    });

    const daemon = fakeBin(say('Up to date'), 'dropbox', '# starts the Dropbox daemon');
    expect((await createDropboxStatus({ binDirs: [daemon] }).check()).state).toBe('unknown');
  });

  it('reuses the answer for 3 seconds', async () => {
    const counter = join(scratch, 'calls');
    writeFileSync(counter, '');
    const bin = fakeBin(`echo x >> "${counter}"; echo "Up to date"`);
    let t = 5_000;
    const s = createDropboxStatus({ binDirs: [bin], now: () => t });
    await Promise.all([s.check(), s.check()]);
    t += 2900;
    await s.check();
    t += 200;
    await s.check();
    expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(2);
  });
});

describe('fileStatus', () => {
  const lib = '/sync/Dropbox/Shared.library';
  const a = `${lib}/metadata.json`;
  const b = `${lib}/images/X.info/metadata (Sam's conflicted copy 2026-09-28).json`;
  const c = `${lib}/images/Y.info/Y_thumbnail.png`;

  it('reads one `path: status` line per path, and anything odd is unknown', () => {
    const out = `${a}:    up to date\n${b}:   syncing\n${c}:   unwatched\n`;
    expect(parseFileStatus(out, [a, b, c])).toEqual({
      [a]: 'upToDate',
      [b]: 'syncing',
      [c]: 'unknown',
    });
    expect(parseFileStatus('', [a])).toEqual({ [a]: 'unknown' });
    expect(parseFileStatus(`${a}: Downloading 1 file\n`, [a, b])).toEqual({
      [a]: 'syncing',
      [b]: 'unknown',
    });
  });

  it('runs `filestatus` with the paths on the client', async () => {
    // The fake prints a status line per path it was given, so this proves the arguments arrive whole.
    const bin = fakeBin(
      'for p in "$@"; do [ "$p" = filestatus ] && continue; case "$p" in *copy*) echo "$p:   syncing";; *) echo "$p:   up to date";; esac; done',
    );
    const dropbox = createDropboxStatus({ binDirs: [bin] });
    expect(await dropbox.fileStatus!([a, b])).toEqual({ [a]: 'upToDate', [b]: 'syncing' });
    expect(await dropbox.fileStatus!([])).toEqual({});
  });

  it('is unknown with no client, a failing client, and a hanging one (and does not wait for it)', async () => {
    const none = createDropboxStatus({ binDirs: [join(scratch, 'empty')] });
    expect(await none.fileStatus!([a])).toEqual({ [a]: 'unknown' });
    const failing = createDropboxStatus({ binDirs: [fakeBin('exit 3')] });
    expect(await failing.fileStatus!([a])).toEqual({ [a]: 'unknown' });
    const hang = createDropboxStatus({ binDirs: [fakeBin('sleep 31')], timeoutMs: 300 });
    const t0 = Date.now();
    expect(await hang.fileStatus!([a])).toEqual({ [a]: 'unknown' });
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});
