import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setWritableRoots, writableRoots } from '../safety/writeGuard';
import { discoverLibraries, winePathToLinux } from './discovery';
import { createKnownStore } from './known';
import { DEFAULT_SETTINGS, createSettingsStore } from './settings';

const base = resolve('.tmp/service');
let dir: string;

beforeAll(() => {
  mkdirSync(base, { recursive: true });
  dir = mkdtempSync(join(base, 'libraries-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => setWritableRoots([]));

function fakeLibrary(path: string): void {
  mkdirSync(join(path, 'images'), { recursive: true });
  writeFileSync(join(path, 'metadata.json'), '{}');
}

/** A Wine path for a real folder on this machine: Z:\ plus the path with backslashes. */
const toWine = (p: string) => 'Z:' + p.replace(/\//g, '\\');

describe('winePathToLinux', () => {
  it('turns Z: paths into Linux paths and skips other drives', () => {
    expect(winePathToLinux('Z:\\home\\user\\Dropbox\\A\\A.library')).toBe(
      '/home/user/Dropbox/A/A.library',
    );
    expect(winePathToLinux('z:/home/user/x.library/')).toBe('/home/user/x.library');
    expect(winePathToLinux('C:\\Users\\user\\Eagle\\Local.library')).toBeNull();
    expect(winePathToLinux('/already/posix.library')).toBe('/already/posix.library');
    expect(winePathToLinux('not a path')).toBeNull();
  });
});

describe('settings', () => {
  it('starts from the defaults, keeps good values, and drops bad ones from a hand-edited file', async () => {
    const cfg = join(dir, 'settings-a');
    mkdirSync(cfg, { recursive: true });
    writeFileSync(
      join(cfg, 'settings.json'),
      JSON.stringify({ theme: 'light', thumbSize: 'huge', mcpPort: 41999, nonsense: 1 }),
    );
    const store = createSettingsStore(cfg);
    const s = await store.load();
    expect(s).toEqual({ ...DEFAULT_SETTINGS, theme: 'light', mcpPort: 41999 });
  });

  it('a settings.json from an older build (auto-repair switch) loads, and the next save drops it', async () => {
    const cfg = join(dir, 'settings-old');
    mkdirSync(cfg, { recursive: true });
    writeFileSync(
      join(cfg, 'settings.json'),
      JSON.stringify({ theme: 'light', autoHealStaleOverwrites: true }),
    );
    const store = createSettingsStore(cfg);
    expect(await store.load()).toEqual({ ...DEFAULT_SETTINGS, theme: 'light' });
    await store.update({ thumbSize: 200 });
    expect(readFileSync(join(cfg, 'settings.json'), 'utf8')).not.toContain('autoHeal');
  });

  it('writes atomically, rejects bad values from the UI, and pushes writable roots into the write guard', async () => {
    const cfg = join(dir, 'settings-b');
    const store = createSettingsStore(cfg);
    await store.load();
    await expect(store.update({ theme: 'purple' as never })).rejects.toThrow(/theme/);
    await expect(store.update({ writableRoots: ['relative/path'] })).rejects.toThrow(
      /writableRoots/,
    );

    const root = join(dir, 'allowed');
    const next = await store.update({ writableRoots: [root, root], thumbSize: 5000 });
    expect(next.writableRoots).toEqual([root]);
    expect(next.thumbSize).toBe(1000);
    expect(writableRoots()).toContain(resolve(root));
    expect(JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf8')).writableRoots).toEqual([
      root,
    ]);

    // A fresh store sees what was saved, and loading also arms the guard.
    setWritableRoots([]);
    const again = createSettingsStore(cfg);
    await again.load();
    expect(again.get().writableRoots).toEqual([root]);
    expect(writableRoots()).toContain(resolve(root));
  });
});

describe('discovery and the known list', () => {
  it('reads Eagle Settings (Z: only) and ~/Dropbox, and marks shared libraries', async () => {
    const home = join(dir, 'home-a');
    const wineLib = join(home, 'Dropbox', 'Course Library', 'Course Library.library');
    const looseLib = join(home, 'Dropbox', 'Loose.library');
    const localLib = join(home, 'Art', 'Mine.library');
    for (const p of [wineLib, looseLib, localLib]) fakeLibrary(p);
    const settings = join(home, 'Settings');
    writeFileSync(
      settings,
      JSON.stringify({
        rootDir: toWine(localLib),
        libraryHistory: [
          toWine(wineLib),
          'C:\\Users\\user\\Documents\\Windows.library',
          toWine(localLib),
        ],
      }),
    );

    const found = await discoverLibraries({ home, settingsFiles: [settings] });
    expect(found.map((f) => f.path).sort()).toEqual([localLib, looseLib, wineLib].sort());
    expect(found.find((f) => f.path === localLib)?.source).toBe('eagle-settings');

    const known = createKnownStore({
      configDir: join(dir, 'cfg-a'),
      home,
      discovery: { settingsFiles: [settings] },
    });
    const list = await known.list();
    expect(list).toHaveLength(3);
    const byName = Object.fromEntries(list.map((k) => [k.name, k]));
    expect(byName['Course Library']).toMatchObject({
      shared: true,
      partnerName: null,
      exists: true,
    });
    expect(byName['Loose']).toMatchObject({ shared: true, partnerName: null });
    expect(byName['Mine']).toMatchObject({
      shared: false,
      partnerName: null,
      source: 'eagle-settings',
    });
  });

  it('sorts by last opened then name, forgets, and does not rediscover a non-empty list', async () => {
    const home = join(dir, 'home-b');
    const [a, b, c] = ['Alpha', 'Bravo', 'Charlie'].map((n) => join(home, 'libs', `${n}.library`));
    for (const p of [a, b, c]) fakeLibrary(p);
    const known = createKnownStore({
      configDir: join(dir, 'cfg-b'),
      home,
      discovery: { settingsFiles: [], dropboxDir: join(home, 'none') },
    });
    for (const p of [a, b, c]) await known.add(p, 'user');
    expect((await known.list()).map((k) => k.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);

    await known.touch(c);
    await new Promise((r) => setTimeout(r, 5));
    await known.touch(b);
    expect((await known.list()).map((k) => k.name)).toEqual(['Bravo', 'Charlie', 'Alpha']);

    await known.setOptions(a, { partnerName: 'Sam', shared: true });
    await known.forget(b);
    // A second store reading the same file sees the saved state.
    const reread = createKnownStore({
      configDir: join(dir, 'cfg-b'),
      home,
      discovery: { settingsFiles: [], dropboxDir: join(home, 'none') },
    });
    const list = await reread.list();
    expect(list.map((k) => k.name)).toEqual(['Charlie', 'Alpha']);
    expect(list.find((k) => k.name === 'Alpha')).toMatchObject({
      shared: true,
      partnerName: 'Sam',
    });
  });

  it('marks a library shared when a parent folder has the .dropbox file, wherever Dropbox lives', async () => {
    const home = join(dir, 'home-d');
    const dropbox = join(dir, 'elsewhere', 'Work Dropbox');
    const far = join(dropbox, 'Shared', 'Far.library');
    const near = join(home, 'Art', 'Near.library');
    for (const p of [far, near]) fakeLibrary(p);
    writeFileSync(join(dropbox, '.dropbox'), '{}');
    // Dropbox's settings folder in home has the same name; it must not make home shared.
    mkdirSync(join(home, '.dropbox'));
    const known = createKnownStore({
      configDir: join(dir, 'cfg-d'),
      home,
      discovery: { settingsFiles: [], dropboxDir: join(home, 'none') },
    });
    expect(await known.add(far, 'user')).toMatchObject({ shared: true, partnerName: null });
    expect(await known.add(near, 'user')).toMatchObject({ shared: false, partnerName: null });
  });

  it('shows a library whose folder is gone as not existing', async () => {
    const home = join(dir, 'home-c');
    const gone = join(home, 'libs', 'Gone.library');
    const known = createKnownStore({
      configDir: join(dir, 'cfg-c'),
      home,
      discovery: { settingsFiles: [], dropboxDir: join(home, 'none') },
    });
    await known.add(gone, 'user');
    expect((await known.list())[0]).toMatchObject({ name: 'Gone', exists: false });
  });
});
