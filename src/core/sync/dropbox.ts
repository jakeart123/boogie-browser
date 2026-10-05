// DropboxStatus: asks the Dropbox command line client what the daemon is doing, so the status
// strip can say "Syncing 12 files" or "Dropbox is offline". Read-only: `status` never changes anything.
import { spawn } from 'node:child_process';
import { access, constants, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { DropboxStatus } from '../contracts';

type State = Awaited<ReturnType<DropboxStatus['check']>>;

export interface DropboxStatusOptions {
  /** Folders to look for the client in. Default: $PATH plus the usual places a desktop launch may lack. */
  binDirs?: string[];
  timeoutMs?: number; // default 2000
  ttlMs?: number; // default 3000
  now?: () => number;
}

const UNAVAILABLE: State = { state: 'unknown', detail: 'Dropbox status unavailable' };

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The stock Dropbox frontend script (what `dropbox-cli` is on Arch) calls itself that in its header. */
async function isDropboxFrontend(file: string): Promise<boolean> {
  let fh;
  try {
    fh = await open(file, 'r');
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(512), 0, 512, 0);
    return buffer.subarray(0, bytesRead).toString('latin1').includes('Dropbox frontend script');
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

/** `dropbox-cli`, or a `dropbox` that is the frontend script (not the daemon launcher some packages ship under that name). */
async function findClient(dirs: string[]): Promise<string | null> {
  for (const name of ['dropbox-cli', 'dropbox']) {
    for (const dir of dirs) {
      const file = join(dir, name);
      if (!(await isExecutable(file))) continue;
      if (name === 'dropbox-cli' || (await isDropboxFrontend(file))) return file;
    }
  }
  return null;
}

/** Run `file <args>`; resolves with stdout, or null on any failure or timeout. Never leaves a process behind. */
function runClient(file: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    // Own process group so a timeout can take the client's children down with it.
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdout.destroy();
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL'); // no-op error if it already exited
      } catch {
        // already gone
      }
      resolve(value);
    };
    // Our own timer, not execFile's: a killed shell script can leave a child holding the pipe open.
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      if (out.length < 65536) out += d.toString('utf8');
    });
    child.on('error', () => finish(null));
    child.on('close', () => finish(out));
  });
}

export function parseDropboxStatus(output: string): State {
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const first = lines[0];
  if (!first) return UNAVAILABLE;
  const text = lines.join(' ').toLowerCase();
  // Not running, not linked to an account and paused all mean nothing is being synced right now.
  const head = first.toLowerCase();
  if (
    /isn'?t running|not running/.test(text) ||
    head.startsWith('waiting to be linked') ||
    (/\bpaused\b/.test(head) && !/^(uploading|downloading|indexing)/.test(head))
  )
    return { state: 'offline', detail: first };
  if (/^up to date/.test(text)) return { state: 'idle', detail: 'Up to date' };
  if (/syncing|downloading|uploading|indexing|connecting|starting/.test(text))
    return { state: 'syncing', detail: first };
  return { state: 'unknown', detail: first };
}

type FileState = 'upToDate' | 'syncing' | 'unknown';

/**
 * `dropbox filestatus a b ...` prints one `<path>:   <status>` line per path ("up to date",
 * "syncing", "unwatched" ...). Anything missing or odd is 'unknown', which never blocks anything.
 */
export function parseFileStatus(
  output: string,
  paths: readonly string[],
): Record<string, FileState> {
  const lines = output.split('\n').filter((l) => l.trim());
  const out: Record<string, FileState> = {};
  const read = (text: string): FileState => {
    const t = text.trim().toLowerCase();
    if (t === 'up to date') return 'upToDate';
    if (/^(syncing|downloading|uploading|indexing)/.test(t)) return 'syncing';
    return 'unknown';
  };
  paths.forEach((path, i) => {
    const line = lines.find((l) => l.startsWith(`${path}:`));
    // One line per path in order: if the client printed the path in another form (a resolved link), trust the position.
    const byPosition =
      lines.length === paths.length ? lines[i]?.replace(/^.*?:\s+/, '') : undefined;
    out[path] = line !== undefined ? read(line.slice(path.length + 1)) : read(byPosition ?? '');
  });
  return out;
}

export function createDropboxStatus(opts: DropboxStatusOptions = {}): DropboxStatus {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const ttlMs = opts.ttlMs ?? 3000;
  const now = opts.now ?? Date.now;
  const dirs = () =>
    opts.binDirs ?? [
      ...(process.env.PATH ?? '').split(delimiter).filter(Boolean),
      join(homedir(), '.local', 'bin'),
      '/usr/local/bin',
      '/usr/bin',
    ];

  let cached: { at: number; value: Promise<State> } | null = null;

  async function look(): Promise<State> {
    const client = await findClient(dirs());
    if (!client) return UNAVAILABLE;
    const out = await runClient(client, ['status'], timeoutMs);
    return out === null ? UNAVAILABLE : parseDropboxStatus(out);
  }

  return {
    check() {
      if (cached && now() - cached.at < ttlMs) return cached.value;
      const value = look().catch(() => UNAVAILABLE);
      cached = { at: now(), value };
      return value;
    },

    async fileStatus(paths) {
      const unknown = () => Object.fromEntries(paths.map((p) => [p, 'unknown' as const]));
      if (!paths.length) return {};
      try {
        const client = await findClient(dirs());
        if (!client) return unknown();
        const out = await runClient(client, ['filestatus', ...paths], timeoutMs);
        return out === null ? unknown() : parseFileStatus(out, paths);
      } catch {
        return unknown();
      }
    },
  };
}
