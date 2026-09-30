// Saved filters: saved-filters.json, a list of {name, rule} where `rule` is Eagle's filter bar.
// Eagle polls the file every 4 s and re-reads it before adding one, so these edits reach a
// running Eagle. Entries have no ids: each one is found again in a fresh read by its fingerprint
// (`key`: name and rule, byte for byte), or else by position plus name, so an edit never lands on
// the wrong entry after the list changed on disk.
import { createHash } from 'node:crypto';
import type { Actor, FilterSpec, MutationResult, SavedFilterInfo } from '../../shared/types';
import type { EagleSavedFilter } from '../contracts';
import {
  eagleCaveats,
  eagleRuleToFilter,
  filterToEagleRule,
  type EagleRule,
} from '../index/query/savedFilters';
import { ensureWritable, runGroup, toResult } from './group';
import { quoted } from './labels';
import { buildLibraryState } from './state';
import type { Session } from './types';

const CHANGED =
  'That saved filter changed on disk (it was renamed, moved or deleted, maybe in Eagle). Look again and retry.';

function remember(s: Session, text: string | null): void {
  if (text === null) {
    s.savedFilterEntries = null;
    return;
  }
  try {
    const v = JSON.parse(text) as unknown;
    s.savedFilterEntries = Array.isArray(v) ? (v as EagleSavedFilter[]) : [];
  } catch {
    /* we just wrote it, so it parses */
  }
}

/** Read saved-filters.json into the session. Returns true when it changed. */
export async function loadSavedFilters(s: Session): Promise<boolean> {
  if (!s.lib.readSavedFilters) return false;
  const before = JSON.stringify(s.savedFilterEntries);
  try {
    remember(s, (await s.lib.readSavedFilters())?.text ?? null);
  } catch (e) {
    if (!s.closed) console.error('[boogie] could not read saved-filters.json', e);
    return false;
  }
  return JSON.stringify(s.savedFilterEntries) !== before;
}

/** An entry's fingerprint: any change to it (Eagle's or ours) gives a new one. */
export function entryKey(e: unknown): string {
  return createHash('sha1')
    .update(JSON.stringify(e ?? null))
    .digest('base64url')
    .slice(0, 16);
}

/** The entries as the UI sees them ("last 7 days" etc. are worked out against `now`). */
export function savedFilterInfos(
  entries: readonly EagleSavedFilter[],
  now = Date.now(),
): SavedFilterInfo[] {
  return entries.map((e, index) => {
    const { filter, unsupported } = eagleRuleToFilter(e?.rule, now);
    const name = typeof e?.name === 'string' ? e.name : '';
    return { index, name, filter, unsupported, key: entryKey(e) };
  });
}

const cleanName = (name: string): string => {
  const n = name.trim();
  if (!n) throw new Error('Give the filter a name.');
  return n;
};

/** One saved-filters.json write as one history group (journaled). */
async function edit(
  s: Session,
  actor: Actor,
  label: string | (() => string),
  mutate: (list: EagleSavedFilter[]) => boolean | void,
  warning?: string,
): Promise<MutationResult> {
  ensureWritable(s);
  const update = s.lib.updateSavedFilters?.bind(s.lib);
  if (!update) throw new Error("This library can't keep saved filters.");
  const text = () => (typeof label === 'string' ? label : label());
  const { entry, t } = await runGroup(s, actor, text(), 'other', async (ctx, t) => {
    const done = await update(mutate, ctx);
    if (done) remember(s, done.after);
    t.count = done ? 1 : 0;
    t.label = text();
    if (done) t.warning = warning;
  });
  if (t.count) s.env.emit('library', buildLibraryState(s));
  return toResult(entry, t);
}

function folderNamer(s: Session): (id: string) => string | undefined {
  return (id) => s.env.deps.helpers.tree.findFolder(s.root, id)?.name;
}

/** What Eagle will do differently with this filter, as one warning (or none). */
const caveats = (filter: FilterSpec): string | undefined =>
  eagleCaveats(filter).join(' ') || undefined;

export function saveFilter(
  s: Session,
  actor: Actor,
  name: string,
  filter: FilterSpec,
): Promise<MutationResult> {
  const n = cleanName(name);
  const rule = filterToEagleRule(filter, folderNamer(s));
  return edit(
    s,
    actor,
    `Saved filter ${quoted(n)}`,
    (list) => {
      list.push({ name: n, rule });
    },
    caveats(filter),
  );
}

/**
 * The fingerprint of the entry Boogie last showed at `index`, for callers that don't pass one: an
 * edit made before Boogie noticed the partner's reorder still finds the entry that was on screen.
 */
function shownKey(s: Session, index: number, expectName?: string): string | undefined {
  const e = Number.isInteger(index) ? s.savedFilterEntries?.[index] : undefined;
  if (!e || (expectName !== undefined && e.name !== expectName)) return undefined;
  return entryKey(e);
}

/**
 * Where the entry the UI meant is in the list as it is now. With its key: at `index`, or wherever
 * Eagle moved it. Without one (an older caller): at `index`, still called `expectName`.
 */
function locate(
  list: EagleSavedFilter[],
  index: number,
  expectName: string | undefined,
  expectKey: string | undefined,
): number {
  if (expectKey) {
    if (Number.isInteger(index) && list[index] && entryKey(list[index]) === expectKey) return index;
    const moved = list.findIndex((e) => entryKey(e) === expectKey);
    if (moved >= 0) return moved;
    throw new Error(CHANGED);
  }
  const e = Number.isInteger(index) ? list[index] : undefined;
  if (!e || (expectName !== undefined && e.name !== expectName)) throw new Error(CHANGED);
  return index;
}

export function updateSavedFilter(
  s: Session,
  actor: Actor,
  index: number,
  expectName: string,
  patch: { name?: string; filter?: FilterSpec },
  expectKey?: string,
): Promise<MutationResult> {
  const name = patch.name !== undefined ? cleanName(patch.name) : undefined;
  const label =
    name !== undefined && name !== expectName
      ? `Renamed saved filter ${quoted(expectName)} to ${quoted(name)}`
      : `Edited saved filter ${quoted(expectName)}`;
  const namer = folderNamer(s);
  const key = expectKey ?? shownKey(s, index, expectName);
  return edit(
    s,
    actor,
    label,
    (list) => {
      const e = list[locate(list, index, expectName, key)]!;
      if (name !== undefined) e.name = name;
      // Only the parts of the rule this edit changes are rewritten; Eagle's own stay as they were.
      if (patch.filter) e.rule = filterToEagleRule(patch.filter, namer, e.rule as EagleRule);
    },
    patch.filter ? caveats(patch.filter) : undefined,
  );
}

export function deleteSavedFilter(
  s: Session,
  actor: Actor,
  index: number,
  expectName: string,
  expectKey?: string,
): Promise<MutationResult> {
  const key = expectKey ?? shownKey(s, index, expectName);
  return edit(s, actor, `Deleted saved filter ${quoted(expectName)}`, (list) => {
    list.splice(locate(list, index, expectName, key), 1);
  });
}

export function moveSavedFilter(
  s: Session,
  actor: Actor,
  from: number,
  to: number,
  expectName?: string,
  expectKey?: string,
): Promise<MutationResult> {
  let name = '';
  const label = () => (name ? `Moved saved filter ${quoted(name)}` : 'Reordered saved filters');
  const key = expectKey ?? shownKey(s, from, expectName);
  return edit(s, actor, label, (list) => {
    if (!Number.isInteger(to) || to < 0) throw new Error(CHANGED);
    const at = locate(list, from, expectName, key);
    if (at === to) return false;
    const [moved] = list.splice(at, 1);
    name = typeof moved!.name === 'string' ? moved!.name : '';
    list.splice(Math.min(to, list.length), 0, moved!);
  });
}
