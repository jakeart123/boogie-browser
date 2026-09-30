// Every filesystem change inside a library goes through this file, and every function here asks
// the write guard first. Nothing else in src/core/eagle touches the disk for writing.
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, open, rename, rmdir, unlink, utimes } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { assertWritable } from '../safety/writeGuard';

/**
 * Temp name that Eagle's watcher ignores (ends in .tmp), that sync tools skip (~$ prefix, the
 * one Eagle itself uses), that is never Eagle's own `~$metadata.json.tmp`, and that never
 * contains "mtime" (Eagle deletes any root file with that in its name when a library loads).
 */
export function tempNameFor(target: string): string {
  const safe = basename(target)
    .replace(/mtime/gi, 'mt')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 32);
  return `~$${safe}.${randomBytes(4).toString('hex')}.tmp`;
}

async function fsyncDir(dir: string): Promise<void> {
  try {
    const fh = await open(dir, 'r');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    /* best effort: some filesystems can't fsync a directory */
  }
}

/**
 * Write to a temp file in the same folder, fsync, then rename over the target (atomic on Linux).
 * `syncDir` also fsyncs the folder so the rename itself survives a power cut. That doubles the
 * cost of a write, so only the library-level files use it: for an item file the worst case
 * without it is the old, intact file after a crash, which the journal can restore.
 */
export async function writeFileAtomic(
  target: string,
  data: string | Uint8Array,
  opts: { syncDir?: boolean } = {},
): Promise<void> {
  assertWritable(target);
  const dir = dirname(target);
  const temp = join(dir, tempNameFor(target));
  assertWritable(temp);
  let created = false;
  try {
    const fh = await open(temp, 'wx');
    created = true;
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(temp, target);
    created = false;
  } catch (err) {
    if (created) await unlink(temp).catch(() => {});
    throw err;
  }
  if (opts.syncDir) await fsyncDir(dir);
}

export async function mkdirGuarded(dir: string, opts: { recursive?: boolean } = {}): Promise<void> {
  assertWritable(dir);
  await mkdir(dir, opts);
}

export async function renameGuarded(from: string, to: string): Promise<void> {
  assertWritable(from);
  assertWritable(to);
  await rename(from, to);
}

export async function unlinkGuarded(path: string): Promise<void> {
  assertWritable(path);
  await unlink(path);
}

/** Copy that never overwrites and reflinks where the filesystem can (instant on btrfs). */
export async function copyFileGuarded(from: string, to: string): Promise<void> {
  assertWritable(to);
  await copyFile(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
}

/** Set the modification time (and atime) of a file we just created, in whole seconds. */
export async function setTimesGuarded(path: string, ms: number): Promise<void> {
  assertWritable(path);
  const sec = Math.floor(ms / 1000);
  await utimes(path, sec, sec);
}

/**
 * Undo a half-finished createItem: remove ONLY the files we created in the folder we created,
 * then that folder (rmdir fails if anything else is in it, which is what we want).
 */
export async function removeCreatedFolder(dir: string, files: string[]): Promise<void> {
  for (const f of files) await unlinkGuarded(f).catch(() => {});
  assertWritable(dir);
  await rmdir(dir).catch(() => {});
}
