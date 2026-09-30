// Folder and tag tools. Renames, moves and deletes affect many items or the shared folder tree,
// so they are plan-then-apply like the other changing writes.
import { z } from 'zod';
import type { CoreApi } from '../../../shared/api';
import type { FilterSpec, FolderPatch } from '../../../shared/types';
import { type Change } from '../changes';
import { UserError } from '../errors';
import { FolderIndex } from '../folders';
import { plural, type Tool, TWO_STEP, uniq, writableLibrary } from '../kit';
import { MAX_ITEMS_PER_APPLY } from '../plans';
import { colorName, colorOrNone, dryRun, folderRef, planId } from '../schemas';
import { fetchItems, fromMutation, runWrite } from '../write';

/** Ids of every item matching the filter, trashed ones included: renames and deletes reach those too. */
async function allIdsMatching(api: CoreApi, filter: FilterSpec): Promise<string[]> {
  const ids: string[] = [];
  for (const kind of ['all', 'trash'] as const)
    ids.push(...(await api.query({ scope: { kind }, filter, sort: null })).ids);
  return uniq(ids);
}

function tooMany(count: number, how: string): UserError {
  return new UserError(
    `That touches ${count} items and the limit is ${MAX_ITEMS_PER_APPLY} per apply. ${how}`,
  );
}

export function registerOrganizeTools(tool: Tool): void {
  tool(
    'create_folder',
    {
      title: 'Create folder',
      description:
        'Create a folder (top level, or inside parent). Safe to repeat: an existing folder of that name there is returned instead.',
      input: z.strictObject({
        name: z.string().trim().min(1).max(200),
        parent: folderRef.optional(),
        color: colorName.optional(),
        dry_run: dryRun,
        plan_id: planId,
      }),
      kind: 'additive',
    },
    async ({ name, parent, color, dry_run, plan_id }, call) => {
      const lib = await writableLibrary(call);
      const idx = new FolderIndex(lib.folders);
      const parentEntry = parent ? idx.resolve(parent) : null;
      const siblings = parentEntry ? parentEntry.node.children : lib.folders;
      const existing = siblings.find((f) => f.name.trim().toLowerCase() === name.toLowerCase());
      if (existing) {
        return {
          status: 'nothing_to_do',
          summary: `A folder named "${existing.name}" already exists there.`,
          folder_id: existing.id,
          path: idx.pathOf(existing.id),
        };
      }
      const path = parentEntry ? `${parentEntry.path} / ${name}` : name;
      return runWrite(
        call,
        lib,
        {
          tool: 'create_folder',
          args: { name, parent: parentEntry?.id ?? null, color },
          kind: 'additive',
          dryRun: dry_run,
          planId: plan_id,
        },
        async () => ({
          summary: `Create folder "${path}"`,
          changes: [{ id: '(new folder)', name, field: 'folder', before: null, after: path }],
          itemCount: 0,
          activity: `Creating folder ${name}`,
          apply: async () => {
            const made = await call.api.createFolder(
              name,
              parentEntry?.id ?? null,
              color ? { iconColor: color } : undefined,
            );
            return { groupId: made.groupId, changed: 1, extra: { folder_id: made.id, path } };
          },
        }),
      );
    },
  );

  tool(
    'update_folder',
    {
      title: 'Update folder',
      description:
        "Set a folder's description, color or auto-tags (tags every item added to it gets; replaces the list).",
      input: z.strictObject({
        folder: folderRef,
        description: z.string().max(10_000).optional(),
        color: colorOrNone.optional(),
        auto_tags: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
        dry_run: dryRun,
      }),
      kind: 'additive',
    },
    async ({ folder, description, color, auto_tags, dry_run }, call) => {
      const lib = await writableLibrary(call);
      const f = new FolderIndex(lib.folders).resolve(folder);
      const patch: FolderPatch = {};
      const changes: Change[] = [];
      const set = (field: string, before: unknown, after: unknown, apply: () => void) => {
        if (JSON.stringify(before) === JSON.stringify(after)) return;
        changes.push({ id: f.id, name: f.path, field, before, after });
        apply();
      };
      if (description !== undefined)
        set(
          'description',
          f.node.description,
          description,
          () => (patch.description = description),
        );
      if (color !== undefined) {
        const next = color === 'none' ? null : color;
        set('color', f.node.iconColor ?? null, next, () => (patch.iconColor = next));
      }
      if (auto_tags !== undefined) {
        const next = uniq(auto_tags);
        set('auto_tags', f.node.tags, next, () => (patch.tags = next));
      }
      return runWrite(
        call,
        lib,
        {
          tool: 'update_folder',
          args: { folder: f.id, description, color, auto_tags },
          kind: 'additive',
          dryRun: dry_run,
        },
        async () => ({
          summary: `Update folder "${f.path}"`,
          changes,
          itemCount: 0,
          activity: `Updating folder ${f.name}`,
          emptyNote: 'The folder already looks like that.',
          apply: async () => fromMutation(await call.api.updateFolder(f.id, patch)),
        }),
      );
    },
  );

  tool(
    'rename_folder',
    {
      title: 'Rename folder',
      description: 'Rename a folder.' + TWO_STEP,
      input: z.strictObject({
        folder: folderRef,
        name: z.string().trim().min(1).max(200),
        plan_id: planId,
      }),
      kind: 'changing',
    },
    async ({ folder, name, plan_id }, call) => {
      const lib = await writableLibrary(call);
      const f = new FolderIndex(lib.folders).resolve(folder);
      return runWrite(
        call,
        lib,
        { tool: 'rename_folder', args: { folder: f.id, name }, kind: 'changing', planId: plan_id },
        async () => ({
          summary: `Rename folder "${f.path}" to "${name}"`,
          changes:
            f.name === name
              ? []
              : [{ id: f.id, name: f.path, field: 'name', before: f.name, after: name }],
          itemCount: 0,
          activity: `Renaming folder ${f.name}`,
          emptyNote: 'The folder already has that name.',
          apply: async () => fromMutation(await call.api.updateFolder(f.id, { name })),
        }),
      );
    },
  );

  tool(
    'move_folder',
    {
      title: 'Move folder',
      description:
        'Move a folder (with its contents) under new_parent, or to the top level.' + TWO_STEP,
      input: z.strictObject({
        folder: folderRef,
        new_parent: folderRef.optional(),
        position: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Among its new siblings. Default last.'),
        plan_id: planId,
      }),
      kind: 'changing',
      idempotent: true,
    },
    async ({ folder, new_parent, position, plan_id }, call) => {
      const lib = await writableLibrary(call);
      const idx = new FolderIndex(lib.folders);
      const f = idx.resolve(folder);
      const parent = new_parent ? idx.resolve(new_parent) : null;
      if (parent && idx.subtreeIds(f.id).includes(parent.id))
        throw new UserError(
          `A folder cannot move into itself or one of its own subfolders ("${f.path}" into "${parent.path}").`,
        );
      const oldSiblings = (f.parentId ? idx.get(f.parentId)!.node.children : lib.folders).map(
        (n) => n.id,
      );
      const newSiblings = (parent ? parent.node.children : lib.folders)
        .map((n) => n.id)
        .filter((id) => id !== f.id);
      const target = Math.min(position ?? newSiblings.length, newSiblings.length);
      const before = {
        parent: f.parentId ? idx.pathOf(f.parentId) : null,
        position: oldSiblings.indexOf(f.id),
      };
      const after = { parent: parent?.path ?? null, position: target };
      const same = f.parentId === (parent?.id ?? null) && before.position === target;
      return runWrite(
        call,
        lib,
        {
          tool: 'move_folder',
          args: { folder: f.id, new_parent: parent?.id ?? null, position: target },
          kind: 'changing',
          planId: plan_id,
        },
        async () => ({
          summary: `Move folder "${f.path}" to ${parent ? `"${parent.path}"` : 'the top level'}`,
          changes: same ? [] : [{ id: f.id, name: f.path, field: 'location', before, after }],
          itemCount: 0,
          activity: `Moving folder ${f.name}`,
          emptyNote: 'The folder is already there.',
          apply: async () =>
            fromMutation(await call.api.moveFolder(f.id, parent?.id ?? null, target)),
        }),
      );
    },
  );

  tool(
    'delete_folder',
    {
      title: 'Delete folder',
      description:
        'Delete a folder and its subfolders. Items are only taken out of them, unless delete_contents is true: then items in no other folder go to the trash.' +
        TWO_STEP,
      input: z.strictObject({
        folder: folderRef,
        delete_contents: z.boolean().optional(),
        plan_id: planId,
      }),
      kind: 'changing',
    },
    async ({ folder, delete_contents, plan_id }, call) => {
      const lib = await writableLibrary(call);
      const idx = new FolderIndex(lib.folders);
      const f = idx.resolve(folder);
      const doomed = new Set(idx.subtreeIds(f.id));
      const trashToo = delete_contents === true;
      return runWrite(
        call,
        lib,
        {
          tool: 'delete_folder',
          args: { folder: f.id, delete_contents: trashToo },
          kind: 'changing',
          planId: plan_id,
        },
        async () => {
          const ids = await allIdsMatching(call.api, {
            folders: { include: [...doomed], exclude: [] },
          });
          if (ids.length > MAX_ITEMS_PER_APPLY) {
            throw tooMany(
              ids.length,
              'Take items out first with remove_from_folders in batches of 500 or fewer, then delete the folder.',
            );
          }
          const items = await fetchItems(call.api, ids);
          const changes: Change[] = [
            {
              id: f.id,
              name: f.path,
              field: 'folder',
              before: `exists${doomed.size > 1 ? ` with ${plural(doomed.size - 1, 'subfolder')}` : ''}`,
              after: 'deleted',
            },
          ];
          for (const it of items) {
            const left = it.folders.filter((id) => !doomed.has(id));
            changes.push({
              id: it.id,
              name: it.name,
              field: 'folders',
              before: it.folders.map((id) => idx.pathOf(id)),
              after: left.map((id) => idx.pathOf(id)),
            });
            if (trashToo && left.length === 0 && !it.isDeleted)
              changes.push({
                id: it.id,
                name: it.name,
                field: 'in_trash',
                before: false,
                after: true,
              });
          }
          return {
            summary: `Delete folder "${f.path}"${doomed.size > 1 ? ` and ${plural(doomed.size - 1, 'subfolder')}` : ''}; ${plural(items.length, 'item')} taken out of it${trashToo ? ', those in no other folder go to the trash' : ''}`,
            changes,
            itemCount: items.length,
            activity: `Deleting folder ${f.name}`,
            apply: async () =>
              fromMutation(await call.api.deleteFolder(f.id, { deleteContents: trashToo })),
          };
        },
      );
    },
  );

  tool(
    'rename_tag',
    {
      title: 'Rename tag',
      description: 'Rename a tag on every item (merges into `to` if that tag exists).' + TWO_STEP,
      input: z.strictObject({
        from: z.string().trim().min(1).max(100),
        to: z.string().trim().min(1).max(100),
        plan_id: planId,
      }),
      kind: 'changing',
    },
    async ({ from, to, plan_id }, call) => {
      if (from === to) throw new UserError('"from" and "to" are the same tag.');
      const lib = await writableLibrary(call);
      return runWrite(
        call,
        lib,
        { tool: 'rename_tag', args: { from, to }, kind: 'changing', planId: plan_id },
        async () => {
          const tags = await call.api.listTags();
          if (!tags.some((t) => t.name === from))
            throw new UserError(
              `No tag named "${from}". Tag names are case-sensitive; use list_tags to see them.`,
            );
          const merging = tags.some((t) => t.name === to);
          const ids = await allIdsMatching(call.api, {
            tags: { mode: 'any', include: [from], exclude: [] },
          });
          if (ids.length > MAX_ITEMS_PER_APPLY) {
            throw tooMany(
              ids.length,
              `Do it in batches instead: search_items with tags ["${from}"], then add_tags "${to}" and remove_tags "${from}" for 500 items at a time.`,
            );
          }
          const items = await fetchItems(call.api, ids);
          return {
            summary: `Rename tag "${from}" to "${to}" on ${plural(items.length, 'item')}${merging ? ` (merges into the existing "${to}" tag)` : ''}`,
            changes: items.map((it) => ({
              id: it.id,
              name: it.name,
              field: 'tags',
              before: it.tags,
              after: uniq(it.tags.map((t) => (t === from ? to : t))),
            })),
            itemCount: items.length,
            activity: `Renaming tag ${from}`,
            apply: async () => fromMutation(await call.api.renameTag(from, to)),
          };
        },
      );
    },
  );

  tool(
    'delete_tag',
    {
      title: 'Delete tag',
      description: 'Remove a tag from every item that has it.' + TWO_STEP,
      input: z.strictObject({ name: z.string().trim().min(1).max(100), plan_id: planId }),
      kind: 'changing',
    },
    async ({ name, plan_id }, call) => {
      const lib = await writableLibrary(call);
      return runWrite(
        call,
        lib,
        { tool: 'delete_tag', args: { name }, kind: 'changing', planId: plan_id },
        async () => {
          const tags = await call.api.listTags();
          if (!tags.some((t) => t.name === name))
            throw new UserError(
              `No tag named "${name}". Tag names are case-sensitive; use list_tags to see them.`,
            );
          const ids = await allIdsMatching(call.api, {
            tags: { mode: 'any', include: [name], exclude: [] },
          });
          if (ids.length > MAX_ITEMS_PER_APPLY) {
            throw tooMany(
              ids.length,
              `Do it in batches instead: search_items with tags ["${name}"], then remove_tags for 500 items at a time.`,
            );
          }
          const items = await fetchItems(call.api, ids);
          return {
            summary: `Delete tag "${name}" from ${plural(items.length, 'item')}`,
            changes: items.map((it) => ({
              id: it.id,
              name: it.name,
              field: 'tags',
              before: it.tags,
              after: it.tags.filter((t) => t !== name),
            })),
            itemCount: items.length,
            activity: `Deleting tag ${name}`,
            apply: async () => fromMutation(await call.api.deleteTag(name)),
          };
        },
      );
    },
  );
}
