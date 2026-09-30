// Pure helpers for the tag manager: filtering and ordering the list, and moving a tag between groups.
import type { TagGroup, TagInfo } from '../../../shared/types';

export type TagSort = 'name' | 'count';

/** Drag data type for a tag dragged from the list onto a group. */
export const TAG_MIME = 'application/x-boogie-tag';

export function visibleTags(tags: TagInfo[], query: string, sort: TagSort): TagInfo[] {
  const q = query.trim().toLowerCase();
  const list = q ? tags.filter((t) => t.name.toLowerCase().includes(q)) : [...tags];
  if (sort === 'count')
    return list.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return list.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
  );
}

/**
 * The group edits that put `tag` into `target`. By default a tag lives in one group, so it also
 * leaves the others; `keepInOthers` (Alt) lets it sit in several. Returns the groups to save, the
 * target first: if a later save fails, the tag is in two groups rather than in none.
 */
export function moveTagToGroup(
  groups: TagGroup[],
  tag: string,
  targetId: string,
  keepInOthers: boolean,
): TagGroup[] {
  const target = groups.find((g) => g.id === targetId);
  if (!target || target.tags.includes(tag)) return [];
  const out: TagGroup[] = [{ ...target, tags: [...target.tags, tag] }];
  if (!keepInOthers) {
    for (const g of groups)
      if (g.id !== targetId && g.tags.includes(tag))
        out.push({ ...g, tags: g.tags.filter((t) => t !== tag) });
  }
  return out;
}
