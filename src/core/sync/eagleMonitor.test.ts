import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createEagleMonitor, isEagleCommandLine, wineToPosix } from './eagleMonitor';
import { SCRATCH } from './testUtil';

describe('wineToPosix', () => {
  it.each([
    [
      'Z:\\home\\user\\Dropbox\\Course Library.library',
      '/home/user/Dropbox/Course Library.library',
    ],
    ['z:/home/user/x.library', '/home/user/x.library'],
    [
      'Z:\\run\\media\\user\\Drive\\Eagle Libraries\\Master Art Library.library',
      '/run/media/user/Drive/Eagle Libraries/Master Art Library.library',
    ],
    ['Z:\\home\\user\\x.library\\', '/home/user/x.library'],
    ['Z:\\', '/'],
    ['/home/user/already.library', '/home/user/already.library'],
    ['C:\\users\\user\\Documents\\x.library', null], // Wine's private C: drive: can't map
    ['D:\\art\\x.library', null],
    ['\\\\server\\share\\x.library', null],
    ['relative\\x.library', null],
    ['', null],
    [null, null],
  ])('%s -> %s', (input, expected) => {
    expect(wineToPosix(input)).toBe(expected);
  });
});

describe('isEagleCommandLine', () => {
  it('matches Eagle itself, however Wine spells the command', () => {
    expect(isEagleCommandLine(['C:\\users\\user\\AppData\\Roaming\\Eagle\\Eagle.exe'])).toBe(true);
    expect(
      isEagleCommandLine([
        'C:\\users\\user\\AppData\\Roaming\\Eagle\\Eagle.exe',
        '--type=gpu-process',
      ]),
    ).toBe(true);
    expect(
      isEagleCommandLine(['C:\\users\\user\\AppData\\Roaming\\Eagle\\Eagle.exe --type=renderer']),
    ).toBe(true);
    expect(isEagleCommandLine(['/usr/bin/wine', 'C:\\Program Files\\Eagle\\Eagle.exe'])).toBe(true);
  });
  it('does not match things that only mention it', () => {
    expect(isEagleCommandLine(['grep', '-l', 'Eagle.exe'])).toBe(false);
    expect(
      isEagleCommandLine([
        'bwrap',
        '--args',
        '82',
        '--',
        'bottles-cli',
        'run',
        '-b',
        'Eagle',
        '-p',
        'Eagle',
      ]),
    ).toBe(false);
    expect(
      isEagleCommandLine(['C:\\windows\\system32\\start.exe', '/wait', 'C:\\Eagle\\Eagle.exe']),
    ).toBe(false);
    expect(isEagleCommandLine(['C:\\tools\\NotEagle.exe'])).toBe(false);
    expect(isEagleCommandLine([])).toBe(false);
  });
});

// A fake /proc, a fake Eagle API on port 0, and a fake bottle: nothing here depends on a real Eagle.
mkdirSync(SCRATCH, { recursive: true });
const scratch = mkdtempSync(join(SCRATCH, 'mon-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let server: Server | null = null;
afterEach(async () => {
  const s = server;
  server = null;
  if (s) await new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())));
});

function fakeProc(name: string, procs: string[][]): string {
  const dir = join(scratch, name, 'proc');
  procs.forEach((args, i) => {
    mkdirSync(join(dir, String(1000 + i)), { recursive: true });
    writeFileSync(join(dir, String(1000 + i), 'cmdline'), args.join('\0') + '\0');
  });
  mkdirSync(join(dir, 'self'), { recursive: true }); // non-numeric entries are skipped
  return dir;
}

function fakeBottle(name: string, rootDir: string | null): string {
  const users = join(scratch, name, 'users');
  const eagle = join(users, 'user', 'AppData', 'Roaming', 'Eagle');
  mkdirSync(eagle, { recursive: true });
  mkdirSync(join(users, 'Public'), { recursive: true }); // a user with no Eagle settings
  if (rootDir !== null)
    writeFileSync(join(eagle, 'Settings'), JSON.stringify({ rootDir, libraryHistory: [] }));
  return users;
}

async function fakeApi(
  handler: (url: string) => { status?: number; body: unknown } | 'hang',
): Promise<string> {
  server = createServer((req, res) => {
    const r = handler(req.url ?? '');
    if (r === 'hang') return; // never answer
    res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.body));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const EAGLE = ['C:\\users\\user\\AppData\\Roaming\\Eagle\\Eagle.exe', '--type=gpu-process'];

describe('createEagleMonitor', () => {
  it('says not running when no Eagle.exe process exists (whatever else is going on)', async () => {
    const procDir = fakeProc('none', [
      ['/usr/bin/bash'],
      ['grep', '-l', 'Eagle.exe'],
      ['python', 'bridge.py'],
    ]);
    const apiUrl = await fakeApi(() => ({
      body: { status: 'success', data: { library: { path: 'Z:\\x.library' } } },
    }));
    const m = createEagleMonitor({
      procDir,
      apiUrl,
      usersDir: fakeBottle('none', 'Z:\\home\\user\\y.library'),
    });
    expect(await m.check()).toEqual({ running: false, openLibraryPath: null });
  });

  it('asks Eagle which library is open and converts the Wine path', async () => {
    const procDir = fakeProc('api', [['/usr/bin/bash'], EAGLE]);
    const apiUrl = await fakeApi(() => ({
      body: {
        status: 'success',
        data: {
          library: {
            path: 'Z:\\home\\user\\Dropbox\\Course Library.library',
            name: 'Course Library',
          },
        },
      },
    }));
    const m = createEagleMonitor({
      procDir,
      apiUrl,
      usersDir: fakeBottle('api', 'Z:\\home\\user\\stale.library'),
    });
    expect(await m.check()).toEqual({
      running: true,
      openLibraryPath: '/home/user/Dropbox/Course Library.library',
    });
  });

  it('falls back to the Settings file when the API is down or slow', async () => {
    const procDir = fakeProc('fallback', [EAGLE]);
    const users = fakeBottle(
      'fallback',
      'Z:\\run\\media\\user\\Drive\\Eagle Libraries\\Master Art Library.library',
    );
    const want = {
      running: true,
      openLibraryPath: '/run/media/user/Drive/Eagle Libraries/Master Art Library.library',
    };
    // nothing listening
    expect(
      await createEagleMonitor({ procDir, apiUrl: 'http://127.0.0.1:9', usersDir: users }).check(),
    ).toEqual(want);
    // listening but never answers
    const hang = await fakeApi(() => 'hang');
    const t0 = Date.now();
    expect(
      await createEagleMonitor({
        procDir,
        apiUrl: hang,
        apiTimeoutMs: 200,
        usersDir: users,
      }).check(),
    ).toEqual(want);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('does not mistake our own Eagle-compatible server for Eagle', async () => {
    const procDir = fakeProc('self', [EAGLE]);
    const users = fakeBottle('self', 'Z:\\home\\user\\eagles.library');
    const ours = await fakeApi(() => ({
      body: {
        status: 'success',
        data: { boogie: true, library: { path: '/home/user/OURS.library' } },
      },
    }));
    const marked = await createEagleMonitor({ procDir, apiUrl: ours, usersDir: users }).check();
    expect(marked).toEqual({ running: true, openLibraryPath: '/home/user/eagles.library' });

    // and when the app says it owns the port, the API is not even asked
    let asked = 0;
    const plain = await fakeApi(
      () => (asked++, { body: { data: { library: { path: '/home/user/OURS.library' } } } }),
    );
    const port = Number(new URL(plain).port);
    const m = createEagleMonitor({ procDir, apiUrl: plain, usersDir: users, selfPort: () => port });
    expect(await m.check()).toEqual({
      running: true,
      openLibraryPath: '/home/user/eagles.library',
    });
    expect(asked).toBe(0);
  });

  it('gives null (not the Settings library) when Eagle answers with a path we cannot map', async () => {
    const procDir = fakeProc('cdrive', [EAGLE]);
    const apiUrl = await fakeApi(() => ({
      body: { data: { library: { path: 'C:\\users\\user\\Documents\\x.library' } } },
    }));
    const m = createEagleMonitor({
      procDir,
      apiUrl,
      usersDir: fakeBottle('cdrive', 'Z:\\home\\user\\other.library'),
    });
    expect(await m.check()).toEqual({ running: true, openLibraryPath: null });
  });

  it('caches the answer for 5 seconds', async () => {
    const procDir = fakeProc('cache', [EAGLE]);
    let hits = 0;
    const apiUrl = await fakeApi(
      () => (hits++, { body: { data: { library: { path: 'Z:\\home\\user\\a.library' } } } }),
    );
    let t = 1_000_000;
    const m = createEagleMonitor({
      procDir,
      apiUrl,
      usersDir: fakeBottle('cache', null),
      now: () => t,
    });
    await Promise.all([m.check(), m.check(), m.check()]);
    t += 4900;
    await m.check();
    expect(hits).toBe(1);
    t += 200;
    await m.check();
    expect(hits).toBe(2);
  });
});
