// Typed tag names. Eagle tags are case-sensitive, so "flesh tones" next to "Flesh Tones" would be a
// second tag in the partner's Eagle. Every place a tag is typed runs it through canonicalTag, which
// reuses the library's spelling. The library's tags are always in memory, so this never waits on
// a search.
import { api } from './api';
import { canEdit, editItems, mutate } from './edit';
import { plural } from './format';
import { items } from './stores/items.svelte';
import { library } from './stores/library.svelte';
import { ui } from './stores/ui.svelte';
import { renameTagInKeys } from './triageKeys';
import { FOLDER_COLORS, type FolderColor } from '../../shared/types';

/** The library's spelling of `text` if a tag matches it ignoring case (an exact match wins). */
export function canonicalTag(text: string): string {
  const name = text.trim();
  if (!name) return name;
  const lower = name.toLowerCase();
  let found: string | undefined;
  for (const t of library.tags) {
    if (t.name === name) return name;
    if (!found && t.name.toLowerCase() === lower) found = t.name;
  }
  if (found) return found;
  for (const g of library.state?.tagGroups ?? [])
    for (const t of g.tags) if (t.toLowerCase() === lower) return t;
  return name;
}

/** Is there a tag with exactly this name (tags on items, or in a tag group)? */
export function tagExists(name: string): boolean {
  return (
    library.tags.some((t) => t.name === name) ||
    !!library.state?.tagGroups.some((g) => g.tags.includes(name))
  );
}

/** "a, b ,,c" -> ["a", "b", "c"]: trimmed, no empties, no repeats, each in the library's spelling. */
export function splitTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((s) => canonicalTag(s))
        .filter(Boolean),
    ),
  ];
}

/**
 * The name a rename should land on. Typing another tag's name in any case means that tag (a merge,
 * in its spelling); typing this tag's own name in another case is a spelling fix and stays as typed.
 */
export function renameTarget(from: string, typed: string): string {
  const to = typed.trim();
  const canon = canonicalTag(to);
  return canon.toLowerCase() === from.toLowerCase() ? to : canon;
}

/** A tag group's color: one of Eagle's color names, or any CSS color (the file holds free text). */
/** After a tag rename, merge (`to` = the other tag) or delete (null): Triage's keys follow it. */
export function followTagInTriageKeys(from: string, to: string | null): void {
  const lib = library.state?.ref.id;
  if (lib) renameTagInKeys(lib, from, to);
}

export function groupColor(c: string | null | undefined): string | undefined {
  if (!c) return undefined;
  if (c in FOLDER_COLORS) return FOLDER_COLORS[c as FolderColor];
  return typeof CSS === 'undefined' || CSS.supports('color', c) ? c : undefined;
}

// ── Copy and paste tags (Ctrl+Shift+C / Ctrl+Shift+V, as in Eagle) ──
// A renderer-held clipboard: tags are names, and the system clipboard is for pictures and files.
let copiedTags: string[] = [];

/** Remember the tags of these items (all of them together). Returns how many. */
export async function copyTags(ids: string[]): Promise<number> {
  const fulls = await items.loadFulls(ids);
  copiedTags = [...new Set(fulls.flatMap((f) => f.tags))];
  ui.toast(
    copiedTags.length ? `Copied ${plural(copiedTags.length, 'tag')}` : 'These items have no tags',
    { kind: copiedTags.length ? 'ok' : 'info', ms: 2000 },
  );
  return copiedTags.length;
}

/** Add the copied tags to these items (one change, undoable). */
export async function pasteTags(ids: string[]): Promise<void> {
  if (!copiedTags.length) return void ui.toast('Copy some tags first (Ctrl+Shift+C)');
  const tags = [...copiedTags];
  await editItems(
    ids,
    { addTags: tags },
    {
      what: `add ${plural(tags.length, 'tag')} to ${plural(ids.length, 'item')}`,
      done: `Pasted ${plural(tags.length, 'tag')} onto ${plural(ids.length, 'item')}`,
    },
  );
}

// ── Starred tags (tags.json, travels with the library) ──

export const starredTags = (): string[] => library.state?.starredTags ?? [];
export const isStarred = (name: string) => starredTags().includes(name);

/** Star or unstar. The core's warning (a running partner Eagle overwrites tags.json) shows as a toast. */
export async function setStarred(names: string[], starred: boolean): Promise<void> {
  if (!names.length || !canEdit()) return;
  // tags.json changes can't be undone from History, so the toast has no Undo.
  await mutate(
    () => api.setTagStarred(names, starred),
    `${starred ? 'Starred' : 'Unstarred'} ${names.length === 1 ? names[0] : plural(names.length, 'tag')}`,
    { undoable: false },
  );
}

/**
 * Recently used tags, newest first: this computer's picks first, then the library's own list from
 * tags.json (Eagle's historyTags, shared over Dropbox). Only tags that still exist.
 */
export function recentTags(local: string[], max = 8): string[] {
  const out: string[] = [];
  for (const name of [...local, ...(library.state?.recentTags ?? [])])
    if (!out.includes(name) && tagExists(name)) out.push(name);
  return out.slice(0, max);
}
