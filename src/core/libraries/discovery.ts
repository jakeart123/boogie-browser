// First-run discovery of libraries: Eagle's own Settings (read-only) and ~/Dropbox.
// Everything here only reads. The real bottle is never written.
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';
import type { KnownLibrary } from '../../shared/types';

export interface DiscoveryOptions {
  home?: string;
  /** Eagle Settings files to read. Default: every user's Settings in the real Bottles Eagle prefix. */
  settingsFiles?: string[];
  /** Folder scanned for libraries sitting in it or one folder down. Default: ~/Dropbox. */
  dropboxDir?: string;
}

export interface Discovered {
  path: string;
  source: KnownLibrary['source'];
}

/**
 * Wine `Z:\home\user\Dropbox\A\A.library` becomes `/home/user/Dropbox/A/A.library`. Z: is the
 * Linux root in Wine; other drive letters point at Wine's own C: (no libraries we can use) and
 * give null. A path that is already POSIX is returned as it is.
 */
export function winePathToLinux(p: string): string | null {
  const raw = p.trim();
  if (raw.startsWith('/')) return posix.normalize(raw);
  const m = /^([a-zA-Z]):[\\/](.*)$/.exec(raw);
  if (!m || m[1].toLowerCase() !== 'z') return null;
  const linux = posix.normalize('/' + m[2].replace(/\\/g, '/'));
  return linux.length > 1 ? linux.replace(/\/+$/, '') : linux;
}

const BOTTLE_USERS = join(
  '.var/app/com.usebottles.bottles/data/bottles/bottles/Eagle/drive_c/users',
);

async function defaultSettingsFiles(home: string): Promise<string[]> {
  const usersDir = join(home, BOTTLE_USERS);
  try {
    const users = await readdir(usersDir);
    return users.map((u) => join(usersDir, u, 'AppData/Roaming/Eagle/Settings'));
  } catch {
    return [];
  }
}

async function fromEagleSettings(files: string[]): Promise<Discovered[]> {
  const found: Discovered[] = [];
  for (const file of files) {
    let data: { libraryHistory?: unknown; rootDir?: unknown };
    try {
      data = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      continue;
    }
    const raw: unknown[] = [];
    if (Array.isArray(data.libraryHistory)) raw.push(...data.libraryHistory);
    raw.push(data.rootDir);
    for (const entry of raw) {
      if (typeof entry !== 'string') continue;
      const linux = winePathToLinux(entry);
      if (linux && /\.library$/i.test(linux)) found.push({ path: linux, source: 'eagle-settings' });
    }
  }
  return found;
}

async function fromDropbox(dir: string): Promise<Discovered[]> {
  const found: Discovered[] = [];
  const isLibrary = (name: string) => /\.library$/i.test(name);
  let top;
  try {
    top = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of top) {
    if (!entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    if (isLibrary(entry.name)) {
      found.push({ path: full, source: 'user' });
      continue;
    }
    try {
      for (const child of await readdir(full, { withFileTypes: true })) {
        if (child.isDirectory() && isLibrary(child.name))
          found.push({ path: join(full, child.name), source: 'user' });
      }
    } catch {
      /* unreadable folder: skip */
    }
  }
  return found;
}

/** Unique by path, Eagle's Settings first. Does not check that the folders exist. */
export async function discoverLibraries(opts: DiscoveryOptions = {}): Promise<Discovered[]> {
  const home = opts.home ?? homedir();
  const settingsFiles = opts.settingsFiles ?? (await defaultSettingsFiles(home));
  const all = [
    ...(await fromEagleSettings(settingsFiles)),
    ...(await fromDropbox(opts.dropboxDir ?? join(home, 'Dropbox'))),
  ];
  const seen = new Set<string>();
  return all.filter((d) => (seen.has(d.path) ? false : (seen.add(d.path), true)));
}
