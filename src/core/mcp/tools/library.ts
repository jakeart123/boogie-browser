// Library-level read tools: what is open, folders, tags, smart folders, history.
import { z } from 'zod';
import { library } from '../schemas';
import type { LibraryState } from '../../../shared/types';
import { FolderIndex } from '../folders';
import { historyOut } from '../format';
import { type Call, iso, openLibrary, type Tool } from '../kit';

async function libraryOverview(call: Call, state: LibraryState) {
  const [counts, known] = await Promise.all([call.api.getCounts(), call.api.listLibraries()]);
  const folders = new FolderIndex(state.folders);
  const me = known.find((k) => k.path === state.ref.path);
  return {
    name: state.ref.name,
    path: state.ref.path,
    read_only: state.readOnly,
    read_only_reason: state.readOnlyReason,
    shared_with_partner: me?.shared ?? false,
    partner: me?.partnerName ?? null,
    application_version: state.applicationVersion,
    indexing: state.indexing,
    ...(state.indexing
      ? {
          hint: 'The library is still being indexed, so counts and searches may be incomplete for a moment.',
        }
      : {}),
    counts: {
      items: counts.all,
      uncategorized: counts.uncategorized,
      untagged: counts.untagged,
      in_trash: counts.trash,
    },
    folder_count: folders.list.length,
    smart_folder_count: state.smartFolders.length,
    tag_group_count: state.tagGroups.length,
    top_level_folders: state.folders.map((f) => ({
      id: f.id,
      name: f.name,
      items: counts.folders[f.id]?.own ?? 0,
      items_including_subfolders: counts.folders[f.id]?.deep ?? 0,
      subfolders: f.children.length,
    })),
  };
}

export function registerLibraryTools(tool: Tool): void {
  tool(
    'library_info',
    {
      title: 'Library info',
      description:
        'A library: whether it is read-only (and why) or shared with a partner on real Eagle, item counts and top-level folders.',
      input: z.strictObject({ library }),
      kind: 'read',
    },
    async (_args, call) => libraryOverview(call, await openLibrary(call)),
  );

  tool(
    'list_libraries',
    {
      title: 'List libraries',
      description:
        'Start here. Libraries Boogie Browser knows about; pass one as `library` to the other tools. open_in_app only says what the user is looking at.',
      input: z.strictObject({}),
      kind: 'read',
    },
    async (_args, call) => {
      const [known, state] = await Promise.all([
        call.api.listLibraries(),
        call.api.getLibraryState(),
      ]);
      return {
        libraries: known.map((k) => ({
          name: k.name,
          path: k.path,
          open_in_app: state?.ref.path === k.path,
          exists: k.exists,
          shared: k.shared,
          partner: k.partnerName,
          last_opened: iso(k.lastOpenedAt),
        })),
      };
    },
  );

  tool(
    'list_folders',
    {
      title: 'List folders',
      description:
        'The folder tree, depth first, with ids, paths ("Parent / Child"), item counts and auto-tags.',
      input: z.strictObject({
        library,
        parent: z.string().optional().describe('Only this folder and what is under it.'),
        max_depth: z.number().int().min(0).max(20).optional().describe('0 = one level.'),
      }),
      kind: 'read',
    },
    async ({ parent, max_depth }, call) => {
      const state = await openLibrary(call);
      const index = new FolderIndex(state.folders);
      const counts = await call.api.getCounts();
      const root = parent ? index.resolve(parent) : null;
      const list = index.list.filter((e) => {
        if (root && !(e.id === root.id || e.path.startsWith(root.path + ' / '))) return false;
        return max_depth === undefined || e.depth - (root?.depth ?? 0) <= max_depth;
      });
      return {
        total: list.length,
        folders: list.map((e) => ({
          id: e.id,
          name: e.name,
          path: e.path,
          parent_id: e.parentId,
          depth: e.depth,
          items: counts.folders[e.id]?.own ?? 0,
          items_including_subfolders: counts.folders[e.id]?.deep ?? 0,
          auto_tags: e.node.tags,
          ...(e.node.description ? { description: e.node.description } : {}),
        })),
      };
    },
  );

  tool(
    'list_tags',
    {
      title: 'List tags',
      description:
        'Tags with item counts, starred ones marked, and the tag groups. Check here before inventing a tag: reuse the existing spelling.',
      input: z.strictObject({
        library,
        query: z.string().optional().describe('Tags containing this text.'),
        sort: z.enum(['count', 'name']).optional(),
        starred_only: z.boolean().optional(),
        limit: z.number().int().min(1).max(2000).optional().describe('Default 200.'),
      }),
      kind: 'read',
    },
    async ({ query, sort, starred_only, limit }, call) => {
      const state = await openLibrary(call);
      const all = await call.api.listTags();
      const starred = new Set(state.starredTags ?? []);
      const q = query?.toLowerCase();
      const matching = all.filter(
        (t) => (!q || t.name.toLowerCase().includes(q)) && (!starred_only || starred.has(t.name)),
      );
      matching.sort(
        sort === 'name'
          ? (a, b) => a.name.localeCompare(b.name)
          : (a, b) => b.count - a.count || a.name.localeCompare(b.name),
      );
      const groupName = new Map(state.tagGroups.map((g) => [g.id, g.name]));
      return {
        total_tags: all.length,
        matching: matching.length,
        tags: matching.slice(0, limit ?? 200).map((t) => ({
          name: t.name,
          count: t.count,
          groups: t.groupIds.map((id) => groupName.get(id) ?? id),
          ...(starred.has(t.name) ? { starred: true } : {}),
        })),
        tag_groups: state.tagGroups.map((g) => ({
          id: g.id,
          name: g.name,
          tag_count: g.tags.length,
          ...(g.color ? { color: g.color } : {}),
        })),
      };
    },
  );

  tool(
    'list_smart_folders',
    {
      title: 'List smart folders',
      description:
        'Smart folders (with their rules and item counts) and saved filters. search_items takes either (smart_folder, saved_filter).',
      input: z.strictObject({ library }),
      kind: 'read',
    },
    async (_args, call) => {
      const state = await openLibrary(call);
      const counts = await call.api.getCounts();
      const out: { id: string; name: string; path: string; items: number; conditions: unknown }[] =
        [];
      const walk = (nodes: LibraryState['smartFolders'], prefix: string) => {
        for (const n of nodes) {
          const path = prefix ? `${prefix} / ${n.name}` : n.name;
          out.push({
            id: n.id,
            name: n.name,
            path,
            items: counts.smartFolders[n.id] ?? 0,
            conditions: n.conditions,
          });
          walk(n.children, path);
        }
      };
      walk(state.smartFolders, '');
      return {
        smart_folders: out,
        saved_filters: (state.savedFilters ?? []).map((f) => ({
          name: f.name,
          index: f.index,
          filter: f.filter,
          ...(f.unsupported.length ? { not_applied: f.unsupported } : {}),
        })),
      };
    },
  );

  tool(
    'history',
    {
      title: 'History',
      description:
        "Recent changes, newest first: yours, the user's, other agents' and the partner's. undo takes a group_id of an agent's change.",
      input: z.strictObject({
        library,
        limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
        mine_only: z.boolean().optional(),
      }),
      kind: 'read',
    },
    async ({ limit, mine_only }, call) => {
      await openLibrary(call);
      const want = limit ?? 20;
      const entries = await call.api.listHistory({ limit: mine_only ? 300 : want });
      const shown = (
        mine_only ? entries.filter((e) => e.actor.name === call.actor.name) : entries
      ).slice(0, want);
      return { entries: shown.map(historyOut) };
    },
  );
}
