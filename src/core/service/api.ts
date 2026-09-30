// CoreApi on top of the host: reads go straight to the open library's query engine and index,
// writes go through the operation files with `actor` recorded as who did it.
import type { CoreApi } from '../../shared/api';
import type { Actor } from '../../shared/types';
import { copyToLibrary, listLibraryFolders } from './copyToLibrary';
import * as dupes from './dupeOps';
import * as folders from './folderOps';
import { currentCounts } from './group';
import * as imports from './importOps';
import type { CoreService } from './host';
import * as items from './itemOps';
import { keepTheirs } from './partner';
import { applyRootConflict, planRootConflict } from './rootConflict';
import * as filters from './savedFilters';
import * as tags from './tagOps';
import { setTagStarred } from './tagsFile';
import * as undoOps from './undo';

/** Every method is an own property (the IPC layer only calls own functions of `api`). */
export function makeApi(svc: CoreService, actor: Actor): CoreApi {
  const S = () => svc.need();
  return {
    // ── Libraries ──
    listLibraries: () => svc.listLibraries(),
    openLibrary: (path, opts) => svc.openLibrary(path, opts),
    createLibrary: (parentDir, name) => svc.createLibrary(parentDir, name),
    addLibrary: (path) => svc.addLibrary(path),
    forgetLibrary: (path) => svc.forgetLibrary(path),
    setLibraryOptions: (path, opts) => svc.setLibraryOptions(path, opts),
    getLibraryState: async () => svc.getLibraryState(),
    closeLibrary: () => svc.closeLibrary(),

    // ── Query ──
    query: async (req) => S().query.query(req),
    getBriefs: async (ids) => S().query.briefs(ids),
    getItem: async (id) => S().query.item(id),
    getItems: async (ids) => S().query.items(ids),
    getCounts: async () => currentCounts(S()),
    listTags: async () => S().index.tags(),
    suggest: async (text, kinds, limit = 8) => S().query.suggest(text, kinds, limit),

    // ── Item mutations ──
    updateItems: async (ids, patch) => items.updateItems(S(), actor, ids, patch),
    trashItems: async (ids) => items.trashItems(S(), actor, ids),
    restoreItems: async (ids) => items.restoreItems(S(), actor, ids),
    deletePermanently: async (ids) => items.deletePermanently(S(), actor, ids),
    emptyTrash: async () => items.emptyTrash(S(), actor),
    reorderItems: async (folderId, ids, beforeId) =>
      items.reorderItems(S(), actor, folderId, ids, beforeId),
    renameItems: async (ids, template, opts) => items.renameItems(S(), actor, ids, template, opts),
    refreshThumbnails: async (ids) => items.refreshThumbnails(S(), actor, ids),
    setCustomThumbnail: async (id, imagePath) =>
      items.setCustomThumbnail(S(), actor, id, imagePath),
    setCustomThumbnailBytes: async (id, bytes) =>
      items.setCustomThumbnailBytes(S(), actor, id, bytes),

    // ── Folders / smart folders / tags / quick access ──
    createFolder: async (name, parentId, opts) =>
      folders.createFolder(S(), actor, name, parentId, opts),
    updateFolder: async (id, patch) => folders.updateFolder(S(), actor, id, patch),
    moveFolder: async (id, parentId, index) => folders.moveFolder(S(), actor, id, parentId, index),
    deleteFolder: async (id, opts) => folders.deleteFolder(S(), actor, id, opts),
    createSmartFolder: async (name, conditions, parentId, opts) =>
      folders.createSmartFolder(S(), actor, name, conditions, parentId, opts),
    updateSmartFolder: async (id, patch) => folders.updateSmartFolder(S(), actor, id, patch),
    deleteSmartFolder: async (id) => folders.deleteSmartFolder(S(), actor, id),
    setQuickAccess: async (entries) => folders.setQuickAccess(S(), actor, entries),
    renameTag: async (from, to) => tags.renameTag(S(), actor, from, to),
    deleteTag: async (name) => tags.deleteTag(S(), actor, name),
    upsertTagGroup: async (group) => tags.upsertTagGroup(S(), actor, group),
    deleteTagGroup: async (id) => tags.deleteTagGroup(S(), actor, id),

    // ── Import ──
    importPaths: async (paths, opts) => imports.importPaths(S(), actor, paths, opts),
    importUrl: async (url, opts) => imports.importUrl(S(), actor, url, opts),
    importBytes: async (bytes, fileName, opts) =>
      imports.importBytes(S(), actor, bytes, fileName, opts),
    importBookmark: async (url, title, opts) =>
      imports.importBookmark(S(), actor, url, title, opts),
    importBatch: async (entries) => imports.importBatch(S(), actor, entries),

    // ── Duplicates ──
    findDuplicates: async (opts) => dupes.findDuplicates(S(), opts),
    mergeDuplicates: async (opts) => dupes.mergeDuplicates(S(), actor, opts),

    // ── History ──
    listHistory: async (opts) => {
      const s = svc.session;
      return s && !s.closed ? s.journal.list(s.ref.id, opts) : [];
    },
    undo: async (groupId) => undoOps.undo(S(), actor, groupId),
    redo: async () => undoOps.redo(S(), actor),
    // "Keep theirs" on a "may have written an old copy" entry: no file changes, so it works
    // read-only too; the entry is marked resolved in the journal.
    keepTheirs: async (groupId) => void keepTheirs(S(), groupId),

    // ── Jobs / status / settings ──
    listJobs: async () => svc.jobs.list(),
    cancelJob: async (jobId) => svc.jobs.cancel(jobId),
    getStatus: () => svc.getStatus(),
    getSettings: async () => svc.getSettings(),
    // Where Boogie may write is the safety switch: agents and the browser extension never move it.
    setSettings: async (patch) => {
      if (actor.kind !== 'user' && patch.writableRoots !== undefined) {
        throw new Error('Only you can choose where Boogie may edit. Change it in Settings.');
      }
      return svc.setSettings(patch);
    },
    refresh: (opts) => svc.refresh(opts),

    // ── Round 4 ──
    setTagStarred: async (names, starred) => setTagStarred(S(), actor, names, starred),
    saveFilter: async (name, filter) => filters.saveFilter(S(), actor, name, filter),
    updateSavedFilter: async (index, expectName, patch, expectKey) =>
      filters.updateSavedFilter(S(), actor, index, expectName, patch, expectKey),
    deleteSavedFilter: async (index, expectName, expectKey) =>
      filters.deleteSavedFilter(S(), actor, index, expectName, expectKey),
    moveSavedFilter: async (from, to, expectName, expectKey) =>
      filters.moveSavedFilter(S(), actor, from, to, expectName, expectKey),
    sortFolders: async (parentId) => folders.sortFolders(S(), actor, parentId),
    planRootConflict: async (relPath) => planRootConflict(S(), relPath),
    applyRootConflict: async (relPath, pickedIds) =>
      applyRootConflict(S(), actor, relPath, pickedIds),
    copyToLibrary: async (ids, targetPath, opts) =>
      copyToLibrary(S(), actor, ids, targetPath, opts),
    listLibraryFolders: async (path) => listLibraryFolders(S(), path),
    // Only you pause or resume agents: an agent must not be able to resume itself.
    setAgentPaused: async (name, paused) => {
      if (actor.kind !== 'user') throw new Error('Only you can pause or resume an agent.');
      svc.agentPauses.set(name, paused);
    },
  };
}
