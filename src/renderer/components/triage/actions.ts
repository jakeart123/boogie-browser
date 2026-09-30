// What triage's keys do. Every change goes through the same api calls as the rest of the app
// (updateItems, trashItems, undo), one history entry per key press, so History and Ctrl+Z see
// them like any other edit. Presses run one after another: a tag key pressed twice quickly
// adds and then removes, instead of racing itself.
import { api } from '../../lib/api';
import { canEdit, confirmBulk, mutate, undo as undoGroup } from '../../lib/edit';
import { leaveFolders } from '../../lib/folders';
import { plural, quoted } from '../../lib/format';
import { items } from '../../lib/stores/items.svelte';
import { library } from '../../lib/stores/library.svelte';
import { ui } from '../../lib/stores/ui.svelte';
import {
  setOutcome,
  triage,
  type Outcome,
  type Step,
  type TriageSession,
} from '../../lib/stores/triage.svelte';
import { FILE_KEYS, TAG_KEYS, saveKeys } from '../../lib/triageKeys';
import type { ItemPatch } from '../../../shared/types';

let chain: Promise<unknown> = Promise.resolve();

/** Run `fn` on the session and item on screen, after any press still running. */
function queued(fn: (s: TriageSession, id: string) => Promise<unknown> | unknown): Promise<void> {
  const next = chain.then(async () => {
    const s = triage.session;
    const id = s?.current;
    if (s && id) await fn(s, id);
  });
  chain = next.catch(() => {});
  return next;
}

function record(
  s: TriageSession,
  step: Omit<Step, 'index' | 'before' | 'after'>,
  outcome?: Outcome,
): void {
  s.steps = [...s.steps, { ...step, index: s.index, before: s.outcomes[step.id], after: outcome }];
  if (outcome) setOutcome(s, step.id, outcome);
}

/** On to the next item nobody has sorted yet (after the last one, back to the first left). */
export function advance(s: TriageSession): void {
  const next = s.nextOpen();
  if (next >= 0) s.index = next;
}

export function go(delta: number): void {
  const s = triage.session;
  if (!s) return;
  s.index = Math.min(s.ids.length - 1, Math.max(0, s.index + delta));
}

// ── filing ──

const folderName = (id: string) => library.folder(id)?.node.name ?? 'that folder';

/**
 * File the item on screen into a folder: a move out of the queue's folder (and the subfolders it
 * shows) when the queue came from one. Already there: nothing to write, it just counts as filed.
 */
async function fileInto(s: TriageSession, id: string, folderId: string, key: string) {
  if (!canEdit()) return;
  const item = await items.loadFull(id, true);
  if (!item) return;
  const leave = leaveFolders(s.scope, folderId).filter((f) => item.folders.includes(f));
  let groupId: string | null = null;
  if (leave.length || !item.folders.includes(folderId)) {
    const patch: ItemPatch = leave.length
      ? { addFolders: [folderId], removeFolders: leave }
      : { addFolders: [folderId] };
    const r = await mutate(() => api.updateItems([id], patch));
    if (!r?.changed) return; // not filed (the toast says why)
    groupId = r.groupId;
  }
  const name = folderName(folderId);
  const label = `${leave.length ? 'Moved' : 'Filed'} in ${name}`;
  record(
    s,
    { kind: 'file', id, groupId, label },
    { kind: 'filed', key, name, moved: leave.length > 0 },
  );
  advance(s);
}

/** Number key `slot` (0-8 for keys 1-9). An empty key asks which folder it is for. */
export function fileKey(slot: number): Promise<void> {
  return queued((s, id) => {
    if (!s.editing && !canEdit()) return; // read-only: say so, don't ask for a folder first
    const folderId = s.keys.folders[slot];
    if (s.editing || !folderId || !library.folder(folderId))
      return void (s.choosing = { kind: 'folder', slot, apply: !s.editing });
    return fileInto(s, id, folderId, FILE_KEYS[slot]);
  });
}

/** 0: file into a folder picked from the list, just this once. */
export function fileElsewhere(): void {
  const s = triage.session;
  if (s && canEdit()) s.choosing = { kind: 'folder', slot: null, apply: true };
}

// ── tags and rating (the item stays on screen) ──

async function toggleTag(s: TriageSession, id: string, tag: string): Promise<void> {
  if (!canEdit()) return;
  const item = await items.loadFull(id, true);
  if (!item) return;
  const has = item.tags.includes(tag);
  const r = await mutate(() =>
    api.updateItems([id], has ? { removeTags: [tag] } : { addTags: [tag] }),
  );
  if (!r?.changed) return;
  record(s, {
    kind: has ? 'untag' : 'tag',
    id,
    groupId: r.groupId,
    label: `${has ? 'Removed' : 'Tagged'} ${tag}`,
  });
}

/** Letter key `slot` (TAG_KEYS order): adds the tag, or takes it off again. */
export function tagKey(slot: number): Promise<void> {
  return queued((s, id) => {
    if (!s.editing && !canEdit()) return;
    const tag = s.keys.tags[slot];
    if (s.editing || !tag) return void (s.choosing = { kind: 'tag', slot, apply: !s.editing });
    return toggleTag(s, id, tag);
  });
}

export function rate(star: number): Promise<void> {
  return queued(async (s, id) => {
    if (!canEdit() || (await items.loadFull(id, true))?.star === star) return;
    const r = await mutate(() => api.updateItems([id], { star }));
    if (!r?.changed) return;
    record(s, {
      kind: 'rate',
      id,
      groupId: r.groupId,
      label: star ? `Rated ${plural(star, 'star')}` : 'Cleared the rating',
    });
  });
}

/** Tag every item still waiting in the queue that shares the clue (one history entry). */
export function tagAll(tag: string, ids: string[]): Promise<void> {
  return queued(async (s, id) => {
    if (!ids.length || !canEdit()) return;
    const n = plural(ids.length, 'item');
    if (!(await confirmBulk(ids.length, { what: `tag ${n} ${quoted(tag)}`, always: true }))) return;
    const r = await mutate(() => api.updateItems(ids, { addTags: [tag] }), `Tagged ${n} ${tag}`);
    if (r?.changed)
      record(s, { kind: 'tagAll', id, ids, groupId: r.groupId, label: `Tagged ${n} ${tag}` });
  });
}

// ── finishing an item ──

export function trash(): Promise<void> {
  return queued(async (s, id) => {
    if (!canEdit()) return;
    const r = await mutate(() => api.trashItems([id]));
    if (!r?.changed) return; // not trashed (the toast says why)
    record(
      s,
      { kind: 'trash', id, groupId: r.groupId, label: 'Moved to the trash' },
      { kind: 'trashed' },
    );
    advance(s);
  });
}

export function skip(): Promise<void> {
  return queued((s, id) => {
    record(s, { kind: 'skip', id, groupId: null, label: 'Skipped' }, { kind: 'skipped' });
    advance(s);
  });
}

/** Enter: keep it as it is now (with its new tags or rating) and go on. */
export function done(): Promise<void> {
  return queued((s, id) => {
    record(s, { kind: 'done', id, groupId: null, label: 'Done' }, { kind: 'done' });
    advance(s);
  });
}

/** U: take back the last key press, and show that item again. */
export function undoLast(): Promise<void> {
  return queued(async (s) => {
    const last = s.steps.at(-1);
    if (!last) return void ui.toast('Nothing to undo in this session');
    // Out of the log first, so the 'history' event of this very undo finds nothing to forget.
    s.steps = s.steps.slice(0, -1);
    if (last.groupId) {
      const r = await undoGroup(last.groupId, last.label);
      if (!r) {
        s.steps = [...s.steps, last]; // it failed (the toast says why): still undoable later
        return;
      }
      if (r.groupId) s.taken.set(r.groupId, last); // so Ctrl+Shift+Z can put it back
    }
    if (
      last.kind === 'file' ||
      last.kind === 'trash' ||
      last.kind === 'skip' ||
      last.kind === 'done'
    )
      setOutcome(s, last.id, last.before);
    if (!last.groupId)
      ui.toast(`Back to ${items.brief(last.id)?.name ?? 'the last item'}`, { ms: 1500 });
    s.index = last.index;
  });
}

/** After going through everything: the skipped ones again. */
export function revisitSkipped(): void {
  const s = triage.session;
  if (!s) return;
  const first = s.ids.findIndex((id) => s.outcomes[id]?.kind === 'skipped');
  for (const id of s.ids) if (s.outcomes[id]?.kind === 'skipped') delete s.outcomes[id];
  if (first >= 0) s.index = first;
}

// ── keys ──

/** A suggestion's button: file or tag the item on screen with it, whatever the keys say. */
export function chosenOnce(kind: 'folder' | 'tag', value: string): Promise<void> {
  return queued((s, id) => {
    if (kind === 'tag') return toggleTag(s, id, value);
    const slot = s.keys.folders.indexOf(value);
    return fileInto(s, id, value, slot >= 0 ? FILE_KEYS[slot] : '0');
  });
}

/** Shift + a tag key: that tag on every queued item whose note says what this one's does. */
export function tagAllKey(slot: number): void {
  const s = triage.session;
  const tag = s?.keys.tags[slot];
  if (!s || !tag) return;
  const ids = s.sameClue[tag];
  if (ids?.length) void tagAll(tag, ids);
  else ui.toast(`No other item in this queue has the note that suggests ${tag}`, { ms: 3000 });
}

/** Set (or clear, with null) what a key does, for this queue from now on. */
export function assignKey(kind: 'folder' | 'tag', slot: number, value: string | null): void {
  const s = triage.session;
  if (!s) return;
  const list = kind === 'folder' ? s.keys.folders : s.keys.tags;
  list[slot] = value;
  saveKeys(s.libraryId, s.queue, s.keys);
}

/** The chooser picked `value` (a folder id or a tag name) for the current request. */
export function chosen(value: string): Promise<void> | void {
  const s = triage.session;
  const c = s?.choosing;
  if (!s || !c) return;
  s.choosing = null;
  if (c.slot !== null) assignKey(c.kind, c.slot, value);
  if (!c.apply) return;
  const key = c.slot === null ? '0' : c.kind === 'folder' ? FILE_KEYS[c.slot] : TAG_KEYS[c.slot];
  return queued((s2, id) =>
    c.kind === 'folder' ? fileInto(s2, id, value, key) : toggleTag(s2, id, value),
  );
}
