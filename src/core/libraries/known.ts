// The list of libraries Boogie knows about: <config>/libraries.json.
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { KnownLibrary } from '../../shared/types';
import { libraryRef } from '../libraryId';
import { discoverLibraries, type DiscoveryOptions } from './discovery';
import { pathExists, readJsonFile, writeFileAtomic } from './fsutil';

export interface KnownStore {
  /** Sorted: most recently opened first, then by name. `exists` is checked fresh. */
  list(): Promise<KnownLibrary[]>;
  find(path: string): Promise<KnownLibrary | undefined>;
  /** Adds the library if new (does not touch an existing entry). */
  add(path: string, source: KnownLibrary['source']): Promise<KnownLibrary>;
  /** Marks a library as just opened (adding it first if needed). */
  touch(path: string, source?: KnownLibrary['source']): Promise<KnownLibrary>;
  forget(path: string): Promise<void>;
  setOptions(
    path: string,
    opts: { partnerName?: string | null; shared?: boolean },
  ): Promise<KnownLibrary | undefined>;
}

export interface KnownStoreOptions {
  configDir: string;
  home?: string;
  discovery?: DiscoveryOptions;
}

/**
 * Dropbox leaves a small `.dropbox` file in the root of the folder it syncs, so this finds a Dropbox
 * folder wherever it lives. Only a file counts: Dropbox's own settings folder `~/.dropbox` is a
 * directory, and would otherwise mark everything in home as shared.
 */
function inDropboxFolder(path: string): boolean {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    try {
      if (statSync(join(dir, '.dropbox')).isFile()) return true;
    } catch {
      /* no marker here */
    }
    if (dirname(dir) === dir) return false;
  }
}

export function createKnownStore(opts: KnownStoreOptions): KnownStore {
  const file = join(opts.configDir, 'libraries.json');
  const home = opts.home ?? homedir();
  let entries: KnownLibrary[] | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  // One operation at a time: the list is tiny and this keeps load/save races impossible.
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const dropboxRoot = (): string => {
    const d = resolve(home, 'Dropbox');
    try {
      return realpathSync(d);
    } catch {
      return d;
    }
  };
  const isShared = (path: string): boolean =>
    path.startsWith(dropboxRoot() + sep) || inDropboxFolder(path);

  const make = (path: string, source: KnownLibrary['source']): KnownLibrary => {
    const ref = libraryRef(path);
    const shared = isShared(ref.path);
    return {
      ...ref,
      lastOpenedAt: null,
      exists: false,
      source,
      shared,
      partnerName: null,
    };
  };

  const save = () => writeFileAtomic(file, JSON.stringify(entries, null, 2) + '\n');

  async function load(): Promise<KnownLibrary[]> {
    if (entries) return entries;
    const raw = await readJsonFile(file);
    entries = [];
    if (Array.isArray(raw)) {
      for (const e of raw as Partial<KnownLibrary>[]) {
        if (!e || typeof e.path !== 'string') continue;
        // id/path/name come from the real path every time: caches are keyed by it.
        entries.push({ ...make(e.path, e.source ?? 'user'), ...e, ...libraryRef(e.path) });
      }
    }
    if (entries.length === 0) {
      for (const d of await discoverLibraries({ home, ...opts.discovery })) {
        const entry = make(d.path, d.source);
        if (!entries.some((x) => x.id === entry.id)) entries.push(entry);
      }
      await save();
    }
    return entries;
  }

  const findIn = (list: KnownLibrary[], path: string) => {
    const id = libraryRef(path).id;
    return list.find((e) => e.id === id);
  };

  return {
    list: () =>
      serial(async () => {
        const all = await load();
        const checked = await Promise.all(
          all.map(async (e) => ({ ...e, exists: await pathExists(join(e.path, 'metadata.json')) })),
        );
        return checked.sort(
          (a, b) =>
            (b.lastOpenedAt ?? -1) - (a.lastOpenedAt ?? -1) ||
            a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
        );
      }),

    find: (path) => serial(async () => findIn(await load(), path)),

    add: (path, source) =>
      serial(async () => {
        const all = await load();
        const existing = findIn(all, path);
        if (existing) return existing;
        const entry = make(path, source);
        all.push(entry);
        await save();
        return entry;
      }),

    touch: (path, source = 'user') =>
      serial(async () => {
        const all = await load();
        let entry = findIn(all, path);
        if (!entry) all.push((entry = make(path, source)));
        entry.lastOpenedAt = Date.now();
        await save();
        return entry;
      }),

    forget: (path) =>
      serial(async () => {
        const all = await load();
        const id = libraryRef(path).id;
        const next = all.filter((e) => e.id !== id);
        if (next.length === all.length) return;
        entries = next;
        await save();
      }),

    setOptions: (path, o) =>
      serial(async () => {
        const entry = findIn(await load(), path);
        if (!entry) return undefined;
        if (o.partnerName !== undefined) entry.partnerName = o.partnerName?.trim() || null;
        if (o.shared !== undefined) entry.shared = o.shared;
        await save();
        return entry;
      }),
  };
}
