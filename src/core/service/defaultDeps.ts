// Where the service gets the real module factories. Everything else takes them as `CoreDeps`,
// so a test can swap one out (the Eagle monitor and Dropbox status, say).
import { dupeFinder } from '../dupes';
import { eagleLibraries } from '../eagle';
import * as edits from '../eagle/edits';
import * as order from '../eagle/order';
import * as root from '../eagle/root';
import { importers } from '../import';
import { indexes } from '../index';
import { queryEngines } from '../index/query';
import { createJournal } from '../journal';
import { createMediaService } from '../media';
import { createDropboxStatus, createEagleMonitor, createWatcher } from '../sync';
import type { CoreDeps, EagleHelpers } from './deps';

const helpers: EagleHelpers = {
  edits,
  order,
  tree: {
    findFolder: root.findFolder,
    autoTagsFor: root.autoTagsFor,
    // The service wants the folder itself included; root.descendantIds leaves it out by default.
    descendantIds: (tree, id) => root.descendantIds(tree, id, true),
    addFolder: root.addFolder,
    updateFolder: root.updateFolder,
    moveFolder: root.moveFolder,
    removeFolder: root.removeFolder,
    addSmartFolder: root.addSmartFolder,
    updateSmartFolder: root.updateSmartFolder,
    removeSmartFolder: root.removeSmartFolder,
    setQuickAccess: root.setQuickAccess,
    upsertTagGroup: (tree, group) => root.upsertTagGroup(tree, group),
    removeTagGroup: root.removeTagGroup,
    renameTagInGroups: root.renameTagInGroups,
    removeTagFromGroups: root.removeTagFromGroups,
  },
};

/** `selfPort`: where our own Eagle-compatible API answers, so the monitor never takes it for Eagle. */
export function makeDefaultDeps(opts: { selfPort: () => number | null }): CoreDeps {
  return {
    eagle: eagleLibraries,
    indexes,
    queries: queryEngines,
    createJournal: (o) => createJournal(o),
    createMedia: (o) => createMediaService(o),
    createWatcher: () => createWatcher(),
    eagleMonitor: createEagleMonitor({ selfPort: opts.selfPort }),
    dropbox: createDropboxStatus(),
    importers,
    dupes: dupeFinder,
    helpers,
  };
}
