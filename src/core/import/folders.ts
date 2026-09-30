// "Keep folder structure": mirror dropped directories as Eagle folders. Pure, on the raw root
// record; the folder records, ids, names and auto-tags come from the Eagle adapter's helpers.
import type { EagleFolderRecord, EagleRootRecord } from '../../shared/types';
import { addFolder, autoTagsFor, findFolder, sanitizeFolderName } from '../eagle';

export const FOLDER_GONE = 'That folder no longer exists in this library.';

/** A directory to mirror as an Eagle folder. `folderId`/`autoTags` are filled in by `ensureFolders`. */
export interface DirNode {
  path: string;
  name: string;
  files: string[];
  dirs: DirNode[];
  folderId?: string;
  autoTags?: string[];
}

/**
 * Make sure every directory in `nodes` exists as an Eagle folder under `parentId` (null = top
 * level), reusing a same-named folder instead of creating a twin. Mutates `root` and returns how
 * many folders it created. Safe to call again on a fresh copy of the root.
 */
export function ensureFolders(
  root: EagleRootRecord,
  parentId: string | null,
  nodes: DirNode[],
): number {
  if (parentId && !findFolder(root, parentId)) throw new Error(FOLDER_GONE);
  let created = 0;
  const place = (parent: string | null, node: DirNode) => {
    const siblings: EagleFolderRecord[] | undefined = parent
      ? findFolder(root, parent)?.children
      : root.folders;
    const name = sanitizeFolderName(node.name);
    let id = (Array.isArray(siblings) ? siblings : []).find((f) => f.name === name)?.id;
    if (!id) {
      id = addFolder(root, { name: node.name, parentId: parent });
      created++;
    }
    node.folderId = id;
    node.autoTags = autoTagsFor(root, id);
    for (const child of node.dirs) place(id, child);
  };
  for (const node of nodes) place(parentId, node);
  return created;
}
