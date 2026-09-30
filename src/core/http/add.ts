// Turning "add this" requests (v1, v2 and the extension port) into imports on the core. Every add
// is attributed to the caller and uses a non-interactive duplicate rule. It runs as an import
// job; only routes that must return ids wait for it (see settle()). A request that adds several
// things is ONE job and ONE history entry (CoreApi.importBatch).
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImportEntry, ImportOptions, ImportResult } from '../../shared/types';
import type { Ctx, Req } from './context';
import { needLibrary, remember, writer } from './context';
import { indexFolders } from './shapes';
import type { Args } from './util';
import { HttpError, cleanName, compact, list, num, stars, str, tagList } from './util';

/** One item's worth of add fields, cleaned. */
export interface AddSpec {
  name?: string;
  /** The page the file came from (Eagle stores the PAGE url, not the image url). */
  website?: string;
  annotation?: string;
  star?: number;
  tags: string[];
  modificationTime?: number;
  headers?: Record<string, string>;
}

/** What an add started: an import job to wait on, or a result that is already in. */
export interface Started {
  jobId?: string;
  result?: ImportResult;
}

export function readSpec(a: Args): AddSpec {
  const headers =
    a.headers && typeof a.headers === 'object' && !Array.isArray(a.headers) ? a.headers : undefined;
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) if (typeof v === 'string') clean[k] = v;
  const mt = num(a.modificationTime);
  return {
    name: cleanName(a.name),
    website: str(a.website),
    annotation: typeof a.annotation === 'string' ? a.annotation : undefined,
    star: stars(a.star),
    tags: tagList(a.tags),
    modificationTime: mt !== undefined && mt > 0 ? Math.trunc(mt) : undefined,
    headers: Object.keys(clean).length ? clean : undefined,
  };
}

/** Folder ids a request names (`folderId`/`folderID` and `folderIds`/`folderIDs`), keeping only
 * folders that exist, like Eagle does. Asking for none costs no library read. */
export async function pickFolders(ctx: Ctx, ...sources: Args[]): Promise<string[]> {
  const asked: string[] = [];
  for (const a of sources) {
    for (const v of [a.folderId, a.folderID]) {
      const s = str(v);
      if (s && !asked.includes(s)) asked.push(s);
    }
    for (const s of [...list(a.folderIds), ...list(a.folderIDs)])
      if (!asked.includes(s)) asked.push(s);
  }
  if (!asked.length) return [];
  const known = indexFolders((await needLibrary(ctx)).folders);
  return asked.filter((id) => known.has(id));
}

/** The core's options for one add: the first folder is the target, the rest are extra folders. */
function importOpts(spec: AddSpec, folders: string[]): ImportOptions {
  return compact({
    folderId: folders[0],
    folderIds: folders.length > 1 ? folders.slice(1) : undefined,
    name: spec.name,
    tags: spec.tags.length ? spec.tags : undefined,
    star: spec.star,
    annotation: spec.annotation,
    url: spec.website,
    modificationTime: spec.modificationTime,
    // The UI can't answer a prompt for an API call, and Eagle's API always adds.
    onDuplicate: 'keep-both' as const,
  });
}

// ───────────────────────── validating one source ─────────────────────────
// Each builder checks its source and throws a 400 before anything starts, so a batch with one bad
// entry adds nothing.

const URL_SCHEMES = new Set(['http:', 'https:', 'data:', 'file:']);

/** Throws 400 unless this is a URL we accept as a source. */
export function checkSourceUrl(url: string): URL {
  // A data: URL can be megabytes; its scheme is all that needs checking.
  if (/^data:/i.test(url)) return new URL('data:,');
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new HttpError(400, 'Invalid url.');
  }
  if (!URL_SCHEMES.has(u.protocol))
    throw new HttpError(400, `Unsupported url scheme ${u.protocol}`);
  return u;
}

const NO_LOCAL_FILES = 'The browser extension cannot add files from this computer.';

/** A file (never a folder) on this computer, by absolute path. Refused for the browser extension:
 * what it sends comes from web pages, and a page must never pull files off this computer. */
export async function checkFile(r: Req, path: string): Promise<void> {
  if (r.fromExtension) throw new HttpError(400, NO_LOCAL_FILES);
  if (!isAbsolute(path)) throw new HttpError(400, 'The path must be absolute.');
  const st = await stat(path).catch(() => null);
  if (!st) throw new HttpError(400, 'File does not exist.');
  if (st.isDirectory()) throw new HttpError(400, 'A folder cannot be added, only files.');
}

export async function pathEntry(
  r: Req,
  path: string,
  spec: AddSpec,
  folders: string[],
): Promise<ImportEntry> {
  await checkFile(r, path);
  return { path, opts: importOpts(spec, folders) };
}

/** An image address. Eagle reads file: URLs too, as a path import (never for the extension). */
export async function urlEntry(
  r: Req,
  url: string,
  spec: AddSpec,
  folders: string[],
): Promise<ImportEntry> {
  const u = checkSourceUrl(url);
  if (u.protocol === 'file:') {
    if (r.fromExtension) throw new HttpError(400, NO_LOCAL_FILES);
    if (u.host !== '' && u.host !== 'localhost') throw new HttpError(400, 'Invalid file url.');
    return pathEntry(r, fileURLToPath(u), spec, folders);
  }
  // The page is the natural Referer for an image on it; Eagle sends it when headers are given.
  return compact({
    url,
    referer: spec.website,
    headers: spec.headers,
    opts: importOpts(spec, folders),
  });
}

export function bytesEntry(
  bytes: Uint8Array,
  fileName: string,
  spec: AddSpec,
  folders: string[],
): ImportEntry {
  return { bytes, fileName, opts: importOpts(spec, folders) };
}

export function bookmarkEntry(
  url: string,
  title: string,
  spec: AddSpec,
  folders: string[],
  thumbnail?: Uint8Array,
): ImportEntry {
  checkSourceUrl(url);
  return compact({
    bookmark: url,
    title,
    thumbnailPng: thumbnail,
    opts: importOpts(spec, folders),
  });
}

// ───────────────────────── starting and waiting ─────────────────────────

/** Start checked entries: one through the matching import, several as ONE batch job. */
export async function startAdd(ctx: Ctx, r: Req, entries: ImportEntry[]): Promise<Started> {
  const w = writer(ctx, r);
  const job = (p: Promise<{ jobId: string }>): Promise<Started> =>
    p.then(({ jobId }) => ({ jobId }));
  let started: Started;
  if (entries.length > 1) {
    if (!w.importBatch) throw new HttpError(501, 'Adding several items at once is not supported.');
    started = await job(w.importBatch(entries));
  } else {
    const e = entries[0];
    const o = e.opts ?? {};
    if (e.path) started = await job(w.importPaths([e.path], o));
    else if (e.url)
      started = await job(
        w.importUrl(e.url, compact({ ...o, referer: e.referer, headers: e.headers })),
      );
    else if (e.bytes) started = { result: await w.importBytes(e.bytes, e.fileName ?? 'image', o) };
    else if (e.bookmark) {
      const opts = compact({ ...o, thumbnailPng: e.thumbnailPng });
      started = { result: await w.importBookmark(e.bookmark, e.title ?? e.bookmark, opts) };
    } else throw new HttpError(400, 'Nothing to add.');
    if (started.result) failIfNothing(started.result);
  }
  for (const e of entries) {
    const o = e.opts ?? {};
    remember(
      ctx.recentFolders,
      [o.folderId, ...(o.folderIds ?? [])].filter((f) => !!f) as string[],
    );
    remember(ctx.recentTags, o.tags ?? [], 32);
  }
  return started;
}

function failIfNothing(res: Partial<ImportResult>): void {
  if (!res.added?.length && res.failed?.length) throw new HttpError(500, res.failed[0].reason);
}

/** Wait for what an add started and return the item each entry became (null = none). Waits for
 * the whole import (up to ctx.jobWaitMs, 10 minutes), because scripts add and then tag by id. */
export async function settle(ctx: Ctx, s: Started): Promise<(string | null)[] | null> {
  let res = s.result;
  if (!res) {
    if (!s.jobId) return null;
    const job = await ctx.jobs.wait(s.jobId, ctx.jobWaitMs);
    if (job === 'running') {
      const minutes = Math.max(1, Math.round(ctx.jobWaitMs / 60_000));
      throw new HttpError(
        500,
        `Still importing after ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}, so the new item ids can't be returned. The files will appear in the library when the import is done.`,
      );
    }
    if (!job) return null;
    if (job.state === 'failed') throw new HttpError(500, job.error ?? 'Import failed.');
    if (job.state === 'cancelled') throw new HttpError(500, 'Import was cancelled.');
    res = job.result as ImportResult | undefined;
    if (!res) return null;
  }
  if (res.entryIds) {
    // A batch where nothing landed (the library turned read-only, every download failed) is an error.
    if (res.entryIds.length && res.entryIds.every((id) => id === null)) failIfNothing(res);
    return res.entryIds;
  }
  failIfNothing(res);
  return [res.added?.[0] ?? res.duplicates?.[0]?.existingId ?? null];
}

// ───────────────────────── data URLs ─────────────────────────

/** Bytes and a file extension from a data URL or bare base64 (screenshots from the extension). */
export function decodeImageData(data: string, fallbackExt = 'png'): { bytes: Buffer; ext: string } {
  const m = /^data:([^;,]*)(?:;[^,]*)?;base64,(.*)$/is.exec(data.trim());
  const b64 = m ? m[2] : data.trim();
  const mime = (m?.[1] ?? '').toLowerCase();
  const ext =
    mime === 'image/jpeg'
      ? 'jpg'
      : mime === 'image/webp'
        ? 'webp'
        : mime === 'image/png'
          ? 'png'
          : fallbackExt;
  const bytes = Buffer.from(b64, 'base64');
  if (!bytes.length) throw new HttpError(400, 'The image data is empty.');
  return { bytes, ext };
}
