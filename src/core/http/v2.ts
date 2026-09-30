// Eagle API v2 (`/api/v2/...`) on port 41595: app, library, item, folder and tag routes here,
// tag groups and smart folders in v2organize.ts. Left out: item comments (Boogie doesn't edit
// comments), smartFolder/getRules and aiSearch. Lists use v2's `{data, total, offset, limit}` envelope. GET values arrive as text, so the readers are lenient
// (comma lists and JSON arrays work where Eagle only takes arrays on POST).
//
// Not applied by item/update, on purpose: `ext`, `width`, `height`, `modificationTime`,
// `noThumbnail`, `noPreview` (they come from the file itself), and v2's folder/update traps
// (a missing iconColor or parent does NOT clear the color or move the folder to the root).
import type { CoreApi } from '../../shared/api';
import type {
  FilterSpec,
  FolderNode,
  FolderPatch,
  ImportEntry,
  ItemPatch,
  Scope,
  Shape,
  SortSpec,
} from '../../shared/types';
import {
  bookmarkEntry,
  bytesEntry,
  checkFile,
  checkSourceUrl,
  decodeImageData,
  pathEntry,
  pickFolders,
  readSpec,
  settle,
  startAdd,
  urlEntry,
} from './add';
import type { Ctx, Req, RouteTable } from './context';
import { needLibrary, reader, remember, requireFolder, writer } from './context';
import {
  appInfoV2,
  eagleFolder,
  eagleItem,
  eagleTags,
  indexFolders,
  libraryInfo,
  project,
} from './shapes';
import type { Args } from './util';
import { HttpError, bool, colorArg, list, num, pageArgs, paged, str, tagList } from './util';
import { loadItems, normExt, openLibraryAt, quote, readLibraryIcon, sortOf } from './v1';
import { flatSmartFolders, v2OrganizeRoutes } from './v2organize';
const NEWEST_FIRST: SortSpec = { by: 'IMPORT', ascending: false };

function shapesOf(v: string): Shape[] {
  // A panoramic image still counts as landscape or portrait.
  if (v === 'landscape') return ['landscape', 'panoramic-landscape'];
  if (v === 'portrait') return ['portrait', 'panoramic-portrait'];
  return [v as Shape];
}

export function v2Routes(ctx: Ctx): RouteTable {
  const api: CoreApi = reader(ctx);
  const page = <T>(all: T[], a: Args) => paged(all, a);

  // ── items ──
  const both = (h: (r: Req) => Promise<unknown>) => ({ GET: h, POST: h });

  const itemGet = async (r: Req) => {
    const a = r.args;
    if (bool(a.isSelected)) return page([], a); // there is no "selected" outside the UI
    const fields = list(a.fields);
    const filter: FilterSpec = {};
    const kw = list(a.keywords);
    if (kw.length) filter.keywords = kw.map(quote).join(' ');
    const tags = list(a.tags);
    if (tags.length) filter.tags = { mode: 'all', include: tags, exclude: [] };
    const ext = str(a.ext);
    if (ext) filter.types = { include: [normExt(ext)], exclude: [] };
    if (typeof a.annotation === 'string' && a.annotation) filter.noteContains = a.annotation;
    const url = str(a.url);
    if (url) filter.urlContains = url;
    const shape = str(a.shape);
    if (shape) filter.shapes = shapesOf(shape);
    const rating = num(a.rating);
    if (rating !== undefined) filter.rating = [rating];
    const run = async (scope: Scope) =>
      (await api.query({ scope, filter, sort: NEWEST_FIRST })).ids;

    const asked = [...list(a.id), ...list(a.ids)].slice(0, 1000);
    if (asked.length) {
      // Explicit ids: trashed items are left out, like Eagle. Small enough to load them all.
      const items = (await loadItems(api, await run({ kind: 'ids', ids: asked }))).filter(
        (it) => !it.isDeleted,
      );
      const p = pageArgs(a);
      return {
        data: items
          .slice(p.offset, p.offset + p.limit)
          .map((it) => project(eagleItem(it, true), fields)),
        total: items.length,
        ...p,
      };
    }

    const required: Scope[] = [];
    if (bool(a.isUnfiled)) required.push({ kind: 'uncategorized' });
    if (bool(a.isUntagged)) required.push({ kind: 'untagged' });
    for (const id of list(a.folders))
      required.push({ kind: 'folder', id, includeSubfolders: false });
    const smart = list(a.smartFolders);
    let ids: string[];
    if (smart.length)
      ids = [
        ...new Set((await Promise.all(smart.map((id) => run({ kind: 'smartFolder', id })))).flat()),
      ];
    else ids = await run(required.shift() ?? { kind: 'all' });
    // Eagle's folders[] and tags[] mean "all of these", so each further scope narrows the list.
    for (const scope of required) {
      const keep = new Set(await run(scope));
      ids = ids.filter((id) => keep.has(id));
    }
    return itemPage(ids, a, fields);
  };

  const itemPage = async (ids: string[], a: Args, fields: string[]) => {
    const p = pageArgs(a);
    const items = await loadItems(api, ids.slice(p.offset, p.offset + p.limit));
    return {
      data: items.map((it) => project(eagleItem(it, true), fields)),
      total: ids.length,
      ...p,
    };
  };

  const itemQuery = async (r: Req) => {
    const q = str(r.args.query);
    const filter: FilterSpec = q ? { keywords: q } : {};
    const ids = (await api.query({ scope: { kind: 'all' }, filter, sort: NEWEST_FIRST })).ids;
    return itemPage(ids, r.args, list(r.args.fields));
  };

  const itemUpdate = async (r: Req) => {
    const a = r.args;
    const id = str(a.id);
    if (!id) throw new HttpError(400, 'id is required.');
    if (!(await api.getItem(id))) return false;
    const patch: ItemPatch = {};
    const name = str(a.name);
    if (name) patch.name = name;
    if (typeof a.annotation === 'string') patch.annotation = a.annotation;
    if (typeof a.url === 'string') patch.url = a.url;
    if (Array.isArray(a.tags)) patch.setTags = tagList(a.tags);
    if (Array.isArray(a.folders)) {
      const wanted = list(a.folders);
      const known = indexFolders((await needLibrary(ctx)).folders);
      const bad = wanted.find((f) => !known.has(f));
      if (bad) throw new HttpError(400, `Folder does not exist: ${bad}`);
      patch.setFolders = wanted;
    }
    const star = num(a.star);
    if (star !== undefined && star >= 0 && star <= 5) patch.star = Math.round(star);
    const w = writer(ctx, r);
    if (Object.keys(patch).length) await w.updateItems([id], patch);
    const gone = bool(a.isDeleted);
    if (gone === true) await w.trashItems([id]);
    else if (gone === false) await w.restoreItems([id]);
    const now = await api.getItem(id);
    return now ? eagleItem(now, true) : false;
  };

  /** One checked add. A batch checks every entry before any of it starts. */
  const addEntry = async (r: Req, o: Args, fallback: Args): Promise<ImportEntry> => {
    const spec = readSpec(o);
    const folders = await pickFolders(ctx, { folderIds: o.folders ?? fallback.folders });
    const bookmark = str(o.bookmarkURL);
    const image = str(o.base64);
    const url = str(o.url);
    const path = str(o.path);
    if (bookmark) {
      const host = checkSourceUrl(bookmark).hostname;
      return bookmarkEntry(bookmark, spec.name ?? (host || bookmark), spec, folders);
    }
    if (image) {
      // Eagle takes a full data URL here; bare base64 is fine too.
      if (image.startsWith('data:')) return urlEntry(r, image, spec, folders);
      const { bytes, ext } = decodeImageData(image);
      return bytesEntry(bytes, `${spec.name ?? 'image'}.${ext}`, spec, folders);
    }
    if (url) return urlEntry(r, url, spec, folders);
    if (path) return pathEntry(r, path, spec, folders);
    throw new HttpError(400, 'One of url, path, base64 or bookmarkURL is required.');
  };

  const itemAdd = async (r: Req) => {
    const a = r.args;
    if (Array.isArray(a.items)) {
      if (!a.items.length || a.items.length > 1000)
        throw new HttpError(400, 'items must hold 1 to 1000 entries.');
      const entries: ImportEntry[] = [];
      for (const it of a.items as unknown[])
        entries.push(await addEntry(r, (it && typeof it === 'object' ? it : {}) as Args, a));
      const ids = await settle(ctx, await startAdd(ctx, r, entries));
      return { ids: ids ?? entries.map(() => null) };
    }
    const ids = await settle(ctx, await startAdd(ctx, r, [await addEntry(r, a, a)]));
    // Eagle lets the caller choose the id; the core picks ids itself, so this is the real one.
    return { id: ids?.[0] ?? null };
  };

  // ── folders ──
  const folderV2 = async (id: string) => {
    const idx = indexFolders((await needLibrary(ctx)).folders);
    const f = idx.get(id);
    return f ? eagleFolder(f.node, { v2: true, parent: f.parent }) : undefined;
  };

  const folderGet = async (r: Req) => {
    const a = r.args;
    const st = await needLibrary(ctx);
    const idx = indexFolders(st.folders);
    const ids = [...list(a.id), ...list(a.ids)];
    let nodes: FolderNode[];
    if (ids.length) nodes = ids.map((id) => idx.get(id)?.node).filter((n): n is FolderNode => !!n);
    else if (bool(a.isRecent)) {
      nodes = ctx.recentFolders.map((id) => idx.get(id)?.node).filter((n): n is FolderNode => !!n);
      for (const top of st.folders) if (nodes.length < 16 && !nodes.includes(top)) nodes.push(top);
    } else if (bool(a.isSelected)) nodes = [];
    else nodes = st.folders; // no filter: the top level, children nested
    return page(
      nodes.map((n) => eagleFolder(n, { v2: true, parent: idx.get(n.id)?.parent ?? null })),
      a,
    );
  };

  const folderCreate = async (r: Req) => {
    const a = r.args;
    const name = str(a.name);
    if (!name) throw new HttpError(400, 'name is required.');
    const parent = str(a.parent) ?? null;
    if (parent) await requireFolder(ctx, parent);
    const color = colorArg(a, 'iconColor');
    const w = writer(ctx, r);
    const { id } = await w.createFolder(name, parent, color ? { iconColor: color } : undefined);
    remember(ctx.recentFolders, [id]);
    const patch: FolderPatch = {};
    if (typeof a.description === 'string' && a.description) patch.description = a.description;
    if (Array.isArray(a.tags)) patch.tags = tagList(a.tags);
    if (Object.keys(patch).length) await w.updateFolder(id, patch);
    return folderV2(id);
  };

  const folderUpdate = async (r: Req) => {
    const a = r.args;
    const id = str(a.id);
    if (!id) throw new HttpError(400, 'id is required.');
    const st = await requireFolder(ctx, id);
    const idx = indexFolders(st.folders);
    const patch: FolderPatch = {};
    const name = str(a.name);
    if (name) patch.name = name;
    if (typeof a.description === 'string') patch.description = a.description;
    if (Array.isArray(a.tags)) patch.tags = tagList(a.tags);
    const color = colorArg(a, 'iconColor');
    if (color !== undefined) patch.iconColor = color;
    const w = writer(ctx, r);
    if (Object.keys(patch).length) await w.updateFolder(id, patch);
    if ('parent' in a) {
      const parent = str(a.parent) ?? null;
      if (parent && !idx.has(parent)) throw new HttpError(404, 'Parent folder does not exist.');
      // A folder can't go inside itself or its own subfolders.
      for (let p: string | null = parent; p; p = idx.get(p)?.parent ?? null) {
        if (p === id) throw new HttpError(400, 'A folder cannot be moved into itself.');
      }
      if ((idx.get(id)?.parent ?? null) !== parent) {
        const end = parent ? (idx.get(parent)?.node.children.length ?? 0) : st.folders.length;
        await w.moveFolder(id, parent, end);
      }
    }
    return folderV2(id);
  };

  // ── thumbnails ──
  const itemOr404 = async (id: string | undefined) => {
    if (!id) throw new HttpError(400, 'itemId is required.');
    if (!(await api.getItem(id))) throw new HttpError(404, 'File does not exist.');
    return id;
  };
  const setThumbnail = async (r: Req) => {
    const id = await itemOr404(str(r.args.itemId));
    const file = str(r.args.filePath);
    if (!file) throw new HttpError(400, 'filePath is required.');
    await checkFile(r, file);
    await writer(ctx, r).setCustomThumbnail(id, file);
    return true;
  };
  const refreshThumbnail = async (r: Req) => {
    const id = await itemOr404(str(r.args.itemId));
    return (await writer(ctx, r).refreshThumbnails([id])).changed > 0;
  };

  // ── smart folder items ──
  const smartItems = async (r: Req) => {
    const a = r.args;
    const id = str(a.smartFolderId);
    if (!id) throw new HttpError(400, 'smartFolderId is required.');
    const st = await needLibrary(ctx);
    if (!flatSmartFolders(st.smartFolders).some((e) => e.node.id === id))
      throw new HttpError(404, 'Smart folder does not exist.');
    const q = {
      scope: { kind: 'smartFolder' as const, id },
      filter: {},
      sort: sortOf(str(a.orderBy)),
    };
    return itemPage((await api.query(q)).ids, a, list(a.fields));
  };

  const tagGet = async (r: Req) => {
    const [tags, st] = await Promise.all([api.listTags(), needLibrary(ctx)]);
    const needle = str(r.args.name)?.toLowerCase();
    const objects = eagleTags(tags, st.tagGroups).filter(
      (t) => !needle || String(t.name).toLowerCase().includes(needle),
    );
    return page(objects, r.args);
  };

  return {
    ...v2OrganizeRoutes(ctx),
    '/api/v2/app/info': { GET: () => appInfoV2() },
    '/api/v2/library/info': { GET: async () => libraryInfo(await needLibrary(ctx), true) },
    '/api/v2/library/history': {
      GET: async (r) =>
        page(
          (await api.listLibraries()).filter((l) => l.exists).map((l) => l.path),
          r.args,
        ),
    },
    '/api/v2/library/switch': {
      POST: (r) => openLibraryAt(ctx, str(r.args.libraryPath)).then(() => true),
    },
    // Eagle's v2 sends the icon as a JSON-serialized Node Buffer: {"type":"Buffer","data":[...]}.
    '/api/v2/library/icon': {
      GET: async (r) => (await readLibraryIcon(ctx, str(r.args.libraryPath))).toJSON(),
    },
    '/api/v2/item/get': both(itemGet),
    '/api/v2/item/query': { POST: itemQuery },
    // Live items only: the number the "All" view shows.
    '/api/v2/item/countAll': { GET: async () => (await api.getCounts()).all },
    '/api/v2/item/update': { POST: itemUpdate },
    '/api/v2/item/add': { POST: itemAdd },
    '/api/v2/item/setCustomThumbnail': { POST: setThumbnail },
    '/api/v2/item/refreshThumbnail': { POST: refreshThumbnail },
    '/api/v2/smartFolder/getItems': both(smartItems),
    '/api/v2/folder/get': both(folderGet),
    '/api/v2/folder/create': { POST: folderCreate },
    '/api/v2/folder/update': { POST: folderUpdate },
    '/api/v2/tag/get': both(tagGet),
  };
}
