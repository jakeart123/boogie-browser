// EagleMonitor: is Windows Eagle (running under Wine/Bottles) open on this machine, and which
// library does it have loaded? Two Eagles editing one library is how libraries get damaged
// (Eagle has no lock and writes non-atomically), so the service goes read-only when it is.
//
// Everything here only READS: /proc, one GET to Eagle's local API, and Eagle's Settings file.
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';
import type { EagleMonitor } from '../contracts';

export interface EagleMonitorOptions {
  /** Where process command lines live. Default /proc. */
  procDir?: string;
  /** Eagle's local API. Default http://127.0.0.1:41595. */
  apiUrl?: string;
  apiTimeoutMs?: number;
  /**
   * `<bottle>/drive_c/users`. Each user folder may hold AppData/Roaming/Eagle/Settings.
   * Default: the Eagle bottle in the Bottles flatpak. Read only, never written.
   */
  usersDir?: string;
  /** The port OUR OWN Eagle-compatible API is listening on, if any. If that is the port we would ask, skip the call. */
  selfPort?: () => number | null | undefined;
  /** How long a result is reused. Default 5000. */
  ttlMs?: number;
  now?: () => number;
}

const API_TIMEOUT_MS = 500;
const DEFAULT_API = 'http://127.0.0.1:41595';

/**
 * Wine path to a Linux path. `Z:` is Wine's mapping of `/`, so `Z:\home\user\x.library` becomes
 * `/home/user/x.library`. Any other drive letter (C: is Wine's private disk) or a UNC path can't
 * be located from here: null. A path that is already absolute Linux is returned as is.
 */
export function wineToPosix(p: string | null | undefined): string | null {
  if (typeof p !== 'string') return null;
  const s = p.trim();
  if (!s) return null;
  let rest: string;
  if (/^z:[\\/]/i.test(s) || /^z:$/i.test(s)) rest = s.slice(2);
  else if (s.startsWith('/') && !s.startsWith('//')) rest = s;
  else return null;
  const out = posix.normalize('/' + rest.replace(/\\/g, '/'));
  return out.length > 1 ? out.replace(/\/+$/, '') : out;
}

/**
 * Does this command line belong to Windows Eagle? Wine rewrites the process command line to the
 * Windows one, so the main process reads `C:\...\Eagle.exe` as its first argument (its kernel name
 * is `CrBrowserMain`, which is why we match the command line and not the name). Only the program
 * itself counts: an editor or grep that merely has "Eagle.exe" in its arguments must not.
 */
export function isEagleCommandLine(args: string[]): boolean {
  // `\s` also accepts the space-joined form in case a Wine build doesn't NUL-separate the words.
  const isEagleExe = (a: string | undefined) => /(^|[\\/])eagle\.exe(\s|$)/i.test(a ?? '');
  if (isEagleExe(args[0])) return true;
  const launcher = (args[0] ?? '').split('/').pop()!;
  return /^wine(64)?(-preloader)?$/.test(launcher) && args.slice(1).some(isEagleExe);
}

async function eagleProcessRunning(procDir: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = (await readdir(procDir)).filter((n) => /^\d+$/.test(n));
  } catch {
    return false;
  }
  const BATCH = 64;
  for (let i = 0; i < entries.length; i += BATCH) {
    const hits = await Promise.all(
      entries.slice(i, i + BATCH).map(async (pid) => {
        try {
          const raw = await readFile(join(procDir, pid, 'cmdline'), 'latin1');
          return isEagleCommandLine(raw.split('\0').filter(Boolean));
        } catch {
          return false; // the process ended while we looked
        }
      }),
    );
    if (hits.some(Boolean)) return true;
  }
  return false;
}

/** Ask Eagle's own API which library it has open. null = no usable answer. */
async function libraryFromApi(
  base: string,
  timeoutMs: number,
): Promise<{ path: string | null } | null> {
  try {
    const res = await fetch(`${base}/api/library/info`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body: any = await res.json();
    const data = body?.data;
    // Our own Eagle-compatible server answers on the same port when Eagle is not there.
    if (body?.boogie === true || data?.boogie === true || data?.application?.boogie === true)
      return null;
    const path = data?.library?.path;
    return typeof path === 'string' ? { path: wineToPosix(path) } : null;
  } catch {
    return null;
  }
}

/** `rootDir` from the newest Eagle Settings file in the bottle (the library Eagle opened last). */
async function libraryFromSettings(usersDir: string): Promise<string | null> {
  let users: string[];
  try {
    users = await readdir(usersDir);
  } catch {
    return null;
  }
  const found: { file: string; mtimeMs: number }[] = [];
  for (const u of users) {
    const file = join(usersDir, u, 'AppData', 'Roaming', 'Eagle', 'Settings');
    try {
      found.push({ file, mtimeMs: (await stat(file)).mtimeMs });
    } catch {
      // this user has no Eagle settings
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { file } of found) {
    try {
      const rootDir = JSON.parse(await readFile(file, 'utf8'))?.rootDir;
      if (typeof rootDir === 'string') return wineToPosix(rootDir);
    } catch {
      // unreadable or half-written: try the next one
    }
  }
  return null;
}

export function createEagleMonitor(opts: EagleMonitorOptions = {}): EagleMonitor {
  const procDir = opts.procDir ?? '/proc';
  const apiUrl = (opts.apiUrl ?? DEFAULT_API).replace(/\/+$/, '');
  const apiPort = Number(new URL(apiUrl).port) || 80;
  const timeoutMs = opts.apiTimeoutMs ?? API_TIMEOUT_MS;
  const usersDir =
    opts.usersDir ??
    join(homedir(), '.var/app/com.usebottles.bottles/data/bottles/bottles/Eagle/drive_c/users');
  const ttlMs = opts.ttlMs ?? 5000;
  const now = opts.now ?? Date.now;

  type Result = { running: boolean; openLibraryPath: string | null };
  let cached: { at: number; value: Promise<Result> } | null = null;

  async function look(): Promise<Result> {
    if (!(await eagleProcessRunning(procDir))) return { running: false, openLibraryPath: null };
    const weOwnThePort = opts.selfPort?.() === apiPort;
    const fromApi = weOwnThePort ? null : await libraryFromApi(apiUrl, timeoutMs);
    // A working answer wins even when the path can't be mapped to Linux (that means null, not "ask Settings").
    const openLibraryPath = fromApi ? fromApi.path : await libraryFromSettings(usersDir);
    return { running: true, openLibraryPath };
  }

  return {
    check() {
      if (cached && now() - cached.at < ttlMs) return cached.value;
      const value = look().catch((): Result => ({ running: false, openLibraryPath: null }));
      cached = { at: now(), value };
      return value;
    },
  };
}
