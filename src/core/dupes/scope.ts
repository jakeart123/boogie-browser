// Which items of the current library a scan looks at, as a SQL fragment over `items i`.
import type { Scope } from '../../shared/types';

export interface ScopeSql {
  where: string; // starts with AND (or is empty)
  params: unknown[];
}

/**
 * Returns null when nothing live can match (the Trash scope). Smart folders need the query
 * engine, which a scan doesn't have: the service resolves them to `{kind:'ids'}` before calling
 * scan, so one arriving here is a caller bug and gets a clear error.
 */
export function scopeSql(scope: Scope | undefined): ScopeSql | null {
  switch (scope?.kind) {
    case undefined:
    case 'all':
    case 'random':
      return { where: '', params: [] };
    case 'trash':
      return null;
    case 'uncategorized':
      return { where: 'AND i.folder_count = 0', params: [] };
    case 'untagged':
      return { where: 'AND i.tag_count = 0', params: [] };
    case 'tag':
      return {
        where: 'AND i.rowid IN (SELECT item_rowid FROM item_tags WHERE tag = ?)',
        params: [scope.name],
      };
    case 'ids':
      return {
        where: 'AND i.id IN (SELECT value FROM json_each(?))',
        params: [JSON.stringify(scope.ids)],
      };
    case 'folder':
      if (!scope.includeSubfolders) {
        return {
          where: 'AND i.rowid IN (SELECT item_rowid FROM item_folders WHERE folder_id = ?)',
          params: [scope.id],
        };
      }
      return {
        where:
          'AND i.rowid IN (SELECT item_rowid FROM item_folders WHERE folder_id = ? ' +
          'OR folder_id IN (SELECT descendant_id FROM folder_closure WHERE ancestor_id = ?))',
        params: [scope.id, scope.id],
      };
    case 'smartFolder':
      throw new Error(
        "A duplicate scan can't be limited to a smart folder; pick a folder or specific items.",
      );
  }
}
