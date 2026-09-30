// Item read tools: search, get, get many, and the thumbnail the agent can look at.
import { z } from 'zod';
import type {
  FilterSpec,
  LibraryState,
  OrderBy,
  QueryRequest,
  SavedFilterInfo,
  Scope,
  SmartFolderNode,
} from '../../../shared/types';
import { UserError } from '../errors';
import { FolderIndex } from '../folders';
import { fullItemOut, itemOut } from '../format';
import { openLibrary, Raw, type Tool, uniq } from '../kit';
import { itemId } from '../schemas';
import { thumbnailBytes } from '../thumb';
import { getItemsInOrder } from '../write';

const SORTS: Record<string, OrderBy> = {
  imported: 'IMPORT',
  name: 'NAME',
  ext: 'EXT',
  resolution: 'RESOLUTION',
  filesize: 'FILESIZE',
  rating: 'RATING',
  duration: 'DURATION',
  created: 'BTIME',
  modified: 'MTIME',
  tag_count: 'TAGS',
};

const ids200 = z.array(itemId).min(1).max(200, 'At most 200 ids per call.');

const date = z.string().optional();

export const SearchInput = z.strictObject({
  query: z
    .string()
    .optional()
    .describe(
      'Keywords over names, tags, notes and URLs: space = AND, -word excludes, OR, "phrase", ( ).',
    ),
  tags: z.array(z.string()).optional(),
  tags_mode: z
    .enum(['all', 'any', 'exact'])
    .optional()
    .describe('all (default): every tag. any: at least one. exact: these tags and no others.'),
  exclude_tags: z.array(z.string()).optional(),
  folders: z
    .array(z.string())
    .optional()
    .describe('Folder ids, paths or names; items in any of them, subfolders included.'),
  include_subfolders: z.boolean().optional().describe('Default true.'),
  smart_folder: z.string().optional().describe('Id or name: search inside it.'),
  scope: z.enum(['all', 'uncategorized', 'untagged', 'trash']).optional().describe('Default all.'),
  rating: z
    .array(z.number().int().min(0).max(5))
    .optional()
    .describe('Allowed star values; 0 = unrated.'),
  types: z
    .array(z.string())
    .optional()
    .describe('Extensions or groups (image video audio font doc 3d). A leading - excludes.'),
  color: z.string().optional().describe('Hex like #c0392b: palette contains something close.'),
  color_tolerance: z.enum(['similar', 'close']).optional().describe('Default similar (looser).'),
  imported_after: date.describe('ISO date or date-time (a bare date covers the whole day).'),
  imported_before: date,
  modified_after: date.describe("The file's modified date (Eagle's Date modified)."),
  modified_before: date,
  min_width: z.number().int().min(1).optional(),
  min_height: z.number().int().min(1).optional(),
  has_url: z.boolean().optional(),
  has_note: z.boolean().optional(),
  url_contains: z.string().optional(),
  saved_filter: z
    .string()
    .optional()
    .describe(
      'A saved filter (name, from list_smart_folders); filters given here are added to it.',
    ),
  sort_by: z
    .enum(Object.keys(SORTS) as [string, ...string[]])
    .optional()
    .describe(
      'Default newest imported first. name and ext sort A to Z, the others biggest or newest first; ascending flips that.',
    ),
  ascending: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional().describe('Default 50.'),
  offset: z.number().int().min(0).optional(),
});

function parseDate(
  label: string,
  value: string | undefined,
  endOfDay: boolean,
): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms))
    throw new UserError(
      `${label}: "${value}" is not a date. Use ISO format like 2026-09-01 or 2026-09-01T14:30:00Z.`,
    );
  return endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? ms + 86_399_999 : ms;
}

function parseColor(value: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(value.trim());
  if (!m) throw new UserError(`color: "${value}" is not a hex color. Use something like #c0392b.`);
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function findSmartFolder(state: LibraryState, ref: string): SmartFolderNode {
  const flat: SmartFolderNode[] = [];
  const walk = (nodes: SmartFolderNode[]) => nodes.forEach((n) => (flat.push(n), walk(n.children)));
  walk(state.smartFolders);
  const hit =
    flat.find((n) => n.id === ref) ??
    flat.filter((n) => n.name.toLowerCase() === ref.trim().toLowerCase())[0];
  if (!hit)
    throw new UserError(
      `No smart folder matches "${ref}". Use list_smart_folders for ids and names.`,
    );
  return hit;
}

/** Turn the friendly search arguments into the app's QueryRequest. Exported for tests. */
export function buildQuery(a: z.infer<typeof SearchInput>, state: LibraryState): QueryRequest {
  const folders = new FolderIndex(state.folders);
  const f: FilterSpec = {};
  if (a.query?.trim()) f.keywords = a.query.trim();
  if (a.tags?.length || a.exclude_tags?.length)
    f.tags = { mode: a.tags_mode ?? 'all', include: a.tags ?? [], exclude: a.exclude_tags ?? [] };
  if (a.folders?.length) {
    const picked = folders.resolveAll(a.folders);
    f.folders = {
      include: uniq(
        picked.flatMap((e) => (a.include_subfolders === false ? [e.id] : folders.subtreeIds(e.id))),
      ),
      exclude: [],
    };
  }
  if (a.color) f.color = { rgb: parseColor(a.color), tolerance: a.color_tolerance ?? 'similar' };
  if (a.rating?.length) f.rating = a.rating;
  if (a.types?.length) {
    const exclude = a.types.filter((t) => t.startsWith('-')).map((t) => t.slice(1));
    f.types = { include: a.types.filter((t) => !t.startsWith('-')), exclude };
  }
  const imported = {
    min: parseDate('imported_after', a.imported_after, false),
    max: parseDate('imported_before', a.imported_before, true),
  };
  if (imported.min !== undefined || imported.max !== undefined) f.importedAt = imported;
  const modified = {
    min: parseDate('modified_after', a.modified_after, false),
    max: parseDate('modified_before', a.modified_before, true),
  };
  if (modified.min !== undefined || modified.max !== undefined) f.modifiedAt = modified;
  if (a.min_width) f.width = { min: a.min_width };
  if (a.min_height) f.height = { min: a.min_height };
  if (a.has_url !== undefined) f.hasUrl = a.has_url;
  if (a.has_note !== undefined) f.hasNote = a.has_note;
  if (a.url_contains) f.urlContains = a.url_contains;

  const saved = a.saved_filter ? findSavedFilter(state, a.saved_filter) : null;
  const filter: FilterSpec = saved ? { ...saved.filter, ...f } : f;

  const scope: Scope = a.smart_folder
    ? { kind: 'smartFolder', id: findSmartFolder(state, a.smart_folder).id }
    : { kind: a.scope ?? 'all' };
  const sort = a.sort_by
    ? {
        by: SORTS[a.sort_by],
        ascending: a.ascending ?? (a.sort_by === 'name' || a.sort_by === 'ext'),
      }
    : a.ascending !== undefined
      ? { by: 'IMPORT' as OrderBy, ascending: a.ascending }
      : null;
  return { scope, filter, sort };
}

/** A saved filter by name (or its position, as list_smart_folders shows it). */
function findSavedFilter(state: LibraryState, ref: string): SavedFilterInfo {
  const list = state.savedFilters ?? [];
  const want = ref.trim().toLowerCase();
  const hit =
    list.find((f) => f.name.trim().toLowerCase() === want) ??
    list.find((f) => String(f.index) === want);
  if (!hit)
    throw new UserError(
      `No saved filter matches "${ref}". list_smart_folders shows the saved filters.`,
    );
  return hit;
}

export function registerItemTools(tool: Tool): void {
  tool(
    'search_items',
    {
      title: 'Search items',
      description:
        'Find items; every filter given must match. Returns compact items (note cut to 300 characters) and the total, for paging. The trash is left out unless scope is "trash".',
      input: SearchInput,
      kind: 'read',
    },
    async (args, call) => {
      const state = await openLibrary(call);
      const result = await call.api.query(buildQuery(args, state));
      const offset = args.offset ?? 0;
      const ids = result.ids.slice(offset, offset + (args.limit ?? 50));
      const folders = new FolderIndex(state.folders);
      const { items } = await getItemsInOrder(call.api, ids);
      return {
        total: result.total,
        offset,
        returned: items.length,
        has_more: offset + items.length < result.total,
        ...(state.indexing
          ? {
              warning: `The library is still being indexed (${state.indexing.done} of ${state.indexing.total}), so results may be incomplete. Try again in a moment.`,
            }
          : {}),
        items: items.map((i) => itemOut(i, folders)),
      };
    },
  );

  tool(
    'get_item',
    {
      title: 'Get item',
      description:
        'Everything about one item: full note, colors, comments, dates, and file_path (the original on disk; read-only for you).',
      input: z.strictObject({ id: itemId }),
      kind: 'read',
    },
    async ({ id }, call) => {
      const state = await openLibrary(call);
      const item = await call.api.getItem(id);
      if (!item) throw new UserError(`No item with id ${id} in the open library.`);
      return { item: fullItemOut(item, new FolderIndex(state.folders)) };
    },
  );

  tool(
    'get_items',
    {
      title: 'Get items',
      description:
        'Up to 200 items by id, as search_items shows them but with the full note. Unknown ids come back in `missing`.',
      input: z.strictObject({ ids: ids200 }),
      kind: 'read',
    },
    async ({ ids }, call) => {
      const state = await openLibrary(call);
      const wanted = uniq(ids);
      const { items, missing } = await getItemsInOrder(call.api, wanted);
      const folders = new FolderIndex(state.folders);
      return { items: items.map((i) => itemOut(i, folders, Infinity)), missing };
    },
  );

  tool(
    'get_thumbnail',
    {
      title: 'Get thumbnail',
      description: 'Look at an item: its thumbnail as an image (under 1 MB).',
      input: z.strictObject({ id: itemId }),
      kind: 'read',
    },
    async ({ id }, call) => {
      const state = await openLibrary(call);
      const item = await call.api.getItem(id);
      if (!item) throw new UserError(`No item with id ${id} in the open library.`);
      const { data, mime } = await thumbnailBytes(call, state.ref.id, item);
      const dims = item.width && item.height ? `, ${item.width}x${item.height}` : '';
      return new Raw({
        content: [
          { type: 'text', text: `${item.name}.${item.ext}${dims}` },
          { type: 'image', data: data.toString('base64'), mimeType: mime },
        ],
      });
    },
  );
}
