// Words for the queue: what it is (the top bar's tokens) and what happened to each item.
import { sortName } from '../../lib/sorts';
import type { Outcome } from '../../lib/stores/triage.svelte';
import type { FilterSpec, Scope, SortSpec } from '../../../shared/types';

export interface Token {
  key: string;
  value: string;
}

/**
 * "is: untagged", "in: Class 2025", "sort: Date imported": the queue as the search box would say
 * it. `name` looks up folder, smart folder names.
 */
export function queueTokens(
  q: { scope: Scope; filter: FilterSpec; sort: SortSpec | null },
  name: (kind: 'folder' | 'smartFolder', id: string) => string | undefined,
): Token[] {
  const out: Token[] = [];
  const s = q.scope;
  if (s.kind === 'all') out.push({ key: 'in:', value: 'All items' });
  else if (s.kind === 'untagged') out.push({ key: 'is:', value: 'untagged' });
  else if (s.kind === 'uncategorized') out.push({ key: 'is:', value: 'unfiled' });
  else if (s.kind === 'trash') out.push({ key: 'in:', value: 'Trash' });
  else if (s.kind === 'random') out.push({ key: 'in:', value: 'Random' });
  else if (s.kind === 'folder') out.push({ key: 'in:', value: name('folder', s.id) ?? 'a folder' });
  else if (s.kind === 'smartFolder')
    out.push({ key: 'smart:', value: name('smartFolder', s.id) ?? 'a smart folder' });
  else if (s.kind === 'tag') out.push({ key: 'tag:', value: s.name });
  else out.push({ key: 'in:', value: 'picked items' });

  const f = q.filter;
  if (f.keywords?.trim()) out.push({ key: '', value: f.keywords.trim() });
  for (const t of f.tags?.include ?? []) out.push({ key: 'tag:', value: t });
  const rest = Object.entries(f).filter(
    ([k, v]) =>
      k !== 'keywords' &&
      !(k === 'tags' && !(v as FilterSpec['tags'])?.exclude.length) &&
      v !== undefined &&
      v !== '' &&
      !(Array.isArray(v) && !v.length),
  ).length;
  if (rest) out.push({ key: '+', value: `${rest} ${rest === 1 ? 'filter' : 'filters'}` });
  if (q.sort) out.push({ key: 'sort:', value: sortName(q.sort.by).toLowerCase() });
  return out;
}

/** What a done row in the queue says: "4 · Same Poses", "Trashed", "skipped". */
export function outcomeText(o: Outcome): { key?: string; text: string } {
  switch (o.kind) {
    case 'filed':
      return { key: o.key, text: o.moved ? `Moved to ${o.name}` : o.name };
    case 'trashed':
      return { text: 'Trashed' };
    case 'skipped':
      return { text: 'Skipped' };
    case 'done':
      return { text: 'Done' };
  }
}
