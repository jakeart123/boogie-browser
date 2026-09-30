// Eagle API v1 (`/api/...`) plus the "copy link" pages, on port 41595. Argument names and reply
// shapes follow Eagle's (research/format-notes/api-and-plugins.md §2). Deliberately NOT here:
// /api/script/inject (runs arbitrary JS), /api/check (fetches and injects remote script) and
// /api/folder/unlock (we never hand out or accept folder passwords).
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { CoreApi } from '../../shared/api';
import type {
  FilterSpec,
  FolderPatch,
  ImportEntry,
  Item,
  ItemPatch,
  OrderBy,
  SortSpec,
} from '../../shared/types';
import {
  bookmarkEntry,
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
import type { Ctx, OpenTarget, Req, RouteTable } from './context';
import { needLibrary, reader, remember, requireFolder, tagObjects, writer } from './context';
import {
  appInfo,
  eagleFolder,
  eagleItem,
  indexFolders,
  libraryInfo,
  eagleTagGroup,
} from './shapes';
import type { Args } from './util';
import { HttpError, Reply, colorArg, list, num, str, tagList } from './util';

const MISSING = 'Missing required parameters.';

function tooMany(n: number): void {
  if (n > 1000) throw new HttpError(400, 'Too many items in one request (max 1000).');
}

/** Items by id, in the order asked. Chunked so a huge list is not one giant call. */
export async function loadItems(api: CoreApi, ids: string[]): Promise<Item[]> {
  const byId = new Map<string, Item>();
  for (let i = 0; i < ids.length; i += 1000) {
    for (const it of await api.getItems(ids.slice(i, i + 1000))) byId.set(it.id, it);
  }
  return ids.map((id) => byId.get(id)).filter((it): it is Item => !!it);
}

async function requireItem(api: CoreApi, id: string | undefined): Promise<Item> {
  if (!id) throw new HttpError(400, MISSING);
  const it = await api.getItem(id);
  if (!it) throw new HttpError(404, 'File does not exist.');
  return it;
}

/** Eagle's orderBy names, with the `-` prefix that reverses. `CREATEDATE` (also the default) is
 * newest first, like Eagle's own sort; the others start ascending. */
const ORDER: Record<string, [OrderBy, boolean]> = {
  CREATEDATE: ['IMPORT', false],
  IMPORT: ['IMPORT', false],
  FILESIZE: ['FILESIZE', true],
  NAME: ['NAME', true],
  RESOLUTION: ['RESOLUTION', true],
  RATING: ['RATING', true],
  EXT: ['EXT', true],
  DURATION: ['DURATION', true],
  BTIME: ['BTIME', false],
  MTIME: ['MTIME', false],
  TAGS: ['TAGS', true],
};

export function sortOf(orderBy: string | undefined): SortSpec {
  const s = (orderBy ?? 'CREATEDATE').trim();
  const reverse = s.includes('-');
  const [by, ascending] = ORDER[s.replace('-', '').toUpperCase()] ?? ORDER.CREATEDATE;
  return { by, ascending: reverse ? !ascending : ascending };
}

export const quote = (s: string) => `"${s.replace(/"/g, '')}"`;
export const normExt = (e: string) => {
  const x = e.toLowerCase().replace(/^\./, '');
  return x === 'jpeg' ? 'jpg' : x;
};

/** `library/icon`: the icon.png of a library Boogie knows (never an arbitrary path's). */
export async function readLibraryIcon(ctx: Ctx, path: string | undefined): Promise<Buffer> {
  const known = path
    ? (await ctx.host.api.listLibraries()).find((l) => resolve(l.path) === resolve(path))
    : undefined;
  if (!known) throw new HttpError(404, 'Library does not exist.');
  try {
    return await readFile(join(known.path, 'icon.png'));
  } catch {
    throw new HttpError(404, 'Library icon does not exist.');
  }
}

/** `library/switch`: open the library at an absolute path. */
export async function openLibraryAt(ctx: Ctx, path: string | undefined): Promise<void> {
  if (!path) throw new HttpError(400, MISSING);
  const isDir =
    isAbsolute(path) &&
    (await stat(path).then(
      (s) => s.isDirectory(),
      () => false,
    ));
  if (!isDir) throw new HttpError(400, 'Library does not exist.');
  // Anything the core refuses here (not a library, a root it can't read) is the caller's path.
  await ctx.host.api.openLibrary(path).catch((e: unknown) => {
    throw new HttpError(400, (e as Error).message);
  });
}

export function v1Routes(ctx: Ctx): RouteTable {
  const api = reader(ctx);

  // ── library ──
  const libraryIcon = async (r: Req) =>
    new Reply(200, await readLibraryIcon(ctx, str(r.args.libraryPath)), {
      'Content-Type': 'image/png',
    });
  const switchLibrary = (r: Req) => openLibraryAt(ctx, str(r.args.libraryPath));

  // ── folders ──
  const folderObject = async (id: string) => {
    const st = await needLibrary(ctx);
    const found = indexFolders(st.folders).get(id);
    return found ? eagleFolder(found.node, { api: true }) : undefined;
  };

  const listRecentFolders = async () => {
    const st = await needLibrary(ctx);
    const idx = indexFolders(st.folders);
    const out = ctx.recentFolders.map((id) => idx.get(id)?.node).filter((n) => !!n);
    // Pad from the top of the tree, like Eagle does when few folders were used lately.
    for (const top of st.folders) if (out.length < 16 && !out.includes(top)) out.push(top);
    return out.slice(0, 16).map((n) => eagleFolder(n, { api: true }));
  };

  const createFolder = async (r: Req) => {
    const name = str(r.args.folderName);
    if (!name) throw new HttpError(400, MISSING);
    const parent = str(r.args.parent) ?? null;
    if (parent) await requireFolder(ctx, parent);
    const { id } = await writer(ctx, r).createFolder(name, parent);
    remember(ctx.recentFolders, [id]);
    const made = indexFolders((await needLibrary(ctx)).folders).get(id)?.node;
    return {
      id,
      name: made?.name ?? name,
      images: [],
      folders: [],
      modificationTime: made?.modificationTime ?? Date.now(),
      imagesMappings: {},
      tags: [],
      children: [],
      isExpand: true,
    };
  };

  const updateFolder = async (r: Req, rename: boolean) => {
    const a = r.args;
    const id = str(a.folderId) ?? str(a.folderID);
    const newName = str(a.newName);
    if (!id || (rename && !newName)) throw new HttpError(400, MISSING);
    await requireFolder(ctx, id);
    const patch: FolderPatch = {};
    if (newName) patch.name = newName;
    if (!rename) {
      const color = colorArg(a, 'newColor');
      if (color) patch.iconColor = color; // v1 has no way to clear a color
      if (typeof a.newDescription === 'string') patch.description = a.newDescription;
    }
    if (Object.keys(patch).length) await writer(ctx, r).updateFolder(id, patch);
    return folderObject(id);
  };

  // ── tags ──
  const tagLists = async () => {
    const t = await tagObjects(ctx);
    return {
      objects: t.objects,
      groups: t.st.tagGroups.map(eagleTagGroup),
      recent: t.recent(),
      starred: t.starred(),
    };
  };

  // ── items ──
  const listItems = async (a: Args) => {
    const filter: FilterSpec = {};
    const words = list(a.name ?? a.keyword);
    if (words.length) filter.keywords = words.map(quote).join(' ');
    const urls = list(a.url);
    if (urls.length) filter.urlContains = urls[0];
    const ext = str(a.ext);
    if (ext) filter.types = { include: [normExt(ext)], exclude: [] };
    const tags = list(a.tags);
    if (tags.length) filter.tags = { mode: 'any', include: tags, exclude: [] };
    const folders = list(a.folders);
    if (folders.length) filter.folders = { include: folders, exclude: [] };

    let ids = (await api.query({ scope: { kind: 'all' }, filter, sort: sortOf(str(a.orderBy)) }))
      .ids;
    if (urls.length > 1) {
      // The query takes one url term; every further term must also be in the item's url.
      const keep = new Set<string>();
      for (const it of await loadItems(api, ids)) {
        if (urls.slice(1).every((u) => it.url.toLowerCase().includes(u.toLowerCase())))
          keep.add(it.id);
      }
      ids = ids.filter((id) => keep.has(id));
    }
    const limit = num(a.limit);
    if (limit && limit > 0) {
      // v1 quirk kept on purpose: `offset` is a page number here (v2 uses an item offset).
      const page = Math.max(0, Math.trunc(num(a.offset) ?? 0));
      ids = ids.slice(Math.trunc(limit) * page, Math.trunc(limit) * page + Math.trunc(limit));
    } else ids = ids.slice(0, 200);
    return (await loadItems(api, ids)).map((it) => eagleItem(it));
  };

  const thumbnailPath = async (r: Req) => {
    const it = await requireItem(api, str(r.args.id));
    const st = await needLibrary(ctx);
    const file =
      (await ctx.host.resolveFile('thumb', st.ref.id, it.id))?.path ??
      (await ctx.host.originalPath(it.id));
    if (!file) throw new HttpError(404, 'File does not exist.');
    // Eagle URI-encodes the file name part; clients decode it.
    return join(dirname(file), encodeURIComponent(basename(file)));
  };

  const updateItem = async (r: Req) => {
    const a = r.args;
    const id = str(a.id);
    await requireItem(api, id);
    const patch: ItemPatch = {};
    if (Array.isArray(a.tags)) patch.setTags = tagList(a.tags);
    if (typeof a.url === 'string') patch.url = a.url;
    if (typeof a.annotation === 'string') patch.annotation = a.annotation;
    const star = num(a.star);
    // Eagle's v1 cannot clear a rating (0 is falsy there). Here 0 clears it, as ItemPatch says.
    if (star !== undefined && star >= 0 && star <= 5) patch.star = Math.round(star);
    if (Object.keys(patch).length) await writer(ctx, r).updateItems([id!], patch);
    return eagleItem(await requireItem(api, id));
  };

  const trash = async (r: Req) => {
    const ids = list(r.args.itemIds);
    if (!ids.length) throw new HttpError(400, MISSING);
    tooMany(ids.length);
    await writer(ctx, r).trashItems(ids);
  };

  const refresh = async (r: Req) => {
    const id = str(r.args.id);
    await requireItem(api, id);
    // Thumbnail and palette come from the same regeneration.
    await writer(ctx, r).refreshThumbnails([id!]);
  };

  const customThumbnail = async (r: Req) => {
    const id = str(r.args.id);
    const file = str(r.args.thumbnailPath);
    await requireItem(api, id);
    if (!file) throw new HttpError(400, MISSING);
    await checkFile(r, file);
    await writer(ctx, r).setCustomThumbnail(id!, file);
    return true;
  };

  // ── adding ──
  const addFromURL = async (r: Req) => {
    const url = str(r.args.url);
    if (!url) throw new HttpError(400, MISSING);
    const folders = await pickFolders(ctx, r.args);
    await startAdd(ctx, r, [await urlEntry(r, url, readSpec(r.args), folders)]);
  };

  const addFromURLs = async (r: Req) => {
    const items = r.args.items;
    if (!Array.isArray(items) || !items.length) throw new HttpError(400, MISSING);
    tooMany(items.length);
    const folders = await pickFolders(ctx, r.args);
    const entries: ImportEntry[] = [];
    for (const it of items as unknown[]) {
      const o = (it && typeof it === 'object' ? it : {}) as Args;
      const url = str(o.url);
      if (!url) throw new HttpError(400, MISSING);
      entries.push(await urlEntry(r, url, readSpec(o), folders));
    }
    await startAdd(ctx, r, entries);
  };

  const addFromPath = async (r: Req) => {
    const path = str(r.args.path);
    if (!path) throw new HttpError(400, MISSING);
    const entry = await pathEntry(r, path, readSpec(r.args), await pickFolders(ctx, r.args));
    return (await settle(ctx, await startAdd(ctx, r, [entry])))?.[0] ?? null;
  };

  const addFromPaths = async (r: Req) => {
    const a = r.args;
    const rows: { path: string; spec: ReturnType<typeof readSpec> }[] = [];
    if (Array.isArray(a.paths)) {
      for (const p of list(a.paths, false)) rows.push({ path: p, spec: readSpec({}) });
    } else if (Array.isArray(a.items)) {
      for (const it of a.items as unknown[]) {
        const o = (it && typeof it === 'object' ? it : {}) as Args;
        const path = str(o.path);
        if (!path) throw new HttpError(400, MISSING);
        rows.push({ path, spec: readSpec(o) });
      }
    } else throw new HttpError(400, MISSING);
    if (!rows.length) throw new HttpError(400, MISSING);
    tooMany(rows.length);
    const folders = await pickFolders(ctx, a);
    const entries: ImportEntry[] = [];
    for (const row of rows) entries.push(await pathEntry(r, row.path, row.spec, folders));
    const ids = await settle(ctx, await startAdd(ctx, r, entries));
    return ids ?? rows.map(() => null);
  };

  const addBookmark = async (r: Req) => {
    const a = r.args;
    const url = str(a.url);
    if (!url) throw new HttpError(400, MISSING);
    const u = checkSourceUrl(url);
    const spec = readSpec(a);
    const image = str(a.base64);
    // Eagle screenshots the page when no image is sent; we cannot, so the item has no preview.
    const thumb = image ? decodeImageData(image, 'jpg').bytes : undefined;
    const title = spec.name ?? (u.hostname || url);
    const folders = await pickFolders(ctx, a);
    await startAdd(ctx, r, [bookmarkEntry(url, title, spec, folders, thumb)]);
  };

  // ── copy-link pages ──
  const openLink = (kind: OpenTarget['kind']) => async (r: Req) => {
    const id = str(r.args.id);
    if (!id) throw new HttpError(400, MISSING);
    let found = false;
    if (kind === 'item') found = !!(await api.getItem(id));
    else {
      const st = await needLibrary(ctx);
      if (kind === 'folder') found = indexFolders(st.folders).has(id);
      else {
        const has = (nodes: { id: string; children: unknown[] }[]): boolean =>
          nodes.some((n) => n.id === id || has(n.children as typeof nodes));
        found = has(st.smartFolders);
      }
    }
    if (!found)
      throw new HttpError(404, kind === 'item' ? 'File does not exist.' : 'Folder does not exist.');
    ctx.log(`open ${kind} ${id}`);
    ctx.onOpen?.({ kind, id });
    return new Reply(
      200,
      '<!doctype html><meta charset="utf-8"><title>Boogie Browser</title><p>Opened in Boogie Browser</p>',
      {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'",
      },
    );
  };

  return {
    '/': { GET: () => appInfo(ctx.prefs.showCollectModal) },
    '/api/application/info': { GET: () => appInfo(ctx.prefs.showCollectModal) },
    // The extension's "show the collect window before saving" switch (a GET that changes state, as in Eagle).
    '/api/preferences/collect/on': { GET: () => ctx.prefs.setCollect(true).then(() => undefined) },
    '/api/preferences/collect/off': {
      GET: () => ctx.prefs.setCollect(false).then(() => undefined),
    },

    '/api/library/info': { GET: async () => libraryInfo(await needLibrary(ctx)) },
    '/api/library/history': {
      GET: async () => (await api.listLibraries()).filter((l) => l.exists).map((l) => l.path),
    },
    '/api/library/switch': { POST: switchLibrary },
    '/api/library/icon': { GET: libraryIcon },

    '/api/folder/list': {
      GET: async () => (await needLibrary(ctx)).folders.map((f) => eagleFolder(f, { api: true })),
    },
    '/api/folder/listRecent': { GET: listRecentFolders },
    '/api/folder/create': { POST: createFolder },
    '/api/folder/rename': { POST: (r) => updateFolder(r, true) },
    '/api/folder/update': { POST: (r) => updateFolder(r, false) },

    '/api/tag/list': { GET: async () => (await tagObjects(ctx)).objects },
    '/api/tag/listRecent': { GET: async () => (await tagLists()).recent },
    '/api/tag/groups': { GET: async () => (await tagLists()).groups },
    '/api/tag/all': {
      GET: async () => {
        const { objects, groups, recent, starred } = await tagLists();
        return { tags: objects, recent, groups, starred };
      },
    },

    '/api/item/addFromURL': { POST: addFromURL },
    '/api/item/addFromURLs': { POST: addFromURLs },
    '/api/item/addFromPath': { POST: addFromPath },
    '/api/item/addFromPaths': { POST: addFromPaths },
    '/api/item/addBookmark': { POST: addBookmark },
    '/api/item/info': { GET: async (r) => eagleItem(await requireItem(api, str(r.args.id))) },
    '/api/item/thumbnail': { GET: thumbnailPath },
    '/api/item/list': { GET: (r) => listItems(r.args) },
    '/api/item/update': { POST: updateItem },
    '/api/item/moveToTrash': { POST: trash },
    '/api/item/refreshPalette': { POST: refresh },
    '/api/item/refreshThumbnail': { POST: refresh },
    '/api/item/setCustomThumbnail': { POST: customThumbnail },

    '/item': { GET: openLink('item') },
    '/folder': { GET: openLink('folder') },
    '/smart-folder': { GET: openLink('smart-folder') },
  };
}
