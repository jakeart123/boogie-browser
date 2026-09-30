// Item write tools. Additive ones apply directly (up to 50 items); changing ones, and any bulk
// write, go through plan-then-apply. All of them share runWrite, so the rules are the same everywhere.
import { z } from 'zod';
import type { ItemPatch } from '../../../shared/types';
import { type Change, diffPatch, previewRename } from '../changes';
import { UserError } from '../errors';
import { FolderIndex } from '../folders';
import {
  ADDITIVE_RULE,
  type Call,
  plural,
  type Tool,
  TWO_STEP,
  uniq,
  writableLibrary,
} from '../kit';
import { dryRun, folderRefs, itemId, itemIds, planId, tagList } from '../schemas';
import { fetchItems, fromMutation, runWrite } from '../write';

interface PatchJob {
  tool: string;
  kind: 'additive' | 'changing';
  ids: string[];
  /** Built once the folder tree is known, so folder names can be resolved. */
  patch: (folders: FolderIndex) => ItemPatch;
  /** The tool's arguments without plan_id/dry_run. */
  args: unknown;
  dryRun?: boolean;
  planId?: string;
  /** One plain sentence, given "3 items" (or "1 item") to put in it. */
  summary: (items: string) => string;
  activity: string;
}

async function patchWrite(call: Call, job: PatchJob) {
  const lib = await writableLibrary(call);
  const folders = new FolderIndex(lib.folders);
  const patch = job.patch(folders);
  return runWrite(
    call,
    lib,
    { tool: job.tool, args: job.args, kind: job.kind, dryRun: job.dryRun, planId: job.planId },
    async () => {
      const items = await fetchItems(call.api, job.ids);
      const changes = items.flatMap((i) => diffPatch(i, patch, folders));
      const touched = uniq(changes.map((c) => c.id));
      return {
        summary: job.summary(plural(touched.length, 'item')),
        changes,
        itemCount: touched.length,
        activity: `${job.activity} ${plural(touched.length, 'item')}`,
        emptyNote: `Nothing to change: none of the ${plural(items.length, 'item')} would be affected.`,
        apply: async () => fromMutation(await call.api.updateItems(touched, patch)),
      };
    },
  );
}

async function trashWrite(
  call: Call,
  tool: string,
  ids: string[],
  restore: boolean,
  plan?: string,
) {
  const lib = await writableLibrary(call);
  return runWrite(
    call,
    lib,
    { tool, args: { item_ids: ids }, kind: 'changing', planId: plan },
    async () => {
      const items = (await fetchItems(call.api, ids)).filter((i) => i.isDeleted === restore);
      const changes: Change[] = items.map((i) => ({
        id: i.id,
        name: i.name,
        field: 'in_trash',
        before: restore,
        after: !restore,
      }));
      const touched = items.map((i) => i.id);
      return {
        summary: restore
          ? `Restore ${plural(touched.length, 'item')} from the trash`
          : `Move ${plural(touched.length, 'item')} to the trash (recoverable: restore_items or undo)`,
        changes,
        itemCount: touched.length,
        activity: `${restore ? 'Restoring' : 'Trashing'} ${plural(touched.length, 'item')}`,
        emptyNote: restore
          ? 'Nothing to restore: none of those items are in the trash.'
          : 'Nothing to trash: those items are already in the trash.',
        apply: async () =>
          fromMutation(
            await (restore ? call.api.restoreItems(touched) : call.api.trashItems(touched)),
          ),
      };
    },
  );
}

export function registerItemWriteTools(tool: Tool): void {
  // ── Additive: apply directly up to 50 items ──

  tool(
    'add_tags',
    {
      title: 'Add tags',
      description:
        'Add tags to items (existing tags stay). Reuse spellings from list_tags.' + ADDITIVE_RULE,
      input: z.strictObject({ item_ids: itemIds, tags: tagList, dry_run: dryRun, plan_id: planId }),
      kind: 'additive',
    },
    ({ item_ids, tags, dry_run, plan_id }, call) => {
      const ids = uniq(item_ids);
      const clean = uniq(tags);
      return patchWrite(call, {
        tool: 'add_tags',
        kind: 'additive',
        ids,
        args: { item_ids: ids, tags: clean },
        dryRun: dry_run,
        planId: plan_id,
        patch: () => ({ addTags: clean }),
        summary: (n) => `Add tags ${clean.join(', ')} to ${n}`,
        activity: 'Tagging',
      });
    },
  );

  tool(
    'set_rating',
    {
      title: 'Set rating',
      description: 'Set the star rating of items (1 to 5; 0 clears it).' + ADDITIVE_RULE,
      input: z.strictObject({
        item_ids: itemIds,
        rating: z.number().int().min(0).max(5),
        dry_run: dryRun,
        plan_id: planId,
      }),
      kind: 'additive',
    },
    ({ item_ids, rating, dry_run, plan_id }, call) => {
      const ids = uniq(item_ids);
      return patchWrite(call, {
        tool: 'set_rating',
        kind: 'additive',
        ids,
        args: { item_ids: ids, rating },
        dryRun: dry_run,
        planId: plan_id,
        patch: () => ({ star: rating }),
        summary: (n) =>
          rating ? `Set the rating of ${n} to ${rating}` : `Clear the rating of ${n}`,
        activity: 'Rating',
      });
    },
  );

  tool(
    'set_note',
    {
      title: 'Set note',
      description:
        'Replace the note of items with this text (empty clears it). Read the old note with get_item first if it matters.' +
        ADDITIVE_RULE,
      input: z.strictObject({
        item_ids: itemIds,
        note: z.string().max(20_000),
        dry_run: dryRun,
        plan_id: planId,
      }),
      kind: 'additive',
    },
    ({ item_ids, note, dry_run, plan_id }, call) => {
      const ids = uniq(item_ids);
      return patchWrite(call, {
        tool: 'set_note',
        kind: 'additive',
        ids,
        args: { item_ids: ids, note },
        dryRun: dry_run,
        planId: plan_id,
        patch: () => ({ annotation: note }),
        summary: (n) => `Set the note of ${n}`,
        activity: 'Writing notes on',
      });
    },
  );

  tool(
    'set_url',
    {
      title: 'Set source URL',
      description: 'Replace the source URL of items (empty clears it).' + ADDITIVE_RULE,
      input: z.strictObject({
        item_ids: itemIds,
        url: z.string().max(2000),
        dry_run: dryRun,
        plan_id: planId,
      }),
      kind: 'additive',
    },
    ({ item_ids, url, dry_run, plan_id }, call) => {
      const clean = url.trim();
      if (clean) {
        try {
          new URL(clean);
        } catch {
          throw new UserError(
            `"${clean}" is not a valid URL. Include the scheme, like https://example.com/page.`,
          );
        }
      }
      const ids = uniq(item_ids);
      return patchWrite(call, {
        tool: 'set_url',
        kind: 'additive',
        ids,
        args: { item_ids: ids, url: clean },
        dryRun: dry_run,
        planId: plan_id,
        patch: () => ({ url: clean }),
        summary: (n) =>
          clean ? `Set the source URL of ${n} to ${clean}` : `Clear the source URL of ${n}`,
        activity: 'Setting URLs on',
      });
    },
  );

  tool(
    'add_to_folders',
    {
      title: 'Add to folders',
      description:
        "Put items into folders (they stay in their other folders). Items also get the folders' auto-tags, and their parents'." +
        ADDITIVE_RULE,
      input: z.strictObject({
        item_ids: itemIds,
        folders: folderRefs,
        dry_run: dryRun,
        plan_id: planId,
      }),
      kind: 'additive',
    },
    ({ item_ids, folders, dry_run, plan_id }, call) => {
      const ids = uniq(item_ids);
      return patchWrite(call, {
        tool: 'add_to_folders',
        kind: 'additive',
        ids,
        args: { item_ids: ids, folders },
        dryRun: dry_run,
        planId: plan_id,
        patch: (idx) => ({ addFolders: idx.resolveAll(folders).map((e) => e.id) }),
        summary: (n) => `Add ${n} to ${folders.join(', ')}`,
        activity: 'Filing',
      });
    },
  );

  // ── Changing: always dry run first ──

  tool(
    'remove_tags',
    {
      title: 'Remove tags',
      description: 'Remove tags from items.' + TWO_STEP,
      input: z.strictObject({ item_ids: itemIds, tags: tagList, plan_id: planId }),
      kind: 'changing',
      idempotent: true,
    },
    ({ item_ids, tags, plan_id }, call) => {
      const ids = uniq(item_ids);
      const clean = uniq(tags);
      return patchWrite(call, {
        tool: 'remove_tags',
        kind: 'changing',
        ids,
        args: { item_ids: ids, tags: clean },
        planId: plan_id,
        patch: () => ({ removeTags: clean }),
        summary: (n) => `Remove tags ${clean.join(', ')} from ${n}`,
        activity: 'Untagging',
      });
    },
  );

  tool(
    'remove_from_folders',
    {
      title: 'Remove from folders',
      description:
        'Take items out of folders (the items stay in the library; auto-tags stay too).' + TWO_STEP,
      input: z.strictObject({ item_ids: itemIds, folders: folderRefs, plan_id: planId }),
      kind: 'changing',
      idempotent: true,
    },
    ({ item_ids, folders, plan_id }, call) => {
      const ids = uniq(item_ids);
      return patchWrite(call, {
        tool: 'remove_from_folders',
        kind: 'changing',
        ids,
        args: { item_ids: ids, folders },
        planId: plan_id,
        patch: (idx) => ({ removeFolders: idx.resolveAll(folders).map((e) => e.id) }),
        summary: (n) => `Remove ${n} from ${folders.join(', ')}`,
        activity: 'Unfiling',
      });
    },
  );

  tool(
    'rename_items',
    {
      title: 'Rename items (template)',
      description:
        'Batch rename, numbered in the order given. Tokens: * original name, %N number (from start, zero padded), %D date added YYYYMMDD, %DD YYYY-MM-DD, %DDD YYYY-MM-DD HH.mm.ss, %T tags. find/replace runs after the template. Names may still be made filename-safe.' +
        TWO_STEP,
      input: z.strictObject({
        item_ids: itemIds,
        template: z.string().min(1).max(200),
        start: z.number().int().min(0).optional().describe('First %N. Default 1.'),
        find: z.string().max(200).optional(),
        replace: z.string().max(200).optional(),
        regex: z.boolean().optional().describe('find is a regular expression.'),
        plan_id: planId,
      }),
      kind: 'changing',
    },
    async ({ item_ids, template, start, find, replace, regex, plan_id }, call) => {
      const ids = uniq(item_ids);
      const lib = await writableLibrary(call);
      const opts = { start, find, replace, regex };
      return runWrite(
        call,
        lib,
        {
          tool: 'rename_items',
          args: { item_ids: ids, template, ...opts },
          kind: 'changing',
          planId: plan_id,
        },
        async () => {
          const items = await fetchItems(call.api, ids);
          const names = previewRename(items, template, opts);
          if (names.some((n) => !n))
            throw new UserError('That template would give an item an empty name. Include * or %N.');
          const changes: Change[] = items.flatMap((it, i) =>
            names[i] === it.name
              ? []
              : [{ id: it.id, name: it.name, field: 'name', before: it.name, after: names[i] }],
          );
          return {
            summary: `Rename ${plural(changes.length, 'item')} using "${template}"`,
            changes,
            itemCount: changes.length,
            activity: `Renaming ${plural(changes.length, 'item')}`,
            emptyNote: 'Nothing to rename: every item would keep its current name.',
            // All ids go to the app in the order given so %N numbering matches the preview.
            apply: async () => fromMutation(await call.api.renameItems(ids, template, opts)),
          };
        },
      );
    },
  );

  tool(
    'rename_item',
    {
      title: 'Rename one item',
      description: 'Rename one item (name without extension).' + TWO_STEP,
      input: z.strictObject({
        id: itemId,
        name: z.string().trim().min(1).max(200),
        plan_id: planId,
      }),
      kind: 'changing',
    },
    ({ id, name, plan_id }, call) => {
      if (/[\u0000-\u001f/\\]/.test(name))
        throw new UserError('An item name cannot contain slashes or control characters.');
      return patchWrite(call, {
        tool: 'rename_item',
        kind: 'changing',
        ids: [id],
        args: { id, name },
        planId: plan_id,
        patch: () => ({ name }),
        summary: () => `Rename the item to "${name}"`,
        activity: 'Renaming',
      });
    },
  );

  tool(
    'move_to_trash',
    {
      title: 'Move to trash',
      description:
        'Move items to the trash (recoverable with restore_items; nothing is deleted from disk).' +
        TWO_STEP,
      input: z.strictObject({ item_ids: itemIds, plan_id: planId }),
      kind: 'changing',
      idempotent: true,
    },
    ({ item_ids, plan_id }, call) =>
      trashWrite(call, 'move_to_trash', uniq(item_ids), false, plan_id),
  );

  tool(
    'restore_items',
    {
      title: 'Restore from trash',
      description: 'Put items back from the trash.' + TWO_STEP,
      input: z.strictObject({ item_ids: itemIds, plan_id: planId }),
      kind: 'changing',
      idempotent: true,
    },
    ({ item_ids, plan_id }, call) =>
      trashWrite(call, 'restore_items', uniq(item_ids), true, plan_id),
  );
}
