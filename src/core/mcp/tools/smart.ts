// Smart folders (saved rules in the library's metadata.json) and saved filters
// (saved-filters.json): making, changing and deleting them. search_items and list_smart_folders
// read them.
import { z } from 'zod';
import type { FolderColor, LibraryState, SmartFolderNode } from '../../../shared/types';
import { checkConditions } from '../../http/smartRules';
import { type Change } from '../changes';
import { UserError } from '../errors';
import { type Tool, TWO_STEP, writableLibrary } from '../kit';
import { colorOrNone, dryRun, library, planId } from '../schemas';
import { fromMutation, runWrite } from '../write';
import { buildQuery, SearchInput } from './items';

/** Short enough for tools/list, complete enough to write a rule without guessing. */
const RULES_HELP =
  '[{"match":"AND"|"OR","rules":[{"property","method","value"}]}], conditions ANDed. ' +
  'name/url/annotation(note)/folderName: contain uncontain equal startWith endWith regex empty, "text". ' +
  'tags/folders(ids): union(any) intersection(all) identity(none), ["a"]. rating: equal "1".."5"|"none". ' +
  'type: equal "jpg"|"video". width/height/fileSize(unit mb)/duration(unit s): > < >= <= = between, [n]|[a,b]. ' +
  'createTime(imported)/mtime/btime: before|after|on [ms], within [days]. shape: equal "landscape". color: similar "#rrggbb".';

function flat(nodes: SmartFolderNode[], out: SmartFolderNode[] = []): SmartFolderNode[] {
  for (const n of nodes) {
    out.push(n);
    flat(n.children, out);
  }
  return out;
}

function findSmart(lib: LibraryState, ref: string): SmartFolderNode {
  const all = flat(lib.smartFolders);
  const want = ref.trim().toLowerCase();
  const byName = all.filter((n) => n.name.trim().toLowerCase() === want);
  const hit = all.find((n) => n.id === ref) ?? (byName.length === 1 ? byName[0] : undefined);
  if (!hit)
    throw new UserError(
      byName.length > 1
        ? `"${ref}" matches ${byName.length} smart folders; use the id (list_smart_folders).`
        : `No smart folder matches "${ref}". list_smart_folders shows them.`,
    );
  return hit;
}

function conditionsOrError(raw: unknown) {
  try {
    return checkConditions(raw);
  } catch (e) {
    throw new UserError(`${(e as Error).message} Rule format: ${RULES_HELP}`);
  }
}

/** The filter part of search_items' arguments (a saved filter has no scope, paging or sort). */
const FilterInput = SearchInput.omit({
  library: true,
  scope: true,
  smart_folder: true,
  saved_filter: true,
  sort_by: true,
  ascending: true,
  limit: true,
  offset: true,
});

export function registerSmartTools(tool: Tool): void {
  tool(
    'save_smart_folder',
    {
      title: 'Save smart folder',
      description:
        'Create a smart folder (name + conditions), or change one (smart_folder: its id or name). Check the result with search_items smart_folder.',
      input: z.strictObject({
        library,
        smart_folder: z.string().trim().min(1).optional(),
        name: z.string().trim().min(1).max(200).optional(),
        conditions: z.array(z.record(z.string(), z.unknown())).optional().describe(RULES_HELP),
        parent: z.string().optional().describe('New smart folder inside this one (id or name).'),
        color: colorOrNone.optional(),
        dry_run: dryRun,
      }),
      kind: 'additive',
    },
    async ({ smart_folder, name, conditions, parent, color, dry_run }, call) => {
      const lib = await writableLibrary(call);
      const old = smart_folder ? findSmart(lib, smart_folder) : null;
      if (!old && (!name || !conditions))
        throw new UserError(
          'Give name and conditions to create a smart folder, or smart_folder to change one.',
        );
      const rules = conditions ? conditionsOrError(conditions) : undefined;
      const under = !old && parent ? findSmart(lib, parent) : null;
      const iconColor: FolderColor | null | undefined =
        color === undefined ? undefined : color === 'none' ? null : color;
      const changes: Change[] = [];
      const push = (field: string, before: unknown, after: unknown) => {
        if (JSON.stringify(before) !== JSON.stringify(after))
          changes.push({
            id: old?.id ?? '(new smart folder)',
            name: name ?? old!.name,
            field,
            before,
            after,
          });
      };
      if (!old)
        push('smart_folder', null, { name, conditions: rules, parent: under?.name ?? null });
      else {
        if (name !== undefined) push('name', old.name, name);
        if (rules) push('conditions', old.conditions, rules);
        if (iconColor !== undefined) push('color', old.iconColor, iconColor);
      }
      return runWrite(
        call,
        lib,
        {
          tool: 'save_smart_folder',
          args: {
            smart_folder: old?.id ?? null,
            name,
            conditions: rules,
            parent: under?.id,
            color,
          },
          kind: 'additive',
          dryRun: dry_run,
        },
        async () => ({
          summary: old ? `Change smart folder "${old.name}"` : `Create smart folder "${name}"`,
          changes,
          itemCount: 0,
          activity: `Saving smart folder ${name ?? old!.name}`,
          emptyNote: 'The smart folder already looks like that.',
          apply: async () => {
            if (old) {
              const patch = {
                ...(name !== undefined ? { name } : {}),
                ...(rules ? { conditions: rules } : {}),
                ...(iconColor !== undefined ? { iconColor } : {}),
              };
              return fromMutation(await call.api.updateSmartFolder(old.id, patch), {
                smart_folder_id: old.id,
              });
            }
            const made = await call.api.createSmartFolder(name!, rules!, under?.id ?? null, {
              ...(iconColor ? { iconColor } : {}),
            });
            return { groupId: made.groupId, changed: 1, extra: { smart_folder_id: made.id } };
          },
        }),
      );
    },
  );

  tool(
    'delete_smart_folder',
    {
      title: 'Delete smart folder',
      description: 'Delete a smart folder (only the saved rules; no item changes).' + TWO_STEP,
      input: z.strictObject({ library, smart_folder: z.string().trim().min(1), plan_id: planId }),
      kind: 'changing',
    },
    async ({ smart_folder, plan_id }, call) => {
      const lib = await writableLibrary(call);
      const f = findSmart(lib, smart_folder);
      return runWrite(
        call,
        lib,
        {
          tool: 'delete_smart_folder',
          args: { smart_folder: f.id },
          kind: 'changing',
          planId: plan_id,
        },
        async () => ({
          summary: `Delete smart folder "${f.name}"${f.children.length ? ' and the smart folders inside it' : ''}`,
          changes: [
            { id: f.id, name: f.name, field: 'smart_folder', before: 'exists', after: 'deleted' },
          ],
          itemCount: 0,
          activity: `Deleting smart folder ${f.name}`,
          apply: async () => fromMutation(await call.api.deleteSmartFolder(f.id)),
        }),
      );
    },
  );

  tool(
    'save_filter',
    {
      title: 'Save filter',
      description:
        "Save search_items filters under a name (Eagle's saved filters); saving an existing name replaces its filters. search_items saved_filter uses it.",
      input: z.strictObject({
        library,
        name: z.string().trim().min(1).max(200),
        filter: z
          .record(z.string(), z.unknown())
          .describe(
            'The same filters search_items takes (query, tags, folders, rating, types, color, dates...), no paging or sort.',
          ),
        dry_run: dryRun,
      }),
      kind: 'additive',
    },
    async ({ name, filter, dry_run }, call) => {
      const lib = await writableLibrary(call);
      const parsed = FilterInput.safeParse(filter);
      if (!parsed.success)
        throw new UserError(
          `filter: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'filter'} ${i.message}`).join('; ')}`,
        );
      const spec = buildQuery(parsed.data, lib).filter;
      if (!Object.keys(spec).length)
        throw new UserError('filter is empty: give at least one filter.');
      const old = (lib.savedFilters ?? []).find(
        (f) => f.name.trim().toLowerCase() === name.toLowerCase(),
      );
      return runWrite(
        call,
        lib,
        {
          tool: 'save_filter',
          args: { name, filter: parsed.data },
          kind: 'additive',
          dryRun: dry_run,
        },
        async () => ({
          summary: old
            ? `Replace the filters of saved filter "${old.name}"`
            : `Save filter "${name}"`,
          changes:
            old && JSON.stringify(old.filter) === JSON.stringify(spec)
              ? []
              : [
                  {
                    id: old ? String(old.index) : '(new filter)',
                    name,
                    field: 'filter',
                    before: old?.filter ?? null,
                    after: spec,
                  },
                ],
          itemCount: 0,
          activity: `Saving filter ${name}`,
          emptyNote: 'That saved filter already has exactly these filters.',
          apply: async () =>
            fromMutation(
              old
                ? await call.api.updateSavedFilter(old.index, old.name, { filter: spec }, old.key)
                : await call.api.saveFilter(name, spec),
            ),
        }),
      );
    },
  );
}
