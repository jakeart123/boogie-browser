// Starred tags (tags.json) and tag groups (the library's metadata.json). Both are library-wide
// lists that a running partner Eagle never re-reads and may write over, so every reply carries
// the app's warning for a shared library.
import { z } from 'zod';
import type { LibraryState, TagGroup } from '../../../shared/types';
import { type Change } from '../changes';
import { UserError } from '../errors';
import { plural, type Tool, TWO_STEP, uniq, writableLibrary } from '../kit';
import { colorOrNone, dryRun, planId, tagList } from '../schemas';
import { fromMutation, runWrite } from '../write';

const PARTNER_NOTE =
  " A partner's running Eagle only sees this after a restart and may undo it (the result says so when it applies).";

function findGroup(lib: LibraryState, ref: string): TagGroup {
  const want = ref.trim().toLowerCase();
  const hit =
    lib.tagGroups.find((g) => g.id === ref) ??
    lib.tagGroups.find((g) => g.name.trim().toLowerCase() === want);
  if (!hit) throw new UserError(`No tag group matches "${ref}". list_tags shows the tag groups.`);
  return hit;
}

const groupView = (g: Pick<TagGroup, 'name' | 'tags' | 'color'>) => ({
  name: g.name,
  tags: g.tags,
  color: g.color ?? null,
});

export function registerTagGroupTools(tool: Tool): void {
  tool(
    'star_tags',
    {
      title: 'Star tags',
      description: 'Star tags (or unstar them with starred: false), as in Eagle.' + PARTNER_NOTE,
      input: z.strictObject({ tags: tagList, starred: z.boolean().optional() }),
      kind: 'additive',
    },
    async ({ tags, starred }, call) => {
      const lib = await writableLibrary(call);
      const on = starred ?? true;
      const now = new Set(lib.starredTags ?? []);
      const names = uniq(tags).filter((t) => now.has(t) !== on);
      return runWrite(
        call,
        lib,
        { tool: 'star_tags', args: { tags: uniq(tags), starred: on }, kind: 'additive' },
        async () => ({
          summary: `${on ? 'Star' : 'Unstar'} ${plural(names.length, 'tag')}`,
          changes: names.map((t) => ({ id: t, name: t, field: 'starred', before: !on, after: on })),
          itemCount: 0,
          activity: `${on ? 'Starring' : 'Unstarring'} tags`,
          emptyNote: `Those tags are already ${on ? 'starred' : 'not starred'}.`,
          apply: async () => fromMutation(await call.api.setTagStarred(names, on)),
        }),
      );
    },
  );

  tool(
    'save_tag_group',
    {
      title: 'Save tag group',
      description:
        'Create a tag group (give name), or change one (give group: its id or name). tags replaces the list; add_tags and remove_tags edit it.' +
        PARTNER_NOTE,
      input: z.strictObject({
        group: z.string().trim().min(1).optional(),
        name: z.string().trim().min(1).max(200).optional(),
        tags: z.array(z.string().trim().min(1).max(100)).max(1000).optional(),
        add_tags: tagList.optional(),
        remove_tags: tagList.optional(),
        color: colorOrNone.optional(),
        dry_run: dryRun,
      }),
      kind: 'additive',
    },
    async ({ group, name, tags, add_tags, remove_tags, color, dry_run }, call) => {
      const lib = await writableLibrary(call);
      const old = group ? findGroup(lib, group) : null;
      if (!old && !name)
        throw new UserError('Give name to create a tag group, or group to edit one.');
      let list = tags ? uniq(tags) : (old?.tags ?? []);
      if (add_tags) list = uniq([...list, ...add_tags]);
      if (remove_tags) list = list.filter((t) => !remove_tags.includes(t));
      const next = {
        name: name ?? old!.name,
        tags: list,
        color: color === undefined ? (old?.color ?? null) : color === 'none' ? null : color,
      };
      const before = old ? groupView(old) : null;
      const same = JSON.stringify(before) === JSON.stringify(groupView(next));
      const changes: Change[] = same
        ? []
        : [
            {
              id: old?.id ?? '(new group)',
              name: next.name,
              field: 'tag_group',
              before,
              after: groupView(next),
            },
          ];
      return runWrite(
        call,
        lib,
        {
          tool: 'save_tag_group',
          args: { group: old?.id ?? null, ...next },
          kind: 'additive',
          dryRun: dry_run,
        },
        async () => ({
          summary: `${old ? 'Change' : 'Create'} tag group "${next.name}" (${plural(list.length, 'tag')})`,
          changes,
          itemCount: 0,
          activity: `Saving tag group ${next.name}`,
          emptyNote: 'The tag group already looks like that.',
          apply: async () => {
            const known = new Set(lib.tagGroups.map((g) => g.id));
            const r = await call.api.upsertTagGroup({
              ...(old ? { id: old.id, description: old.description || undefined } : {}),
              ...next,
            });
            const id =
              old?.id ??
              (await call.api.getLibraryState())?.tagGroups.find((g) => !known.has(g.id))?.id;
            return fromMutation(r, { tag_group_id: id ?? null });
          },
        }),
      );
    },
  );

  tool(
    'delete_tag_group',
    {
      title: 'Delete tag group',
      description: 'Delete a tag group (the tags themselves stay on their items).' + TWO_STEP,
      input: z.strictObject({ group: z.string().trim().min(1), plan_id: planId }),
      kind: 'changing',
    },
    async ({ group, plan_id }, call) => {
      const lib = await writableLibrary(call);
      const g = findGroup(lib, group);
      return runWrite(
        call,
        lib,
        { tool: 'delete_tag_group', args: { group: g.id }, kind: 'changing', planId: plan_id },
        async () => ({
          summary: `Delete tag group "${g.name}" (its ${plural(g.tags.length, 'tag')} stay on their items)`,
          changes: [
            { id: g.id, name: g.name, field: 'tag_group', before: groupView(g), after: null },
          ],
          itemCount: 0,
          activity: `Deleting tag group ${g.name}`,
          apply: async () => fromMutation(await call.api.deleteTagGroup(g.id)),
        }),
      );
    },
  );
}
