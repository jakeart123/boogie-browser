// Helpers shared by the sync tests only (never imported by app code).
import {
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EagleLibrary, WatchEvents } from '../contracts';
import { assertWritable, setWritableRoots } from '../safety/writeGuard';
import type { ConflictFile } from '../../shared/types';

const PROJECT = fileURLToPath(new URL('../../..', import.meta.url));
export const SCRATCH = join(PROJECT, '.tmp', 'sync');
// The real library copy when it is here, else the generated one committed with the tests.
const REAL = join(PROJECT, 'research/sandbox/templates/sample.library');
const TEMPLATE =
  !process.env.BOOGIE_TEST_FIXTURES && existsSync(REAL)
    ? REAL
    : join(PROJECT, 'test/fixtures/libraries/sample.library');

/** A fresh reflinked copy of the 9-item test library inside .tmp/sync. Returns its root and a cleanup. */
export function makeLibrary(): { root: string; dir: string; cleanup: () => void } {
  mkdirSync(SCRATCH, { recursive: true });
  const dir = mkdtempSync(join(SCRATCH, 'lib-'));
  const root = join(dir, 'lib.library');
  setWritableRoots([SCRATCH]);
  cpSync(TEMPLATE, root, { recursive: true, mode: constants.COPYFILE_FICLONE });
  return { root, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Plays the part of Dropbox / the partner's Eagle: writes into our scratch copy, through the write guard.
 * Default is what Dropbox does (a temp file renamed into place); `atomic: false` writes in place like Eagle.
 */
export function externalWrite(path: string, text: string, opts: { atomic?: boolean } = {}): void {
  assertWritable(path);
  mkdirSync(join(path, '..'), { recursive: true });
  if (opts.atomic === false) return writeFileSync(path, text);
  const tmp = join(
    path,
    '..',
    `.dropbox.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  assertWritable(tmp);
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/**
 * The bit of EagleLibrary the watcher uses. `selfWrites` is the map the adapter would report,
 * `raises` the ids it would say it raised lately.
 */
export function fakeLib(
  root: string,
  selfWrites: Map<string, number> = new Map(),
  raises: string[] = [],
  /** The mtime.json values the adapter says it wrote (leave out: an adapter without raisedValue). */
  values?: Map<string, number>,
): EagleLibrary {
  return {
    root,
    readOnly: false,
    recentSelfWrites: () => selfWrites,
    recentRaises: () => raises,
    ...(values ? { raisedValue: (id: string) => values.get(id) } : {}),
  } as unknown as EagleLibrary;
}

export function collector() {
  const items: { ids: string[]; listDir: boolean }[] = [];
  const conflicts: ConflictFile[][] = [];
  const foreign: {
    at: number;
    raisedByUs: string[];
    previous?: Record<string, number | null>;
    byBoogie?: boolean;
  }[] = [];
  const rootFiles: string[] = [];
  let roots = 0;
  const events: WatchEvents = {
    items: (h) => items.push(h),
    root: () => void roots++,
    conflicts: (f) => conflicts.push(f),
    foreignMtime: (i) => foreign.push(i),
    rootFiles: (w) => rootFiles.push(w),
  };
  return { events, items, conflicts, foreign, rootFiles, roots: () => roots };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function waitFor(pred: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(20);
  }
}
