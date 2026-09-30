// Writing the library-level JSON files: the root metadata.json (with Eagle-style backups), and
// the small tags.json / saved-filters.json. Same rules for all: fresh read, never write over a
// file we couldn't parse, journal before/after, atomic write with the folder fsynced.
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { EagleFolderRecord, EagleRootRecord } from '../../shared/types';
import type { ChangeContext, EagleSavedFilter, EagleTagsFile, JournalSink } from '../contracts';
import { assertWritable } from '../safety/writeGuard';
import { unlinkGuarded, writeFileAtomic } from './atomic';
import { LibraryUnreadableError, UnsupportedVersionError } from './errors';
import { isPlainObject, serialize } from './json';
import { BACKUP_DIR, ROOT_METADATA, SAVED_FILTERS_FILE, TAGS_FILE } from './paths';
import { readRootDoc, readSmallJson } from './read';
import { rootStamp } from './stamp';
import { SUPPORTED_APP_VERSION, isSupportedVersion } from './version';

const BACKUPS_KEPT = 100;

/** What these writers need from the open library. */
export interface RootWriteDeps {
  root: string;
  journal: JournalSink;
  retryDelayMs: number;
  /** Runs `fn` with `rels` noted as our own writes (the watcher's echo suppression). */
  marked<T>(rels: string[], fn: () => Promise<T>): Promise<T>;
  onError?: (err: unknown) => void;
}

/** `mutate` runs on a record we already read; an async one would be silently ignored. */
export function checkedMutation(result: unknown): boolean {
  if (result && typeof (result as { then?: unknown }).then === 'function')
    throw new Error('A mutate function must be synchronous.');
  return result !== false;
}

// ───────────────────────── root metadata.json ─────────────────────────

/** Fresh read → version guard → mutate → modificationTime bump → journal → atomic write → backup. */
export async function writeRoot(
  d: RootWriteDeps,
  mutate: (root: EagleRootRecord) => boolean | void,
  ctx: ChangeContext,
): Promise<{ before: string; after: string } | null> {
  const path = join(d.root, ROOT_METADATA);
  assertWritable(path);
  const cur = await readRootDoc(d.root, d.retryDelayMs, true); // throws LibraryUnreadableError rather than writing over a bad file
  const rec = cur.value;
  const version = rec.applicationVersion;
  if (!isSupportedVersion(version))
    throw new UnsupportedVersionError(
      typeof version === 'string' ? version : null,
      SUPPORTED_APP_VERSION,
    );

  const baseline = JSON.stringify(rec);
  const folderBefore = folderOwnSnapshot(rec.folders);
  const prevModified =
    typeof rec.modificationTime === 'number' && Number.isFinite(rec.modificationTime)
      ? rec.modificationTime
      : 0;
  if (!checkedMutation(mutate(rec))) return null;
  if (JSON.stringify(rec) === baseline) return null;
  if (rec.applicationVersion !== version)
    throw new Error('A root change must never touch applicationVersion.');

  stripRuntimeFolderKeys(rec.folders, folderBefore);
  // Backdated and marked like item values, so items written after it stay newer (stamp.ts).
  rec.modificationTime = rootStamp(Date.now(), prevModified);
  const after = serialize(rec);
  d.journal.recordFile(ctx.group, {
    relPath: ROOT_METADATA,
    before: cur.text,
    after,
    itemId: null,
  });
  await d.marked([ROOT_METADATA], () => writeFileAtomic(path, after, { syncDir: true }));
  // The change is on disk; a failed safety copy must not make the caller think it wasn't.
  await backupRoot(d, after).catch((err) => d.onError?.(err));
  return { before: cur.text, after };
}

/** Eagle-style backup: a copy of the new root file, only if its size differs from the newest one, newest 100 kept. */
async function backupRoot(d: RootWriteDeps, text: string): Promise<void> {
  const dir = join(d.root, BACKUP_DIR);
  assertWritable(dir);
  await mkdir(dir, { recursive: true });
  const list = async () => (await readdir(dir)).filter((n) => /^backup-.*\.json$/.test(n)).sort();
  const names = await list();
  const newest = names[names.length - 1];
  if (newest && (await stat(join(dir, newest))).size === Buffer.byteLength(text)) return;
  const name = `backup-${backupStamp(new Date())}.json`;
  if (names.includes(name)) return;
  await d.marked([`${BACKUP_DIR}/${name}`], () => writeFileAtomic(join(dir, name), text));
  // Only backup-*.json, oldest by name first, and never the one we just made (clocks differ between machines).
  const others = (await list()).filter((n) => n !== name);
  for (const old of others.slice(0, Math.max(0, others.length + 1 - BACKUPS_KEPT)))
    await unlinkGuarded(join(dir, old)).catch(() => {});
}

// ───────────────────────── tags.json, saved-filters.json ─────────────────────────

/** How one small root file is shaped, and what Eagle creates when it is missing. */
export interface SmallJsonKind<T> {
  file: string;
  shape: (v: unknown) => boolean;
  empty: () => T;
  /** Fill in parts the mutate function may rely on (tags.json's two arrays). */
  normalize?: (v: T) => void;
}

export const TAGS_KIND: SmallJsonKind<EagleTagsFile> = {
  file: TAGS_FILE,
  shape: isPlainObject,
  empty: () => ({ historyTags: [], starredTags: [] }),
  normalize: (v) => {
    if (!Array.isArray(v.historyTags)) v.historyTags = [];
    if (!Array.isArray(v.starredTags)) v.starredTags = [];
  },
};

export const SAVED_FILTERS_KIND: SmallJsonKind<EagleSavedFilter[]> = {
  file: SAVED_FILTERS_FILE,
  shape: Array.isArray,
  empty: () => [],
};

/** null when the file is missing. Blank reads as Eagle's empty value; unparseable throws. */
export async function readSmall<T>(
  d: Pick<RootWriteDeps, 'root' | 'retryDelayMs'>,
  kind: SmallJsonKind<T>,
): Promise<{ value: T; text: string } | null> {
  const r = await readSmallJson<T>(d.root, kind.file, kind.shape, d.retryDelayMs);
  if (r.status === 'ok') return r.doc;
  if (r.status === 'missing') return null;
  if (r.status === 'blank') return { value: kind.empty(), text: '' };
  throw new LibraryUnreadableError(join(d.root, kind.file), r.reason);
}

/** Fresh read → mutate → journal → atomic write. A missing or blank file starts from `kind.empty()`. */
export async function writeSmall<T>(
  d: RootWriteDeps,
  kind: SmallJsonKind<T>,
  mutate: (v: T) => boolean | void,
  ctx: ChangeContext,
): Promise<{ before: string | null; after: string } | null> {
  const path = join(d.root, kind.file);
  assertWritable(path);
  const cur = await readSmall(d, kind);
  const value = cur?.value ?? kind.empty();
  kind.normalize?.(value);
  const baseline = JSON.stringify(value);
  if (!checkedMutation(mutate(value))) return null;
  const after = serialize(value);
  if (after === baseline) return null;
  const before = cur?.text || null; // a blank file had nothing worth keeping
  d.journal.recordFile(ctx.group, { relPath: kind.file, before, after, itemId: null });
  await d.marked([kind.file], () => writeFileAtomic(path, after, { syncDir: true }));
  return { before, after };
}

// ───────────────────────── pure helpers ─────────────────────────

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** The local-time stamp in Eagle's backup file names: `YYYY-MM-DD HH.mm.ss.SSS`. */
export function backupStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Folder fields without the subtree, to tell which folder records a mutation really changed. */
const ownJson = (f: EagleFolderRecord) =>
  JSON.stringify(f, (k, v) => (k === 'children' ? undefined : v));

export function folderOwnSnapshot(
  folders: unknown,
  into = new Map<string, string>(),
): Map<string, string> {
  if (!Array.isArray(folders)) return into;
  for (const f of folders as EagleFolderRecord[]) {
    if (!isPlainObject(f)) continue;
    into.set(String(f.id), ownJson(f));
    folderOwnSnapshot(f.children, into);
  }
  return into;
}

/** Eagle never writes these three; drop them from the records we changed (and only those). */
export function stripRuntimeFolderKeys(folders: unknown, before: Map<string, string>): void {
  if (!Array.isArray(folders)) return;
  for (const f of folders as EagleFolderRecord[]) {
    if (!isPlainObject(f)) continue;
    if (before.get(String(f.id)) !== ownJson(f)) {
      delete f.extendTags;
      delete f.pinyin;
      delete f.isExpand;
    }
    stripRuntimeFolderKeys(f.children, before);
  }
}
