// The last line of defense for real libraries. Every code path that creates, replaces,
// renames or removes anything inside a library calls assertWritable() first.
//
// Two rules:
// 1. The target must be inside one of the writable roots (settings.writableRoots, or
//    BOOGIE_WRITABLE_ROOTS, colon-separated). In development that is only this project's
//    .tmp/ and research/sandbox/libs/.
// 2. Protected places (Dropbox, removable/mounted drives, ~/Staging) stay blocked even if a
//    root covers them, unless BOOGIE_ALLOW_PROTECTED=1 is set. You set that yourself once you
//    decide Boogie may edit your real libraries. A Dropbox folder anywhere counts: Dropbox keeps
//    a `.dropbox` FILE in its root folder (its settings folder in home is a `.dropbox` folder).
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

export class WriteBlockedError extends Error {
  constructor(
    readonly target: string,
    reason: string,
  ) {
    super(`Write blocked (${reason}): ${target}`);
    this.name = 'WriteBlockedError';
  }
}

const home = homedir();
const PROTECTED = [
  resolve(home, 'Dropbox'),
  resolve(home, 'Staging'),
  '/run/media',
  '/media',
  '/mnt',
];

let roots: string[] = fromEnv();

function fromEnv(): string[] {
  const raw = process.env.BOOGIE_WRITABLE_ROOTS;
  return raw ? raw.split(':').filter(Boolean).map(canonical) : [];
}

/** Resolve symlinks through the nearest existing ancestor, so a link can't smuggle a write out. */
export function canonical(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    tail.unshift(cur.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cur = parent;
  }
  const real = existsSync(cur) ? realpathSync(cur) : cur;
  return tail.length ? resolve(real, ...tail) : real;
}

/** Folders known to hold (or not hold) Dropbox's `.dropbox` marker file; Dropbox roots don't move. */
const markerCache = new Map<string, boolean>();

function inDropbox(target: string): boolean {
  for (let dir = dirname(target); ; dir = dirname(dir)) {
    let has = markerCache.get(dir);
    if (has === undefined) {
      try {
        has = statSync(join(dir, '.dropbox')).isFile();
      } catch {
        has = false;
      }
      markerCache.set(dir, has);
    }
    if (has) return true;
    if (dirname(dir) === dir) return false;
  }
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Replace the writable roots (from settings). Env roots are always kept. */
export function setWritableRoots(list: string[]): void {
  roots = [...new Set([...fromEnv(), ...list.map(canonical)])];
}

export function writableRoots(): readonly string[] {
  return roots;
}

export function whyNotWritable(target: string): string | null {
  const t = canonical(target);
  if (!roots.some((r) => inside(t, r))) return 'outside the writable roots';
  if (
    process.env.BOOGIE_ALLOW_PROTECTED !== '1' &&
    (PROTECTED.some((p) => inside(t, canonical(p))) || inDropbox(t))
  ) {
    return 'protected location (real libraries are read-only until you allow writes)';
  }
  return null;
}

export function isWritable(target: string): boolean {
  return whyNotWritable(target) === null;
}

export function assertWritable(target: string): void {
  const why = whyNotWritable(target);
  if (why) throw new WriteBlockedError(target, why);
}
