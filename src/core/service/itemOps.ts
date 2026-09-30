// Item mutations: edit, trash, delete for good, manual order, batch rename, thumbnails.
import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Actor, EagleItemRecord, ItemPatch, MutationResult, Scope } from '../../shared/types';
import {
  applyWrites,
  editItems,
  ensureWritable,
  isItemId,
  runGroup,
  toResult,
  writeRoot,
} from './group';
import { itemsText, patchLabel, quoted } from './labels';
import { expandRenameTemplate, type RenameOptions } from './rename';
import { cleanIds, notFound, skip, skipUntouched, unchanged } from './skips';
import { allTrashedIds, existingIds, trashedAmong } from './sql';
import type { Session } from './types';
import { chunks, mapLimit, unique } from './util';

const clampStar = (n: number): number =>
  Number.isFinite(n) ? Math.max(0, Math.min(5, Math.round(n))) : 0;

// ───────────────────────── edit ─────────────────────────

export async function updateItems(
  s: Session,
  actor: Actor,
  rawIds: string[],
  patch: ItemPatch,
): Promise<MutationResult> {
  ensureWritable(s);
  const { edits, tree } = s.env.deps.helpers;
  const { ids, bad } = cleanIds(rawIds);
  if (patch.name !== undefined) {
    if (ids.length !== 1)
      throw new Error(
        'A name can only be changed on one item at a time. Use batch rename for several.',
      );
    if (!patch.name.trim()) throw new Error("A name can't be empty.");
  }
  for (const f of [...(patch.addFolders ?? []), ...(patch.setFolders ?? [])]) {
    if (!tree.findFolder(s.root, f)) throw new Error('One of those folders does not exist.');
  }
  const autoTags = (folderIds: string[]) =>
    unique(folderIds.flatMap((id) => tree.autoTagsFor(s.root, id)));
  const addAutoTags = autoTags(patch.addFolders ?? []);

  const mutate = (rec: EagleItemRecord) => {
    if (patch.setTags) edits.setTags(rec, patch.setTags);
    if (patch.addTags?.length) edits.addTags(rec, patch.addTags);
    if (patch.removeTags?.length) edits.removeTags(rec, patch.removeTags);
    if (patch.star !== undefined) edits.setStar(rec, clampStar(patch.star));
    if (patch.annotation !== undefined) edits.setAnnotation(rec, patch.annotation);
    if (patch.url !== undefined) edits.setUrl(rec, patch.url);
    if (patch.setFolders) {
      const fresh = patch.setFolders.filter((f) => !(rec.folders ?? []).includes(f));
      edits.setFolders(rec, patch.setFolders);
      if (fresh.length) edits.addTags(rec, autoTags(fresh));
    }
    if (patch.addFolders?.length) edits.addFolders(rec, patch.addFolders, addAutoTags);
    if (patch.removeFolders?.length) edits.removeFolders(rec, patch.removeFolders);
  };
  const { name: newName, ...fieldPatch } = patch;
  const hasFieldEdits = Object.values(fieldPatch).some((v) => v !== undefined);

  const folderName = (id: string) => tree.findFolder(s.root, id)?.name;
  const existing = existingIds(s.index, ids);
  const { entry, t } = await runGroup(
    s,
    actor,
    patchLabel(patch, ids.length, folderName),
    'items',
    async (ctx, t) => {
      t.skipped.push(...bad);
      const target = ids.filter((id) => existing.has(id));
      if (hasFieldEdits) await editItems(s, ctx, t, target, mutate);
      if (newName !== undefined && target.length === 1) {
        applyWrites(s, t, [await s.lib.renameItem(target[0], newName, ctx)]);
      }
      skipUntouched(t, ids, existing);
      t.label = patchLabel(patch, t.changed.size, folderName);
    },
  );
  return toResult(entry, t);
}

// ───────────────────────── trash ─────────────────────────

/** Same edit on many items as one group. `label` gets the number of items really changed. */
async function simpleEdit(
  s: Session,
  actor: Actor,
  rawIds: string[],
  kind: 'trash' | 'items',
  label: (n: number) => string,
  mutate: (rec: EagleItemRecord) => boolean | void,
): Promise<MutationResult> {
  ensureWritable(s);
  const { ids, bad } = cleanIds(rawIds);
  const existing = existingIds(s.index, ids);
  const { entry, t } = await runGroup(s, actor, label(ids.length), kind, async (ctx, t) => {
    t.skipped.push(...bad);
    await editItems(
      s,
      ctx,
      t,
      ids.filter((id) => existing.has(id)),
      mutate,
    );
    skipUntouched(t, ids, existing);
    t.label = label(t.changed.size);
  });
  return toResult(entry, t);
}

export function trashItems(s: Session, actor: Actor, ids: string[]): Promise<MutationResult> {
  const { edits } = s.env.deps.helpers;
  return simpleEdit(
    s,
    actor,
    ids,
    'trash',
    (n) => `Moved ${itemsText(n)} to trash`,
    (rec) => {
      if (rec.isDeleted) return false;
      edits.trash(rec, Date.now());
    },
  );
}

export function restoreItems(s: Session, actor: Actor, ids: string[]): Promise<MutationResult> {
  const { edits } = s.env.deps.helpers;
  return simpleEdit(
    s,
    actor,
    ids,
    'trash',
    (n) => `Restored ${itemsText(n)} from trash`,
    (rec) => {
      if (!rec.isDeleted) return false;
      edits.restore(rec);
    },
  );
}

/**
 * In a shared library a delete for good reaches the partner too: Dropbox removes the item folders
 * from their copy. Undo brings them back for both.
 */
function deletedForPartnerWarning(s: Session): string {
  const who = s.partnerName ?? 'Your partner';
  const whose = s.partnerName ? `${s.partnerName}'s` : "your partner's";
  return `${who} loses these items too once Dropbox syncs (Undo brings them back). Eagle on ${whose} computer may keep showing them until it restarts.`;
}

/** Trashed items only. The folders go to the journal's store (outside the library), never `rm`. */
export async function deletePermanently(
  s: Session,
  actor: Actor,
  rawIds: string[],
  label?: (n: number) => string,
): Promise<MutationResult> {
  ensureWritable(s);
  const { ids, bad } = cleanIds(rawIds);
  const trashed = trashedAmong(s.index, ids);
  const makeLabel = label ?? ((n: number) => `Deleted ${itemsText(n)} for good`);
  const { entry, t } = await runGroup(
    s,
    actor,
    makeLabel(trashed.size),
    'delete',
    async (ctx, t) => {
      t.skipped.push(...bad);
      for (const id of ids) {
        if (!trashed.has(id) && !t.skipped.some((x) => x.id === id)) {
          t.skipped.push(skip(id, 'Only items in the trash can be deleted for good.'));
        }
      }
      const dest = join(s.journal.storeDirFor(s.ref.id), ctx.group.id); // the adapter creates it
      for (const part of chunks([...trashed], 50)) {
        const moved: string[] = [];
        try {
          for (const id of part) {
            await s.lib.moveItemOut(id, dest, ctx);
            moved.push(id);
          }
        } finally {
          if (moved.length) {
            s.index.removeItems(moved);
            for (const id of moved) t.removed.add(id);
          }
        }
        await t.pause();
      }
      t.label = makeLabel(t.removed.size);
      if (s.shared && t.removed.size) t.warning = deletedForPartnerWarning(s);
    },
  );
  return toResult(entry, t);
}

export function emptyTrash(s: Session, actor: Actor): Promise<MutationResult> {
  return deletePermanently(
    s,
    actor,
    allTrashedIds(s.index),
    (n) => `Emptied the trash (${itemsText(n)})`,
  );
}

// ───────────────────────── manual order ─────────────────────────

export async function reorderItems(
  s: Session,
  actor: Actor,
  folderId: string,
  rawIds: string[],
  beforeId: string | null,
): Promise<MutationResult> {
  ensureWritable(s);
  const { tree, order, edits } = s.env.deps.helpers;
  const folder = tree.findFolder(s.root, folderId);
  if (!folder) throw new Error('That folder does not exist.');
  if (beforeId !== null && !isItemId(beforeId)) throw new Error('That spot is not a valid item.');
  const { ids: moved, bad } = cleanIds(rawIds);
  const label = (n: number) => `Reordered ${itemsText(n)} in ${quoted(folder.name)}`;

  const { entry, t } = await runGroup(s, actor, label(moved.length), 'items', async (ctx, t) => {
    t.skipped.push(...bad);
    if (folder.orderBy !== 'MANUAL') {
      // Dragging in a folder that isn't manual switches it to manual (a root save), like Eagle.
      await writeRoot(s, ctx, t, (root) =>
        tree.updateFolder(root, folderId, { orderBy: 'MANUAL', sortIncrease: true }),
      );
    }
    const scope: Scope = { kind: 'folder', id: folderId, includeSubfolders: false };
    const display = s.query.query({ scope, filter: {}, sort: null }).ids;
    const inFolder = new Set(display);
    const movedList = moved.filter((id) => inFolder.has(id));
    const movedSet = new Set(movedList);
    for (const id of moved) if (!movedSet.has(id)) t.skipped.push(skip(id, 'Not in this folder.'));
    if (!movedList.length) return;

    // Where the moved items land, among the items that stay put.
    const remaining = display.filter((id) => !movedSet.has(id));
    let at = remaining.length;
    if (beforeId !== null) {
      let p = display.indexOf(beforeId);
      if (p < 0) throw new Error('That spot is not in this folder.');
      while (p < display.length && movedSet.has(display[p])) p++;
      at = p < display.length ? remaining.indexOf(display[p]) : remaining.length;
    }

    // Which way the folder is shown: MANUAL normally has the largest key on top. Ask the query
    // engine, which is what draws the grid, so the keys we write always match what you see.
    const topIsLargest = !s.query.defaultSort(scope).ascending;
    const keyOf = (id: string): string => {
      const rec = s.index.getRecord(id);
      if (!rec) throw new Error('An item in this folder could not be read. Refresh and try again.');
      return order.orderKey(rec, folderId);
    };
    // Strictly ordered the way the folder is shown (largest first, or smallest first)?
    const roomBetween = (above: string | null, below: string | null): boolean =>
      above === null ||
      below === null ||
      (topIsLargest ? order.compareOrder(above, below) > 0 : order.compareOrder(above, below) < 0);

    const rewrite = new Map<string, string>();
    let above = at > 0 ? keyOf(remaining[at - 1]) : null;
    let below = at < remaining.length ? keyOf(remaining[at]) : null;
    if (!roomBetween(above, below)) {
      // The two neighbors share a position, so there is no room between them: spread the folder first.
      const keys = remaining.map(keyOf);
      const spread = order.spreadDuplicates(keys, { descending: topIsLargest });
      spread.forEach((key, i) => key !== keys[i] && rewrite.set(remaining[i], key));
      above = at > 0 ? spread[at - 1] : null;
      below = at < remaining.length ? spread[at] : null;
      if (!roomBetween(above, below))
        throw new Error("This folder's manual order could not be sorted out.");
    }
    const fresh = order.placeBetween(above, below, movedList.length, { descending: topIsLargest });
    if (fresh.length !== movedList.length) throw new Error('Could not work out a new order.');
    movedList.forEach((id, i) => rewrite.set(id, fresh[i]));

    await mapLimit([...rewrite], 8, async ([id, key]) => {
      applyWrites(s, t, [
        await s.lib.updateItem(id, (rec) => edits.setOrder(rec, folderId, key), ctx),
      ]);
    });
    t.count = movedList.length;
    t.label = label(movedList.length);
  });
  return toResult(entry, t);
}

// ───────────────────────── batch rename ─────────────────────────

export async function renameItems(
  s: Session,
  actor: Actor,
  rawIds: string[],
  template: string,
  opts: RenameOptions = {},
): Promise<MutationResult> {
  ensureWritable(s);
  if (!template.trim()) throw new Error('Type a name pattern first.');
  const { ids, bad } = cleanIds(rawIds);
  const found: { id: string; rec: EagleItemRecord }[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const rec = s.index.getRecord(id);
    if (rec) found.push({ id, rec });
    else missing.push(id);
  }
  const names = expandRenameTemplate(
    template,
    found.map(({ rec }) => ({
      name: rec.name,
      tags: rec.tags ?? [],
      importedAt: Number(rec.modificationTime) || 0,
    })),
    opts,
  );
  const label = (n: number) => `Renamed ${itemsText(n)}`;

  const { entry, t } = await runGroup(s, actor, label(found.length), 'items', async (ctx, t) => {
    t.skipped.push(...bad, ...missing.map(notFound));
    let n = 0;
    for (const [i, { id, rec }] of found.entries()) {
      const next = names[i].trim();
      if (!next) t.skipped.push(skip(id, 'The new name would be empty.'));
      else if (next === rec.name) t.skipped.push(unchanged(id));
      else {
        const wrote = applyWrites(s, t, [await s.lib.renameItem(id, next, ctx)]);
        if (!wrote) t.skipped.push(unchanged(id));
      }
      if (++n % 50 === 0) await t.pause();
    }
    t.label = label(t.changed.size);
  });
  return toResult(entry, t);
}

// ───────────────────────── thumbnails ─────────────────────────

/**
 * A job (progress shows, closing the library stops it between items). vips runs outside the lock;
 * only each item's write takes it, so other edits and outside changes keep flowing meanwhile.
 */
export function refreshThumbnails(
  s: Session,
  actor: Actor,
  rawIds: string[],
): Promise<MutationResult> {
  ensureWritable(s);
  const media = s.env.media();
  const { ids, bad } = cleanIds(rawIds);
  const label = (n: number) => `Refreshed ${n === 1 ? 'a thumbnail' : `${n} thumbnails`}`;

  return s.env.jobs.launch(
    'thumbnails',
    `Refreshing ${ids.length === 1 ? 'a thumbnail' : `${ids.length} thumbnails`}`,
    async (h) => {
      const { entry, t } = await runGroup(
        s,
        actor,
        label(ids.length),
        'items',
        async (ctx, t) => {
          t.skipped.push(...bad);
          for (const [i, id] of ids.entries()) {
            if (h.signal.aborted || s.closed) break;
            h.progress(i, ids.length);
            const doc = await s.lib.readItem(id);
            if (!doc) {
              t.skipped.push(notFound(id));
              continue;
            }
            const source = await s.lib.locateOriginal(id, doc.value);
            if (!source) {
              t.skipped.push(skip(id, 'The original file is missing.'));
              continue;
            }
            const thumb = await media.eagleThumbnail(source, await media.probe(source));
            if (!thumb.bytes && !thumb.noThumbnail) {
              t.skipped.push(skip(id, 'A thumbnail could not be made for this file.'));
              continue;
            }
            await s.lock.run(async () => {
              ensureWritable(s);
              if (thumb.bytes) await s.lib.writeThumbnail(id, doc.value, thumb.bytes, ctx);
              const imagePath = thumb.bytes
                ? ((await s.lib.locateThumbnail(id, doc.value)) ?? source)
                : source;
              const palettes = await media.palette(imagePath);
              const write = await s.lib.updateItem(
                id,
                (r) => {
                  if (thumb.bytes) delete r.noThumbnail;
                  else r.noThumbnail = true;
                  if (palettes) {
                    r.palettes = palettes;
                    delete r.processingPalette;
                  }
                },
                ctx,
              );
              // Nothing in the record changed, but the thumbnail file did: the UI still reloads it.
              if (!applyWrites(s, t, [write])) t.changed.add(id);
            });
          }
          h.progress(ids.length, ids.length);
          t.label = label(t.changed.size);
        },
        { lock: false },
      );
      return toResult(entry, t);
    },
    { scope: s.ref.id },
  ).result;
}

/**
 * The picture becomes the item's thumbnail, rendered through media like any Eagle thumbnail (so a
 * Krita, EPS or AI file works through its own flattened image, and anything without a picture is
 * refused instead of being written as `_thumbnail.png`). Like Eagle: the item stops being
 * icon-only, is marked `customThumbnail`, and gets a palette from the new thumbnail. Its size is
 * only filled in when it has none (Eagle overwrites it with the picture's, which is wrong for
 * pictures of a different shape).
 */
export async function setCustomThumbnail(
  s: Session,
  actor: Actor,
  id: string,
  imagePath: string,
): Promise<MutationResult> {
  ensureWritable(s);
  if (!isItemId(id)) throw new Error('That is not a valid item.');
  if (
    !(await stat(imagePath).then(
      (st) => st.isFile(),
      () => false,
    ))
  )
    throw new Error('That picture file could not be found.');
  const media = s.env.media();
  const probe = await media.probe(imagePath);
  const made = await media.eagleThumbnail(imagePath, probe, undefined, { force: true });
  if (!made.bytes?.length)
    throw new Error('That file has no picture Boogie can use as a thumbnail. Pick an image.');
  const bytes = made.bytes;

  const { entry, t } = await runGroup(
    s,
    actor,
    'Set a custom thumbnail',
    'items',
    async (ctx, t) => {
      const doc = await s.lib.readItem(id);
      if (!doc) {
        t.skipped.push(notFound(id));
        return;
      }
      await s.lib.writeThumbnail(id, doc.value, bytes, ctx, { keepOld: true }); // undo puts it back
      const thumbPath = await s.lib.locateThumbnail(id, doc.value);
      const palettes = thumbPath ? await media.palette(thumbPath).catch(() => null) : null;
      const write = await s.lib.updateItem(
        id,
        (r) => {
          delete r.noThumbnail;
          delete r.noPreview;
          r.customThumbnail = true;
          if (!r.width || !r.height) {
            if (probe.width && probe.height) {
              r.width = probe.width;
              r.height = probe.height;
            }
          }
          if (palettes) {
            r.palettes = palettes;
            delete r.processingPalette;
          }
        },
        ctx,
      );
      if (!applyWrites(s, t, [write])) t.changed.add(id);
    },
  );
  return toResult(entry, t);
}

/** A custom thumbnail from picture bytes (a video frame grabbed in the viewer), via a temp file in our own cache. */
export async function setCustomThumbnailBytes(
  s: Session,
  actor: Actor,
  id: string,
  bytes: Uint8Array,
): Promise<MutationResult> {
  await mkdir(s.env.paths.tmp, { recursive: true });
  const file = join(s.env.paths.tmp, `frame-${randomUUID()}.png`);
  await writeFile(file, bytes);
  try {
    return await setCustomThumbnail(s, actor, id, file);
  } finally {
    await rm(file, { force: true });
  }
}
