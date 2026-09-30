// Eagle API v2 routes for tags, tag groups and smart folders (research/format-notes/
// api-and-plugins.md §3.2). Writes are attributed to the caller like every other API write.
// Tag groups live in the library's root metadata.json, which a running partner Eagle never
// re-reads and may overwrite; Eagle's API has no way to say so, so the reply stays Eagle's shape.
import type { SmartFolderNode, TagGroup } from '../../shared/types';
import type { Ctx, Handler, Req, RouteTable } from './context';
import { needLibrary, reader, tagObjects, writer } from './context';
import { eagleSmartFolder, eagleTagGroup } from './shapes';
import { checkConditions } from './smartRules';
import { HttpError, bool, colorArg, list, paged, str, tagList } from './util';

/** Smart folders, depth first, with their parent's id. */
export function flatSmartFolders(
  nodes: SmartFolderNode[],
  parent: string | null = null,
  out: { node: SmartFolderNode; parent: string | null }[] = [],
) {
  for (const node of nodes) {
    out.push({ node, parent });
    flatSmartFolders(node.children, node.id, out);
  }
  return out;
}

/** `conditions` as JSON (or a JSON string from a form), checked like Eagle's API checks them. */
function conditionsArg(v: unknown) {
  let raw = v;
  if (typeof v === 'string') {
    try {
      raw = JSON.parse(v);
    } catch {
      throw new HttpError(400, 'conditions must be JSON.');
    }
  }
  try {
    return checkConditions(raw);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

/**
 * Library-wide renames and removals: one call rewrites many items or drops a whole list. Eagle's
 * browser extension never sends these, and any other installed extension could, so only local
 * clients (no Origin) may.
 */
const localOnly =
  (h: Handler): Handler =>
  (r) => {
    if (r.fromExtension)
      throw new HttpError(
        403,
        'Browser extensions cannot rename, merge or remove tags, tag groups or smart folders.',
      );
    return h(r);
  };

export function v2OrganizeRoutes(ctx: Ctx): RouteTable {
  const api = reader(ctx);

  // ── tags ──
  const recentTags = async (r: Req) => paged((await tagObjects(ctx)).recent(), r.args);
  const starredTags = async (r: Req) => paged((await tagObjects(ctx)).starred(), r.args);

  const tagUpdate = async (r: Req) => {
    const from = str(r.args.originalName);
    const to = str(r.args.name);
    if (!from || !to) throw new HttpError(400, 'originalName and name are required.');
    if (!(await api.listTags()).some((t) => t.name === from)) return undefined; // Eagle: nothing
    if (from !== to) await writer(ctx, r).renameTag(from, to);
    return (await tagObjects(ctx)).byName.get(to);
  };

  const tagMerge = async (r: Req) => {
    const source = str(r.args.source);
    const target = str(r.args.target);
    if (!source || !target) throw new HttpError(400, 'source and target are required.');
    if (source === target) throw new HttpError(400, 'source and target must differ.');
    const names = new Set((await api.listTags()).map((t) => t.name));
    for (const n of [source, target])
      if (!names.has(n)) throw new HttpError(400, `Tag does not exist: ${n}`);
    const scope = { kind: 'tag' as const, name: source };
    const affected = (await api.query({ scope, filter: {}, sort: null })).total;
    await writer(ctx, r).renameTag(source, target); // renaming onto a tag merges
    return { affectedItems: affected, sourceRemoved: true };
  };

  // ── tag groups ──
  const groups = async (): Promise<TagGroup[]> => (await needLibrary(ctx)).tagGroups;
  const groupOr404 = async (id: string | undefined): Promise<TagGroup> => {
    if (!id) throw new HttpError(400, 'id is required.');
    const g = (await groups()).find((x) => x.id === id);
    if (!g) throw new HttpError(404, 'Tag group does not exist.');
    return g;
  };
  const groupNow = async (id: string) => {
    const g = (await groups()).find((x) => x.id === id);
    return g ? eagleTagGroup(g) : undefined;
  };
  /** Save a group whole (the core replaces it by id). An empty description is only written when
   * asked for, so a group that never had one doesn't gain the key. */
  const save = async (r: Req, g: TagGroup, description?: string) => {
    const desc = description ?? (g.description || undefined);
    await writer(ctx, r).upsertTagGroup({
      id: g.id,
      name: g.name,
      tags: g.tags,
      color: g.color,
      ...(desc !== undefined ? { description: desc } : {}),
    });
    return groupNow(g.id);
  };

  const groupCreate = async (r: Req) => {
    const a = r.args;
    const name = str(a.name);
    if (!name) throw new HttpError(400, 'name is required.');
    const before = new Set((await groups()).map((g) => g.id));
    await writer(ctx, r).upsertTagGroup({
      name,
      tags: tagList(a.tags),
      color: colorArg(a, 'color') ?? null,
      ...(typeof a.description === 'string' ? { description: a.description } : {}),
    });
    const made = (await groups()).find((g) => !before.has(g.id));
    return made ? eagleTagGroup(made) : undefined;
  };

  const groupUpdate = async (r: Req) => {
    const a = r.args;
    const g = await groupOr404(str(a.id));
    const color = colorArg(a, 'color');
    return save(
      r,
      {
        ...g,
        name: str(a.name) ?? g.name,
        tags: Array.isArray(a.tags) ? tagList(a.tags) : g.tags,
        color: color === undefined ? g.color : color,
      },
      typeof a.description === 'string' ? a.description : undefined,
    );
  };

  const groupRemove = async (r: Req) => {
    const id = str(r.args.id);
    if (!id) throw new HttpError(400, 'id is required.');
    if (!(await groups()).some((g) => g.id === id)) return false;
    await writer(ctx, r).deleteTagGroup(id);
    return true;
  };

  const groupAddTags = async (r: Req) => {
    const a = r.args;
    const g = await groupOr404(str(a.groupId));
    const add = tagList(a.tags);
    if (bool(a.removeFromSource)) {
      // Move, not copy: take the tags out of every other group first.
      for (const other of await groups()) {
        if (other.id === g.id || !other.tags.some((t) => add.includes(t))) continue;
        await save(r, { ...other, tags: other.tags.filter((t) => !add.includes(t)) });
      }
    }
    return save(r, { ...g, tags: [...new Set([...g.tags, ...add])] });
  };

  const groupRemoveTags = async (r: Req) => {
    const a = r.args;
    const g = await groupOr404(str(a.groupId));
    const drop = new Set(tagList(a.tags));
    return save(r, { ...g, tags: g.tags.filter((t) => !drop.has(t)) });
  };

  // ── smart folders ──
  const smartIndex = async () => flatSmartFolders((await needLibrary(ctx)).smartFolders);
  const smartNow = async (id: string) => {
    const hit = (await smartIndex()).find((e) => e.node.id === id);
    return hit ? eagleSmartFolder(hit.node) : undefined;
  };

  const smartGet = async (r: Req) => {
    const ids = [...list(r.args.id), ...list(r.args.ids)];
    const all = await smartIndex();
    const nodes = ids.length
      ? ids.map((id) => all.find((e) => e.node.id === id)?.node).filter((n) => !!n)
      : (await needLibrary(ctx)).smartFolders;
    return paged(nodes.map(eagleSmartFolder), r.args);
  };

  const smartCreate = async (r: Req) => {
    const a = r.args;
    const name = str(a.name);
    if (!name) throw new HttpError(400, 'name is required.');
    const conditions = conditionsArg(a.conditions);
    const parent = str(a.parent) ?? null;
    if (parent && !(await smartIndex()).some((e) => e.node.id === parent))
      throw new HttpError(400, 'Parent smart folder does not exist.');
    const color = colorArg(a, 'iconColor');
    const { id } = await writer(ctx, r).createSmartFolder(name, conditions, parent, {
      ...(color ? { iconColor: color } : {}),
    });
    return smartNow(id);
  };

  const smartUpdate = async (r: Req) => {
    const a = r.args;
    const id = str(a.id);
    if (!id) throw new HttpError(400, 'id is required.');
    if (!(await smartIndex()).some((e) => e.node.id === id))
      throw new HttpError(404, 'Smart folder does not exist.');
    const patch: Parameters<ReturnType<typeof writer>['updateSmartFolder']>[1] = {};
    const name = str(a.name);
    if (name) patch.name = name;
    if (a.conditions !== undefined) patch.conditions = conditionsArg(a.conditions);
    const color = colorArg(a, 'iconColor');
    if (color !== undefined) patch.iconColor = color;
    if (Object.keys(patch).length) await writer(ctx, r).updateSmartFolder(id, patch);
    return smartNow(id);
  };

  const smartRemove = async (r: Req) => {
    const id = str(r.args.id);
    if (!id) throw new HttpError(400, 'id is required.');
    if (!(await smartIndex()).some((e) => e.node.id === id)) return false;
    await writer(ctx, r).deleteSmartFolder(id);
    return true;
  };

  const both = (h: (r: Req) => Promise<unknown>) => ({ GET: h, POST: h });
  return {
    '/api/v2/tag/getRecentTags': { GET: recentTags },
    '/api/v2/tag/getStarredTags': { GET: starredTags },
    '/api/v2/tag/update': { POST: localOnly(tagUpdate) },
    '/api/v2/tag/merge': { POST: localOnly(tagMerge) },
    '/api/v2/tagGroup/get': {
      GET: async (r) => paged((await groups()).map(eagleTagGroup), r.args),
    },
    '/api/v2/tagGroup/create': { POST: groupCreate },
    '/api/v2/tagGroup/update': { POST: groupUpdate },
    '/api/v2/tagGroup/remove': { POST: localOnly(groupRemove) },
    '/api/v2/tagGroup/addTags': { POST: groupAddTags },
    '/api/v2/tagGroup/removeTags': { POST: groupRemoveTags },
    '/api/v2/smartFolder/get': both(smartGet),
    '/api/v2/smartFolder/create': { POST: smartCreate },
    '/api/v2/smartFolder/update': { POST: smartUpdate },
    '/api/v2/smartFolder/remove': { POST: localOnly(smartRemove) },
  };
}
