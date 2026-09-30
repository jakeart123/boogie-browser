// Turns the raw root metadata.json into the LibraryState the UI shows.
import type {
  EagleFolderRecord,
  EagleSmartFolderRecord,
  FolderNode,
  LibraryState,
  SmartFolderNode,
  TagGroup,
} from '../../shared/types';
import { loadSavedFilters, savedFilterInfos } from './savedFilters';
import { loadTagsFile } from './tagsFile';
import type { Session } from './types';

export function folderNode(f: EagleFolderRecord): FolderNode {
  return {
    id: f.id,
    name: f.name,
    description: f.description ?? '',
    children: (f.children ?? []).map(folderNode),
    tags: f.tags ?? [],
    icon: f.icon ?? null,
    iconColor: f.iconColor ?? null,
    coverId: f.coverId ?? null,
    orderBy: f.orderBy ?? null,
    sortIncrease: f.sortIncrease ?? null,
    hasPassword: !!f.password,
    modificationTime: f.modificationTime,
  };
}

function smartNode(f: EagleSmartFolderRecord): SmartFolderNode {
  return {
    id: f.id,
    name: f.name,
    description: f.description ?? '',
    icon: f.icon ?? null,
    iconColor: f.iconColor ?? null,
    conditions: f.conditions ?? [],
    children: (f.children ?? []).map(smartNode),
    orderBy: f.orderBy ?? null,
    sortIncrease: f.sortIncrease ?? null,
    ...(typeof f.modificationTime === 'number' ? { modificationTime: f.modificationTime } : {}),
  };
}

export function buildLibraryState(s: Session): LibraryState {
  const root = s.root;
  const tagGroups: TagGroup[] = (root.tagsGroups ?? []).map((g) => ({
    id: g.id,
    name: g.name,
    tags: g.tags ?? [],
    color: g.color ?? null,
    description: g.description ?? '',
  }));
  return {
    ref: s.ref,
    readOnly: s.readOnly,
    readOnlyReason: s.readOnlyReason,
    readOnlyKind: s.readOnlyKind,
    applicationVersion: root.applicationVersion ?? '', // a library with none opens read-only
    modificationTime: root.modificationTime,
    folders: (root.folders ?? []).map(folderNode),
    smartFolders: (root.smartFolders ?? []).map(smartNode),
    quickAccess: root.quickAccess ?? [],
    tagGroups,
    indexing: s.indexing ? { ...s.indexing } : null,
    // tags.json and saved-filters.json arrive a moment after the library opens (see loadLibraryFiles).
    ...(s.tagsFile !== undefined
      ? {
          starredTags: [...(s.tagsFile?.starred ?? [])],
          recentTags: [...(s.tagsFile?.recent ?? [])],
        }
      : {}),
    ...(s.savedFilterEntries !== undefined
      ? { savedFilters: savedFilterInfos(s.savedFilterEntries ?? []) }
      : {}),
  };
}

/**
 * tags.json and saved-filters.json: read when the library opens and whenever the watcher sees one
 * change (`which`). The UI hears about it through a `library` event when something changed.
 */
export async function loadLibraryFiles(s: Session, which?: 'tags' | 'savedFilters'): Promise<void> {
  const changed = await Promise.all([
    which !== 'savedFilters' ? loadTagsFile(s) : false,
    which !== 'tags' ? loadSavedFilters(s) : false,
  ]);
  if (changed.some(Boolean) && !s.closed) s.env.emit('library', buildLibraryState(s));
}
