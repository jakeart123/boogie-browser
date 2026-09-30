// Making a new empty library, and peeking at one without opening it.
import { mkdir, rmdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertWritable } from '../safety/writeGuard';
import { mkdirGuarded, writeFileAtomic } from './atomic';
import { LibraryUnreadableError } from './errors';
import { serialize } from './json';
import { sanitizeFolderName } from './names';
import { BACKUP_DIR, IMAGES_DIR, MTIME_FILE, ROOT_METADATA } from './paths';
import { readRootDoc } from './read';
import { SUPPORTED_APP_VERSION, isSupportedVersion } from './version';

/**
 * Write `<parentDir>/<name>.library` exactly like Eagle's createLibrary: `images/`, then the root
 * metadata.json (applicationVersion FIRST), mtime.json `{}`, tags.json, saved-filters.json,
 * actions.json and `backup/`. No Desktop.ini (Eagle on Windows adds it). Fails if it already exists.
 * Returns the absolute path of the new `.library` folder.
 */
export async function createLibrary(parentDir: string, name: string): Promise<string> {
  const base = sanitizeFolderName(String(name ?? '').replace(/\.library$/i, ''), { maxBytes: 200 });
  const lib = join(resolve(parentDir), `${base}.library`);
  assertWritable(lib);
  try {
    await mkdir(lib); // not recursive: this is also the "already exists" check, and it is atomic
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(`A library named "${base}" already exists in that folder.`);
    throw err;
  }
  const files: string[] = [];
  const dirs: string[] = [lib];
  try {
    await mkdirGuarded(join(lib, IMAGES_DIR));
    dirs.push(join(lib, IMAGES_DIR));
    const put = async (file: string, text: string) => {
      await writeFileAtomic(join(lib, file), text);
      files.push(join(lib, file));
    };
    await put(
      ROOT_METADATA,
      serialize({
        applicationVersion: SUPPORTED_APP_VERSION,
        folders: [],
        smartFolders: [],
        quickAccess: [],
        tagsGroups: [],
        modificationTime: Date.now(),
      }),
    );
    await put(MTIME_FILE, '{}');
    await put('tags.json', serialize({ historyTags: [], starredTags: [] }));
    await put('saved-filters.json', '[]');
    await put('actions.json', '[]');
    await mkdirGuarded(join(lib, BACKUP_DIR));
    dirs.push(join(lib, BACKUP_DIR));
  } catch (err) {
    // Clean up only what this call made, so a retry doesn't hit "already exists".
    for (const f of files.reverse()) await unlink(f).catch(() => {});
    for (const d of dirs.reverse()) await rmdir(d).catch(() => {});
    throw err;
  }
  return lib;
}

/**
 * Inspect a library without opening it: version, and whether we can write it. It never lists the
 * item folders (6 s for Master's 85k on a USB drive, on every open).
 */
export async function probeLibrary(root: string): Promise<{
  ok: boolean;
  applicationVersion: string | null;
  reason: string | null;
}> {
  const path = resolve(root);
  let doc;
  try {
    doc = await readRootDoc(path);
  } catch (err) {
    const missing = err instanceof LibraryUnreadableError && err.reason.includes('missing');
    return {
      ok: false,
      applicationVersion: null,
      reason: missing
        ? 'This folder is not an Eagle library (it has no metadata.json).'
        : "The library's metadata.json can't be read right now. It may still be syncing.",
    };
  }
  const version =
    typeof doc.value.applicationVersion === 'string' ? doc.value.applicationVersion : null;
  if (version === null)
    return {
      ok: false,
      applicationVersion: null,
      reason: 'This library has no version number, so it is not safe to edit.',
    };
  if (!isSupportedVersion(version))
    return {
      ok: false,
      applicationVersion: version,
      reason: `This library was saved by a newer Eagle (${version}).`,
    };
  return { ok: true, applicationVersion: version, reason: null };
}
