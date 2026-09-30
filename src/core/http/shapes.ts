// Our data in Eagle's JSON shapes (field names as Eagle's API uses them), so clients written
// for Eagle read replies without changes.
import { basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  FolderNode,
  Item,
  LibraryState,
  SmartFolderNode,
  TagInfo,
  TagGroup,
} from '../../shared/types';

const APP_VERSION = '4.0.0';
// The extension turns on its modern paths for buildVersion >= 20241106.
const BUILD_VERSION = '20260401';

/** Just enough of Eagle's preferences for the extension's handshake. No token, ever. */
export function preferences(showCollectModal: boolean) {
  return {
    general: { showCollectModal: String(showCollectModal) },
    notification: {
      notification: { enable: 'true', when: { extension: 'true' } },
      soundEffect: { enable: 'false', when: { extension: 'false' } },
    },
  };
}

export function appInfo(showCollectModal = false) {
  return {
    version: APP_VERSION,
    prereleaseVersion: null,
    buildVersion: BUILD_VERSION,
    execPath: '',
    showCollectModal,
    platform: 'linux',
    preferences: preferences(showCollectModal),
    boogie: true, // lets our own EagleMonitor tell us apart from real Eagle
  };
}

export function appInfoV2() {
  return {
    version: APP_VERSION,
    prereleaseVersion: null,
    buildVersion: BUILD_VERSION,
    platform: 'linux',
    boogie: true,
  };
}

// ───────────────────────── items ─────────────────────────

/** An item as Eagle's API shows it. v2 (the plugin API's Item) also carries importedAt,
 * modifiedAt and file paths; v1 shows the record fields only. */
export function eagleItem(it: Item, v2 = false): Record<string, unknown> {
  const o: Record<string, unknown> = {
    id: it.id,
    name: it.name,
    size: it.size,
    btime: it.btime,
    mtime: it.mtime,
    ext: it.ext,
    tags: it.tags,
    folders: it.folders,
    isDeleted: it.isDeleted,
    url: it.url,
    annotation: it.annotation,
    modificationTime: it.importedAt,
  };
  if (it.height != null) o.height = it.height;
  if (it.width != null) o.width = it.width;
  if (it.modifiedAt) o.lastModified = it.modifiedAt;
  if (it.star > 0) o.star = it.star;
  if (it.noThumbnail) o.noThumbnail = true;
  if (it.noPreview) o.noPreview = true;
  // Eagle leaves palettes out until they are computed; the plugin API always has an array.
  if (v2 || it.palettes.length) o.palettes = it.palettes;
  if (it.deletedTime != null) o.deletedTime = it.deletedTime;
  if (it.duration != null) o.duration = it.duration;
  if (it.comments.length) o.comments = it.comments;
  if (Object.keys(it.order).length) o.order = it.order;
  if (v2) {
    o.importedAt = it.importedAt;
    o.modifiedAt = it.modifiedAt;
    // filePath is built from the record's name and ext, which a library can craft to point
    // anywhere: only one inside the item's own folder is handed out.
    if (basename(dirname(it.filePath)) === `${it.id}.info`) {
      o.filePath = it.filePath;
      o.fileURL = pathToFileURL(it.filePath).href;
    }
  }
  return o;
}

export function project(o: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  if (!fields.length) return o;
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f in o) out[f] = o[f];
  return out;
}

// ───────────────────────── folders ─────────────────────────

export interface FolderShapeOpts {
  /** `/api/folder/list` style: adds extendTags. */
  api?: boolean;
  /** v2 folders also say who their parent is and when they were created. */
  v2?: boolean;
  parent?: string | null;
  inherited?: string[];
}

/** A folder record. Password-protected folders show no children and a placeholder password,
 * like a folder that was never unlocked in Eagle. We never hand out the real password. */
export function eagleFolder(n: FolderNode, o: FolderShapeOpts = {}): Record<string, unknown> {
  const inherited = o.inherited ?? [];
  const extend = [...new Set([...inherited, ...n.tags])];
  const rec: Record<string, unknown> = {
    id: n.id,
    name: n.name,
    description: n.description,
    children: n.hasPassword
      ? []
      : n.children.map((c) => eagleFolder(c, { ...o, parent: n.id, inherited: extend })),
    modificationTime: n.modificationTime,
    tags: n.tags,
  };
  if (o.api) rec.extendTags = extend;
  if (n.icon) rec.icon = n.icon;
  if (n.iconColor) rec.iconColor = n.iconColor;
  rec.password = n.hasPassword ? 'locked' : '';
  rec.passwordTips = '';
  if (n.coverId) rec.coverId = n.coverId;
  if (n.orderBy) {
    rec.orderBy = n.orderBy;
    rec.sortIncrease = n.sortIncrease ?? true;
  }
  if (o.v2) {
    rec.parent = o.parent ?? null;
    rec.createdAt = n.modificationTime;
  }
  return rec;
}

export function eagleSmartFolder(n: SmartFolderNode): Record<string, unknown> {
  const rec: Record<string, unknown> = { id: n.id };
  if (n.icon) rec.icon = n.icon;
  if (n.iconColor) rec.iconColor = n.iconColor;
  rec.name = n.name;
  rec.description = n.description;
  if (n.modificationTime !== undefined) rec.modificationTime = n.modificationTime;
  rec.conditions = n.conditions;
  rec.children = n.children.map(eagleSmartFolder);
  if (n.orderBy) {
    rec.orderBy = n.orderBy;
    rec.sortIncrease = n.sortIncrease ?? true;
  }
  return rec;
}

/** Depth-first index of the folder tree: id -> node and its parent id. */
export function indexFolders(
  tree: FolderNode[],
): Map<string, { node: FolderNode; parent: string | null }> {
  const out = new Map<string, { node: FolderNode; parent: string | null }>();
  const walk = (nodes: FolderNode[], parent: string | null) => {
    for (const n of nodes) {
      out.set(n.id, { node: n, parent });
      walk(n.children, n.id);
    }
  };
  walk(tree, null);
  return out;
}

// ───────────────────────── library, tags ─────────────────────────

export function eagleTagGroup(g: TagGroup): Record<string, unknown> {
  const rec: Record<string, unknown> = { id: g.id, name: g.name, tags: g.tags };
  if (g.color) rec.color = g.color;
  if (g.description) rec.description = g.description;
  return rec;
}

/** What `GET /api/library/info` returns: the root record's shape plus `library`. v2 also
 * puts path and name at the top level. `boogie` tells our own Eagle monitor that this answer
 * is Boogie's, not Eagle's (it asks this route which library Eagle has open). */
export function libraryInfo(st: LibraryState, v2 = false): Record<string, unknown> {
  const info: Record<string, unknown> = {
    folders: st.folders.map((f) => eagleFolder(f)),
    smartFolders: st.smartFolders.map(eagleSmartFolder),
    quickAccess: st.quickAccess,
    tagsGroups: st.tagGroups.map(eagleTagGroup),
    modificationTime: st.modificationTime,
    applicationVersion: st.applicationVersion,
    library: { path: st.ref.path, name: st.ref.name },
    boogie: true,
  };
  if (v2) {
    info.path = st.ref.path;
    info.name = st.ref.name;
  }
  return info;
}

/** Eagle's tag object: name, how many items carry it, its groups, and the group's color. */
export function eagleTags(tags: TagInfo[], groups: TagGroup[]): Record<string, unknown>[] {
  const color = new Map(groups.filter((g) => g.color).map((g) => [g.id, g.color as string]));
  return [...tags]
    .sort((a, b) => b.count - a.count)
    .map((t) => {
      const rec: Record<string, unknown> = {
        name: t.name,
        imageCount: t.count,
        groups: t.groupIds,
      };
      const c = t.groupIds.map((id) => color.get(id)).find(Boolean);
      if (c) rec.color = c;
      return rec;
    });
}
