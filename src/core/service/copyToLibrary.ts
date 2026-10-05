// "Add to other library": copy items (their files and metadata) into another library, as new items
// with new ids, through that library's own Eagle adapter (so its write guard and Eagle's write
// rules apply). Items whose file is already in the target (same bytes) are skipped. The copies are
// one history group in the TARGET library's history, so undo there trashes them.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Actor,
  EagleItemRecord,
  EagleRootRecord,
  FolderNode,
  ImportResult,
  LibraryRef,
} from '../../shared/types';
import type { ChangeContext, EagleLibrary, LibraryIndex, NewItemInit } from '../contracts';
import { wholeSecond } from '../eagle/newItem';
import { findExisting, sameSizeAndType, saveHash } from '../import/ingest';
import { pathExists } from '../libraries/fsutil';
import { libraryRef } from '../libraryId';
import { runGroup } from './group';
import type { JobHandle } from './jobs';
import { itemsText, quoted } from './labels';
import { decideReadOnly, openIndex, versionReason } from './session';
import { syncOtherIndex } from './otherLibrary';
import { cleanIds } from './skips';
import { folderNode } from './state';
import type { Session } from './types';
import { errorMessage } from './util';

/** Keys the new record gets from createItem itself, or that only mean something in this library. */
const NOT_COPIED = new Set([
  'id',
  'name',
  'size',
  'btime',
  'mtime',
  'ext',
  'tags',
  'folders',
  'isDeleted',
  'deletedTime',
  'url',
  'annotation',
  'modificationTime',
  'star',
  'width',
  'height',
  'duration',
  'noThumbnail',
  'noPreview',
  'processingPalette',
  'lastModified',
  'palettes',
  'order', // manual positions in this library's folders
]);

export interface CopyResult extends ImportResult {
  /** How many items were copied (the export toast reads this). */
  copied: number;
  /** Items not copied and why (already there, missing file...). */
  skipped: string[];
  skippedReasons: { id: string; reason: string }[];
  target: LibraryRef;
}

/** Another library's folder tree, so the copy dialog can pick a target folder. Opened read-only. */
export async function listLibraryFolders(s: Session, targetPath: string): Promise<FolderNode[]> {
  const ref = libraryRef(targetPath);
  if (!(await pathExists(join(ref.path, 'metadata.json'))))
    throw new Error(`${quoted(ref.name)} doesn't look like an Eagle library.`);
  const lib = await s.env.deps.eagle.open(ref.path, {
    readOnly: true,
    journal: s.journal,
    nameMaxChars: s.env.settings().windowsNameMaxChars,
  });
  try {
    return ((await lib.readRoot()).value.folders ?? []).map(folderNode);
  } finally {
    await lib.close();
  }
}

/** The target must exist, be another library, and be one Boogie may edit right now. */
async function openTarget(s: Session, targetPath: string): Promise<LibraryRef> {
  const ref = libraryRef(targetPath);
  if (ref.id === s.ref.id) throw new Error('Pick a different library to copy into.');
  if (!(await pathExists(join(ref.path, 'metadata.json'))))
    throw new Error(`${quoted(ref.name)} doesn't look like an Eagle library.`);
  const open = s.env.findOpen(ref.id);
  if (open?.readOnly)
    throw new Error(
      `Boogie can't add to ${quoted(ref.name)}: ${open.readOnlyReason ?? 'it is read-only.'}`,
    );
  if (open) return ref;
  const probe = await s.env.deps.eagle.probe(ref.path);
  const decision = await decideReadOnly(s.env, ref, {
    userReadOnly: false,
    versionReason: probe.ok ? null : versionReason(probe.applicationVersion),
  });
  if (decision.reason)
    throw new Error(`Boogie can't add to ${quoted(ref.name)}: ${decision.reason}`);
  return ref;
}

export async function copyToLibrary(
  s: Session,
  actor: Actor,
  rawIds: string[],
  targetPath: string,
  opts: { folderId?: string | null } = {},
): Promise<{ jobId: string }> {
  const { ids, bad } = cleanIds(rawIds);
  if (!ids.length) throw new Error('Pick some items first.');
  const ref = await openTarget(s, targetPath);
  const { deps, jobs } = s.env;

  const jobId = jobs.start(
    'export',
    `Adding ${itemsText(ids.length)} to ${quoted(ref.name)}`,
    async (h): Promise<CopyResult> => {
      const result: CopyResult = {
        added: [],
        duplicates: [],
        failed: [],
        copied: 0,
        skipped: [],
        skippedReasons: [...bad],
        target: ref,
      };
      const label = `Added ${itemsText(ids.length)} from ${quoted(s.ref.name)}`;
      // Boogie has the target open (the window, or an agent): write through that session, so one
      // adapter keeps its mtime.json and the window shows the new items.
      const open = s.env.findOpen(ref.id);
      if (open) {
        if (open.syncPromise) {
          h.label(`Reading ${quoted(ref.name)}`);
          await open.syncPromise;
        }
        const { entry } = await runGroup(
          open,
          actor,
          label,
          'import',
          async (ctx, t) => {
            await copyItems(s, h, ids, open, open.root, opts.folderId ?? null, ctx, result);
            for (const id of result.added) t.added.add(id);
          },
          { lock: false },
        );
        result.groupId = entry?.groupId ?? null;
      } else {
        let lib: EagleLibrary | null = null;
        let index: LibraryIndex | null = null;
        const group = s.journal.begin(ref.id, actor, label, 'import');
        try {
          lib = await deps.eagle.open(ref.path, {
            readOnly: false,
            journal: s.journal,
            nameMaxChars: s.env.settings().windowsNameMaxChars,
          });
          const targetLib = lib;
          // The target's index finds files it already has. Syncing it logs what changed there
          // while it was closed in its History (opening it later would otherwise see nothing).
          h.label(`Reading ${quoted(ref.name)}`);
          const targetIndex = (index = openIndex(s.env, ref));
          await syncOtherIndex(
            s,
            ref,
            targetLib,
            targetIndex,
            (p) => h.progress(p.done, p.total),
            h.signal,
          );
          const into = { ref, lib: targetLib, index: targetIndex };
          const root = (await targetLib.readRoot()).value;
          await copyItems(s, h, ids, into, root, opts.folderId ?? null, { actor, group }, result);
          await targetLib.flushMtime();
        } finally {
          const entry = s.journal.commit(group, { itemIds: result.added });
          result.groupId = entry?.groupId ?? null;
          await lib
            ?.close()
            .catch((e: unknown) => console.error('[boogie] closing a library failed', e));
          index?.close();
        }
      }
      result.copied = result.added.length;
      result.skipped = result.skippedReasons.map((x) => x.id);
      return result;
    },
    { scope: s.ref.id },
  );
  return { jobId };
}

/** Copy each item from `s` into the target, filling in `result`. */
async function copyItems(
  s: Session,
  h: JobHandle,
  ids: string[],
  into: { ref: LibraryRef; lib: EagleLibrary; index: LibraryIndex },
  targetRoot: EagleRootRecord,
  folderId: string | null,
  ctx: ChangeContext,
  result: CopyResult,
): Promise<void> {
  const { ref, lib: targetLib, index: targetIndex } = into;
  const media = s.env.media();
  const { tree } = s.env.deps.helpers;
  if (folderId && !tree.findFolder(targetRoot, folderId))
    throw new Error(`That folder isn't in ${quoted(ref.name)} any more.`);
  const autoTags = folderId ? tree.autoTagsFor(targetRoot, folderId) : [];

  h.label(`Adding ${itemsText(ids.length)} to ${quoted(ref.name)}`);
  const base = Date.now();
  for (const [i, id] of ids.entries()) {
    if (h.signal.aborted) break;
    h.progress(i, ids.length);
    const skip = (reason: string) => {
      result.failed.push({ source: id, reason });
      result.skippedReasons.push({ id, reason });
    };
    try {
      const rec = s.index.getRecord(id) ?? (await s.lib.readItem(id))?.value ?? null;
      if (!rec) {
        skip('Item not found.');
        continue;
      }
      const original = await s.lib.locateOriginal(id, rec);
      const st = original ? await stat(original).catch(() => null) : null;
      if (!original || !st) {
        skip('The original file is missing.');
        continue;
      }
      const md5 = await md5Of(s, media, id, original, st, h.signal);
      const same = sameSizeAndType(targetIndex, st.size, rec.ext);
      const existing = same.length
        ? await findExisting(
            { index: targetIndex, lib: targetLib, media },
            same,
            st.size,
            md5,
            h.signal,
          )
        : null;
      if (existing) {
        result.duplicates.push({ source: id, existingId: existing });
        result.skippedReasons.push({ id, reason: `Already in ${quoted(ref.name)}.` });
        continue;
      }
      const init = await newItemFrom(s, id, rec, original, st, {
        folders: folderId ? [folderId] : [],
        autoTags,
        modificationTime: base + i, // Eagle's "date added" for a copy: now, in order
      });
      const made = await targetLib.createItem(init, ctx);
      targetIndex.upsertRecords([made.record]);
      // The copy's file mtime is set to the record's mtime: that's the hash's fingerprint.
      saveHash(targetIndex, made.id, {
        size: st.size,
        fileMtime: wholeSecond(init.mtime),
        md5,
      });
      result.added.push(made.id);
    } catch (e) {
      if (h.signal.aborted) break;
      skip(errorMessage(e));
    }
  }
  h.progress(ids.length, ids.length);
}

/** The source file's md5, from the source index's cache while it still describes the file. */
async function md5Of(
  s: Session,
  media: ReturnType<Session['env']['media']>,
  id: string,
  path: string,
  st: { size: number; mtimeMs: number },
  signal: AbortSignal,
): Promise<string> {
  const fileMtime = Math.trunc(st.mtimeMs);
  const row = s.index.getHashes([id])[0];
  if (row?.md5 && row.size === st.size && row.fileMtime === fileMtime) return row.md5;
  const md5 = await media.md5(path, signal);
  saveHash(s.index, id, { size: st.size, fileMtime, md5, dhash: row?.dhash ?? undefined });
  return md5;
}

/** The new item's record: everything the item had, minus what only makes sense in this library. */
async function newItemFrom(
  s: Session,
  id: string,
  rec: EagleItemRecord,
  original: string,
  st: { size: number; mtimeMs: number; birthtimeMs: number },
  where: { folders: string[]; autoTags: string[]; modificationTime: number },
): Promise<NewItemInit> {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  // The copy keeps the item's file dates (a record without them takes the file's own).
  const mtime = num(rec.mtime) || st.mtimeMs;
  const btime = num(rec.btime) || (st.birthtimeMs > 0 ? st.birthtimeMs : mtime);
  let thumbnailBytes: Uint8Array | undefined;
  if (!rec.noThumbnail) {
    const thumb = await s.lib.locateThumbnail(id, rec);
    if (thumb) thumbnailBytes = new Uint8Array(await readFile(thumb));
  }
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) if (!NOT_COPIED.has(k)) extra[k] = v;
  return {
    sourcePath: original,
    name: rec.name,
    ext: rec.ext,
    size: st.size,
    btime,
    mtime,
    width: num(rec.width),
    height: num(rec.height),
    duration: num(rec.duration),
    tags: [...(Array.isArray(rec.tags) ? rec.tags : []), ...where.autoTags],
    folders: where.folders,
    url: typeof rec.url === 'string' ? rec.url : '',
    annotation: typeof rec.annotation === 'string' ? rec.annotation : '',
    star: num(rec.star),
    palettes: Array.isArray(rec.palettes) ? rec.palettes : undefined,
    noThumbnail: !!rec.noThumbnail,
    noPreview: !!rec.noPreview,
    thumbnailBytes,
    modificationTime: where.modificationTime,
    extra,
  };
}
