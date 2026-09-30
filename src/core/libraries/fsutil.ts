// Small helpers for Boogie's own config files (settings.json, libraries.json).
// These are NOT library files: nothing in here may be used to write inside a .library folder.
import { randomBytes } from 'node:crypto';
import { access, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Atomic write: temp file in the same folder, fsync, rename. */
export async function writeFileAtomic(file: string, text: string, mode = 0o644): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const fh = await open(tmp, 'w', mode);
    try {
      await fh.writeFile(text);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** Parsed JSON, or undefined when the file is missing or not valid JSON. */
export async function readJsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
