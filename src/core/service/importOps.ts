// Import as background jobs (files, links, pasted bytes, bookmarks, API batches), each one
// history group. The duplicate finder is dupeOps.ts.
import type { Actor, ImportEntry, ImportOptions, ImportResult } from '../../shared/types';
import type { ChangeContext } from '../contracts';
import { ensureWritable, runGroup } from './group';
import { itemsText, quoted } from './labels';
import type { Session, Touch } from './types';
import { errorMessage, mapLimit, plural } from './util';

// ───────────────────────── import ─────────────────────────

/** Ask about duplicates unless the caller already decided. */
const withDefaults = <T extends ImportOptions>(opts: T): T => ({
  ...opts,
  onDuplicate: opts.onDuplicate ?? 'ask',
});

/** The options a job shows (so a retry can reuse them): never request headers, which may hold cookies. */
function retryOptions(
  opts: ImportOptions & { referer?: string; headers?: Record<string, string> },
): ImportOptions {
  const { referer: _referer, headers: _headers, ...rest } = opts;
  return rest;
}

function importLabel(s: Session, n: number, folderId: string | null | undefined): string {
  const folder = folderId ? s.env.deps.helpers.tree.findFolder(s.root, folderId)?.name : undefined;
  return `Imported ${itemsText(n)}${folder ? ` into ${quoted(folder)}` : ''}`;
}

/** The importer may have created folders (keepFolderStructure): pick up the new root if so. */
async function adoptRootIfChanged(s: Session, t: Touch): Promise<void> {
  try {
    const disk = (await s.lib.readRoot()).value;
    if (disk.modificationTime !== s.root.modificationTime) {
      s.root = disk;
      s.index.setRoot(disk);
      t.root = true;
    }
  } catch {
    /* unreadable right now: the watcher will notice a real change */
  }
}

/** Gives the importer a signal and a progress callback for one job. */
interface ImportRun {
  signal: AbortSignal;
  progress(done: number, total: number): void;
}

/**
 * One import as a job with one history group. Not locked: an import can take minutes. It stops
 * between files when the job is cancelled, the library closes, or the library turns read-only
 * (Eagle opened it on this computer).
 */
function launchImport(
  s: Session,
  actor: Actor,
  label: string,
  opts: ImportOptions,
  work: (ctx: ChangeContext, run: ImportRun) => Promise<ImportResult>,
  jobOptions?: ImportOptions,
): { jobId: string; result: Promise<ImportResult> } {
  ensureWritable(s);
  return s.env.jobs.launch(
    'import',
    label,
    async (h) => {
      const stop = new AbortController();
      const run: ImportRun = {
        signal: AbortSignal.any([h.signal, stop.signal]),
        progress(done, total) {
          if (s.closed || s.readOnly) stop.abort();
          h.progress(done, total);
        },
      };
      let result: ImportResult = { added: [], duplicates: [], failed: [] };
      const { entry } = await runGroup(
        s,
        actor,
        'Imported items',
        'import',
        async (ctx, t) => {
          try {
            result = await work(ctx, run);
          } catch (e) {
            // Some items may have been created before it failed: find them so the UI shows them.
            const delta = await s.index.refresh(s.lib, { listDir: true }).catch(() => null);
            for (const id of delta?.added ?? []) t.added.add(id);
            throw e;
          }
          for (const id of result.added) t.added.add(id);
          // "use-existing" edits items that were already there: they changed rather than appeared.
          if (opts.onDuplicate === 'use-existing') for (const id of result.added) t.changed.add(id);
          t.label = importLabel(s, result.added.length, opts.folderId);
          await adoptRootIfChanged(s, t);
        },
        { lock: false },
      );
      result.groupId = entry?.groupId ?? null;
      return result;
    },
    { scope: s.ref.id, options: jobOptions },
  );
}

/** What the API hands back for a job (the result arrives with the job's progress). */
const jobOnly = (j: { jobId: string }): { jobId: string } => ({ jobId: j.jobId });

export function importPaths(
  s: Session,
  actor: Actor,
  paths: string[],
  opts: ImportOptions = {},
): { jobId: string } {
  const o = withDefaults(opts);
  return jobOnly(
    launchImport(
      s,
      actor,
      `Importing ${plural(paths.length, 'file')}`,
      o,
      (ctx, run) =>
        s.importer.importPaths(paths, o, ctx, (p) => run.progress(p.done, p.total), run.signal),
      o,
    ),
  );
}

export function importUrl(
  s: Session,
  actor: Actor,
  url: string,
  opts: ImportOptions & { referer?: string; headers?: Record<string, string> } = {},
): { jobId: string } {
  const o = withDefaults(opts);
  return jobOnly(
    launchImport(
      s,
      actor,
      'Importing from a link',
      o,
      async (ctx, run) => {
        run.progress(0, 1);
        return s.importer.importUrl(url, o, ctx, run.signal);
      },
      retryOptions(o),
    ),
  );
}

/** A paste or a browser drop: a short job (so closing the library waits for it), result returned. */
export function importBytes(
  s: Session,
  actor: Actor,
  bytes: Uint8Array,
  fileName: string,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const o = withDefaults(opts);
  return launchImport(
    s,
    actor,
    `Importing ${fileName ? quoted(fileName) : 'a pasted file'}`,
    o,
    (ctx) => s.importer.importBytes(bytes, fileName, o, ctx),
  ).result;
}

export function importBookmark(
  s: Session,
  actor: Actor,
  url: string,
  title: string,
  opts: ImportOptions & { thumbnailPng?: Uint8Array } = {},
): Promise<ImportResult> {
  const o = withDefaults(opts);
  return launchImport(s, actor, 'Saving a bookmark', o, (ctx) =>
    s.importer.importBookmark(url, title, o, ctx),
  ).result;
}

/** Entries of an API batch in flight at once (like Phase 1's per-entry jobs, but one job). */
const BATCH_WORKERS = 6;

/** "into Hands" when every entry of a batch goes to the same folder. */
function batchFolder(entries: ImportEntry[]): string | null | undefined {
  const first = entries[0]?.opts?.folderId ?? null;
  return entries.every((e) => (e.opts?.folderId ?? null) === first) ? first : undefined;
}

/**
 * Eagle API batch adds: every entry in one job and one history group, each with its own options.
 * A few run at once (a batch of 150 used to take 20 s one by one, past the API's wait for ids),
 * and `entryIds[i]` is always entry i's item.
 */
export function importBatch(s: Session, actor: Actor, entries: ImportEntry[]): { jobId: string } {
  if (!entries.length) throw new Error('Nothing to import.');
  const all: ImportOptions = { onDuplicate: 'ask', folderId: batchFolder(entries) };
  return jobOnly(
    launchImport(s, actor, `Importing ${itemsText(entries.length)}`, all, async (ctx, run) => {
      const results = new Array<ImportResult | null>(entries.length).fill(null);
      const skipped: string[] = [];
      // "Date added" in entry order (now + index, like Eagle), whichever entry finishes first.
      const base = Date.now();
      let done = 0;
      await mapLimit(entries, BATCH_WORKERS, async (e, i) => {
        const source = e.path ?? e.url ?? e.bookmark ?? e.fileName ?? `entry ${i + 1}`;
        if (run.signal.aborted) {
          skipped.push(source);
          return;
        }
        const stamped = { ...e, opts: { modificationTime: base + i, ...e.opts } };
        results[i] = await importEntry(s, stamped, source, ctx, run.signal);
        run.progress(++done, entries.length);
      });
      const total: ImportResult = { added: [], duplicates: [], failed: [], entryIds: [] };
      for (const r of results) {
        total.added.push(...(r?.added ?? []));
        total.duplicates.push(...(r?.duplicates ?? []));
        total.failed.push(...(r?.failed ?? []));
        if (r?.warnings) (total.warnings ??= []).push(...r.warnings);
        total.entryIds!.push(r ? (r.added[0] ?? r.duplicates[0]?.existingId ?? null) : null);
      }
      if (skipped.length) total.skipped = skipped;
      return total;
    }),
  );
}

/** One batch entry through the importer. Never throws: a failure is that entry's result. */
async function importEntry(
  s: Session,
  e: ImportEntry,
  source: string,
  ctx: ChangeContext,
  signal: AbortSignal,
): Promise<ImportResult> {
  const o = withDefaults(e.opts ?? {});
  try {
    if (e.path !== undefined)
      return await s.importer.importPaths([e.path], o, ctx, undefined, signal);
    if (e.url !== undefined)
      return await s.importer.importUrl(
        e.url,
        { ...o, referer: e.referer, headers: e.headers },
        ctx,
        signal,
      );
    if (e.bytes !== undefined)
      return await s.importer.importBytes(e.bytes, e.fileName ?? '', o, ctx);
    if (e.bookmark !== undefined)
      return await s.importer.importBookmark(
        e.bookmark,
        e.title ?? '',
        { ...o, thumbnailPng: e.thumbnailPng },
        ctx,
      );
    return { added: [], duplicates: [], failed: [{ source, reason: 'Nothing to import.' }] };
  } catch (err) {
    return { added: [], duplicates: [], failed: [{ source, reason: errorMessage(err) }] };
  }
}
