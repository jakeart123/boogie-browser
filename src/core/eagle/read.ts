// Tolerant readers (format-spec 19.7). Reading never repairs anything and never writes.
import { isUtf8 } from 'node:buffer';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Doc } from '../contracts';
import type { EagleItemRecord, EagleRootRecord } from '../../shared/types';
import { LibraryUnreadableError } from './errors';
import { isItemId } from './ids';
import { isBlankOrNul, isPlainObject, parseJson } from './json';
import { MTIME_FILE, ROOT_METADATA, childPath, imagesDir, itemDir, metadataPath } from './paths';

/** Eagle and Dropbox both write non-atomically, so a parse failure may just be mid-write. */
export const RETRY_DELAY_MS = 500;
const ROOT_TRIES = 5; // over about 2 s
const ITEM_TRIES = 3; // over about 1 s

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * File text as UTF-8. With `strict`, bytes that are not valid UTF-8 are reported instead of being
 * silently turned into U+FFFD, because a write would then bake that damage into the file.
 */
async function readText(
  path: string,
  strict: boolean,
): Promise<{ text: string; badUtf8: boolean }> {
  const buf = await readFile(path);
  const text = buf.toString('utf8');
  return { text, badUtf8: strict && text.includes('\ufffd') && !isUtf8(buf) };
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

// ───────────────────────── root metadata.json ─────────────────────────

export async function readRootDoc(
  root: string,
  delayMs = RETRY_DELAY_MS,
  strict = false,
): Promise<Doc<EagleRootRecord>> {
  const path = join(root, ROOT_METADATA);
  let reason = 'unknown';
  for (let attempt = 0; attempt < ROOT_TRIES; attempt++) {
    if (attempt > 0) await sleep(delayMs);
    let text: string;
    try {
      const r = await readText(path, strict);
      if (r.badUtf8) throw new LibraryUnreadableError(path, 'not valid UTF-8');
      text = r.text;
    } catch (err) {
      if (isMissing(err)) throw new LibraryUnreadableError(path, 'metadata.json is missing');
      throw err;
    }
    try {
      const value = parseJson<unknown>(text);
      if (isPlainObject(value)) return { value: value as EagleRootRecord, text };
      reason = 'not a JSON object';
    } catch (err) {
      reason = isBlankOrNul(text) ? 'empty or zero-filled' : (err as Error).message;
    }
  }
  throw new LibraryUnreadableError(path, reason);
}

// ───────────────────────── items ─────────────────────────

export type ItemRead =
  | { status: 'ok'; doc: Doc<EagleItemRecord> }
  | { status: 'missing' }
  | { status: 'blank' } // empty or all-NUL: 380 such files exist in the Art library
  | { status: 'corrupt'; reason: string };

export async function readItemFile(
  root: string,
  id: string,
  delayMs = RETRY_DELAY_MS,
  strict = false,
): Promise<ItemRead> {
  if (!isItemId(id)) return { status: 'missing' };
  const path = metadataPath(root, id);
  let reason = 'unknown';
  for (let attempt = 0; attempt < ITEM_TRIES; attempt++) {
    if (attempt > 0) await sleep(delayMs);
    let text: string;
    try {
      const r = await readText(path, strict);
      if (r.badUtf8) return { status: 'corrupt', reason: 'not valid UTF-8' };
      text = r.text;
    } catch (err) {
      if (isMissing(err)) return { status: 'missing' };
      throw err;
    }
    try {
      const value = parseJson<unknown>(text);
      if (isPlainObject(value))
        return { status: 'ok', doc: { value: value as EagleItemRecord, text } };
      reason = 'not a JSON object';
    } catch (err) {
      // Blank and zero-filled files are permanent damage, not a write in progress: don't wait on them.
      if (isBlankOrNul(text)) return { status: 'blank' };
      reason = (err as Error).message;
    }
  }
  return { status: 'corrupt', reason };
}

/** `readdir(images)`: entries named `<id>.info` with a 13- or 36-char id. Everything else is ignored. */
export async function listItemIds(root: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(imagesDir(root));
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  const ids: string[] = [];
  for (const n of names) {
    if (!n.endsWith('.info')) continue;
    const id = n.slice(0, -5);
    if (isItemId(id)) ids.push(id);
  }
  return ids;
}

// ───────────────────────── mtime.json ─────────────────────────

export type MtimeRead =
  | { status: 'ok'; text: string; value: Record<string, unknown>; map: Record<string, number> }
  | { status: 'missing' }
  | { status: 'blank'; text: string } // empty or all-NUL: nothing in it to lose
  | { status: 'corrupt'; text: string; reason: string }; // has content we can't parse: never write over it

/**
 * `mtime.json`, with its status. Eagle treats a missing, empty or unparseable file as `{}` when it
 * reads, but a writer must tell them apart: content that won't parse may be mid-write (Eagle's
 * copy-then-delete move, a Dropbox download), so `retries` re-reads it before giving up.
 */
export async function readMtimeDoc(root: string, retries = 0, delayMs = 300): Promise<MtimeRead> {
  let last: MtimeRead = { status: 'missing' };
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(delayMs);
    let text: string;
    try {
      text = await readFile(join(root, MTIME_FILE), 'utf8');
    } catch (err) {
      if (isMissing(err)) return { status: 'missing' };
      throw err;
    }
    try {
      const value = parseJson<unknown>(text);
      if (!isPlainObject(value)) {
        last = { status: 'corrupt', text, reason: 'not a JSON object' };
        continue;
      }
      const map: Record<string, number> = {};
      for (const [k, v] of Object.entries(value))
        if (typeof v === 'number' && Number.isFinite(v)) map[k] = v;
      return { status: 'ok', text, value, map };
    } catch (err) {
      last = isBlankOrNul(text)
        ? { status: 'blank', text }
        : { status: 'corrupt', text, reason: (err as Error).message };
    }
  }
  return last;
}

// ───────────────────────── tags.json, saved-filters.json ─────────────────────────

export type SmallJsonRead<T> =
  | { status: 'ok'; doc: Doc<T> }
  | { status: 'missing' }
  | { status: 'blank' }
  | { status: 'corrupt'; reason: string };

/**
 * One of the small JSON files at the library root that Eagle writes atomically (tags.json,
 * saved-filters.json). `shape` says whether a parsed value is the kind of JSON the file holds.
 */
export async function readSmallJson<T>(
  root: string,
  file: string,
  shape: (v: unknown) => boolean,
  delayMs = RETRY_DELAY_MS,
): Promise<SmallJsonRead<T>> {
  let reason = 'unknown';
  for (let attempt = 0; attempt < ITEM_TRIES; attempt++) {
    if (attempt > 0) await sleep(delayMs);
    let text: string;
    try {
      const r = await readText(join(root, file), true);
      if (r.badUtf8) return { status: 'corrupt', reason: 'not valid UTF-8' };
      text = r.text;
    } catch (err) {
      if (isMissing(err)) return { status: 'missing' };
      throw err;
    }
    try {
      const value = parseJson<unknown>(text);
      if (shape(value)) return { status: 'ok', doc: { value: value as T, text } };
      reason = 'not the expected kind of JSON';
    } catch (err) {
      if (isBlankOrNul(text)) return { status: 'blank' };
      reason = (err as Error).message;
    }
  }
  return { status: 'corrupt', reason };
}

// ───────────────────────── finding the files inside an item folder ─────────────────────────

/**
 * Dropbox's marker on a conflicted copy: "x (Sam's conflicted copy 2026-05-25).json",
 * "x (conflicted copy 2026-05-25 (2)).json", "x (conflicted copy 2026-05-25) (2).json", and the
 * case-only clash "x (Case Conflict).jpg" / "x (Case Conflict 1).jpg". The one pattern used everywhere.
 */
const CONFLICT_MARKER =
  /\s?\((?:[^()]*?conflicted copy[^()]*?(?: \(\d+\))?|case conflict(?: \d+)?)\)(?: \(\d+\))?/i;
const SKIP_NAMES = new Set(['metadata.json', '.ds_store', 'desktop.ini', 'thumbs.db']);

/** If `fileName` is a Dropbox conflicted copy, the name it is a copy of; otherwise null. */
export function conflictedCopyBase(fileName: string): string | null {
  const m = CONFLICT_MARKER.exec(fileName);
  return m ? fileName.slice(0, m.index) + fileName.slice(m.index + m[0].length) : null;
}

export function isConflictedCopy(fileName: string): boolean {
  return CONFLICT_MARKER.test(fileName);
}

/** NFC + trim: how a record name is compared with a file name on disk (25 NFD names, 24 leading spaces). */
const norm = (s: string) => s.normalize('NFC').trim();

function isOriginalCandidate(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return (
    !SKIP_NAMES.has(lower) &&
    !lower.endsWith('_thumbnail.png') &&
    !lower.endsWith('.bk') &&
    !lower.endsWith('.tmp') &&
    !fileName.startsWith('~$') &&
    !isConflictedCopy(fileName)
  );
}

async function safeChild(dir: string, fileName: string): Promise<string | null> {
  try {
    const p = childPath(dir, fileName);
    return (await pathExists(p)) ? p : null;
  } catch {
    return null; // a name with a slash in it can never be a file in this folder
  }
}

/** The original file: `<name>.<ext>`, else a name/ext match ignoring NFC/NFD, spaces and ext case, else the only candidate. */
export async function findOriginal(
  root: string,
  id: string,
  rec: Pick<EagleItemRecord, 'name' | 'ext'>,
): Promise<string | null> {
  const dir = itemDir(root, id);
  const exact = await safeChild(dir, `${rec.name}.${rec.ext}`);
  if (exact) return exact;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const candidates = entries.filter(isOriginalCandidate);
  const wantExt = String(rec.ext ?? '').toLowerCase();
  const wantBase = norm(String(rec.name ?? ''));
  for (const e of candidates) {
    const dot = e.lastIndexOf('.');
    if (dot < 0 || e.slice(dot + 1).toLowerCase() !== wantExt) continue;
    if (norm(e.slice(0, dot)) === wantBase) return join(dir, e);
  }
  return candidates.length === 1 ? join(dir, candidates[0]) : null;
}

/** `<name>_thumbnail.png`, else the best other `*_thumbnail.png` (content may be WebP, JPEG or PNG). */
export async function findThumbnail(
  root: string,
  id: string,
  rec: Pick<EagleItemRecord, 'name'>,
): Promise<string | null> {
  const dir = itemDir(root, id);
  const exact = await safeChild(dir, `${rec.name}_thumbnail.png`);
  if (exact) return exact;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const thumbs = entries
    .filter((e) => e.endsWith('_thumbnail.png') && !e.startsWith('~$') && !isConflictedCopy(e))
    .sort();
  if (thumbs.length === 0) return null;
  const wantBase = norm(String(rec.name ?? ''));
  const match = thumbs.find((e) => norm(e.slice(0, -'_thumbnail.png'.length)) === wantBase);
  return join(dir, match ?? thumbs[0]);
}
