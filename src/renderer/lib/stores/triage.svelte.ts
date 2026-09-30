// Triage mode (mockup #4): one item at a time, keys to file, tag, rate, trash or skip it.
// `triage.open(scope?)` starts a session on a snapshot of the view you are looking at (or of
// another scope); `triage.close()` puts you back where you were. The keys and the screen live in
// components/triage; this is the state they share.
import { api } from '../api';
import { focus, type Region } from '../commands.svelte';
import { library } from './library.svelte';
import { selection } from './selection.svelte';
import { ui } from './ui.svelte';
import { view } from './view.svelte';
import { loadKeys, queueKey, seedKeys, type KeyMap } from '../triageKeys';
import type { FilterSpec, Scope, SortSpec } from '../../../shared/types';

/** What happened to an item. Items with an outcome count as sorted; tags and ratings don't finish one. */
export type Outcome =
  | { kind: 'filed'; key: string; name: string; moved: boolean }
  | { kind: 'trashed' }
  | { kind: 'skipped' }
  | { kind: 'done' };

/** One key press, newest last: what U takes back, and what the session counts are made of. */
export interface Step {
  kind: 'file' | 'tag' | 'untag' | 'rate' | 'trash' | 'skip' | 'done' | 'tagAll';
  id: string;
  /** Where the item was in the queue (U goes back there). */
  index: number;
  /** The history entry it made, if it changed anything. */
  groupId: string | null;
  /** The item's outcome before this step (restored by U), and the one it gave (restored by redo). */
  before?: Outcome;
  after?: Outcome;
  /** Names the change in the Undo toast. */
  label: string;
  /** tagAll: every item it tagged. */
  ids?: string[];
}

/** A request to pick a folder or tag: for a key (assign it), or just this once (0: another folder). */
export interface Choosing {
  kind: 'folder' | 'tag';
  /** Index into FILE_KEYS / TAG_KEYS, or null for "this item only". */
  slot: number | null;
  /** After picking, file or tag the item on screen too (false while editing keys). */
  apply: boolean;
}

export class TriageSession {
  readonly libraryId: string;
  readonly scope: Scope;
  readonly filter: FilterSpec;
  readonly sort: SortSpec | null;
  readonly queue: string;
  /** The queue: a snapshot, so items that leave the view while you sort stay put. */
  readonly ids: readonly string[];
  index = $state(0);
  outcomes = $state<Record<string, Outcome>>({});
  steps = $state.raw<Step[]>([]);
  keys = $state<KeyMap>({ folders: [], tags: [] });
  choosing = $state<Choosing | null>(null);
  /** "Edit keys": a key press or click picks what the key does instead of doing it. */
  editing = $state(false);
  /** Suggested tag -> the items still waiting in the queue whose note says the same (Shift+key). */
  sameClue = $state.raw<Record<string, string[]>>({});

  sorted = $derived(Object.keys(this.outcomes).length);
  /** Items, not key presses: one filed twice counts once, and "done" ones are counted too. */
  stats = $derived.by(() => {
    // Items whose last tag key added a tag (one that was added and taken off again doesn't count).
    const tagged = new Set<string>();
    for (const s of this.steps) {
      if (s.kind === 'tag') tagged.add(s.id);
      if (s.kind === 'untag') tagged.delete(s.id);
      if (s.kind === 'tagAll') s.ids?.forEach((id) => tagged.add(id));
    }
    const n = { filed: 0, trashed: 0, skipped: 0, done: 0 };
    for (const o of Object.values(this.outcomes)) n[o.kind]++;
    return { tagged: tagged.size, ...n };
  });
  /** Undo group id -> the step it took back, so a redo (the undo of that undo) can put it back. */
  readonly taken = new Map<string, Step>();

  /** Where the window was, for close(). */
  readonly back: { region: Region; selection: string[]; primary: string | null };

  constructor(o: {
    libraryId: string;
    scope: Scope;
    filter: FilterSpec;
    sort: SortSpec | null;
    ids: readonly string[];
    keys: KeyMap;
    back: TriageSession['back'];
  }) {
    this.libraryId = o.libraryId;
    this.scope = o.scope;
    this.filter = o.filter;
    this.sort = o.sort;
    this.queue = queueKey(o.scope);
    this.ids = o.ids;
    this.keys = o.keys;
    this.back = o.back;
  }

  /** Every item in the queue has an outcome. */
  get finished(): boolean {
    return this.sorted >= this.ids.length;
  }

  get current(): string | undefined {
    return this.ids[this.index];
  }

  /** The next item without an outcome after `from`, wrapping to the start; -1 when all are sorted. */
  nextOpen(from = this.index): number {
    const n = this.ids.length;
    for (let k = 1; k <= n; k++) {
      const i = (from + k) % n;
      if (!this.outcomes[this.ids[i]]) return i;
    }
    return -1;
  }

  /**
   * History entry `target` was undone by group `undoId` (Ctrl+Z, the History tab, U). One of this
   * session's steps: forget it and give the item its old outcome back. An undo of one of those
   * undos (Ctrl+Shift+Z, redo): the step is back, under the redo's group (what U undoes next).
   */
  undone(undoId: string, target: string): void {
    const at = this.steps.findLastIndex((s) => s.groupId === target);
    if (at >= 0) {
      const s = this.steps[at];
      this.steps = this.steps.filter((_, i) => i !== at);
      if ((s.kind === 'file' || s.kind === 'trash') && this.outcomes[s.id])
        setOutcome(this, s.id, s.before);
      this.taken.set(undoId, s);
      return;
    }
    const redone = this.taken.get(target);
    if (!redone) return;
    this.taken.delete(target);
    this.steps = [...this.steps, { ...redone, groupId: undoId }];
    if (redone.after) setOutcome(this, redone.id, redone.after);
  }
}

export function setOutcome(s: TriageSession, id: string, o: Outcome | undefined): void {
  if (o) s.outcomes[id] = o;
  else delete s.outcomes[id];
}

/** Regions a session can hand back to: never one that belongs to something now closed. */
const RESTORABLE: Region[] = ['grid', 'sidebar', 'inspector'];

class TriageStore {
  session = $state<TriageSession | null>(null);

  /**
   * Start triage. With no scope, the queue is what the grid shows now (scope, filter and sort);
   * with one, that scope unfiltered in its own order. Resolves false when there is nothing to sort.
   */
  async open(scope?: Scope): Promise<boolean> {
    const lib = library.state;
    if (!lib) return (ui.toast('Open a library first'), false);
    if ((scope ?? view.scope).kind === 'trash')
      return (ui.toast('Triage sorts items in the library, not the trash'), false);
    let q: { scope: Scope; filter: FilterSpec; sort: SortSpec | null; ids: readonly string[] };
    if (scope) {
      try {
        const plain = $state.snapshot(scope) as Scope; // a caller may hand us reactive state
        const r = await api.query({ scope: plain, filter: {}, sort: null });
        q = { scope: plain, filter: {}, sort: null, ids: r.ids };
      } catch (e) {
        ui.toast(e instanceof Error ? e.message : String(e), { kind: 'error' });
        return false;
      }
    } else {
      // The grid's own result, once it answers for the place on screen now (a folder you just
      // clicked may still be loading, and the result would be the last place's).
      const result = await view.settled();
      const snap = <T>(v: T) => $state.snapshot(v) as T;
      q = {
        scope: snap(view.scope),
        filter: snap(view.filter),
        sort: view.sort ? snap(view.sort) : null,
        ids: result?.ids ?? [],
      };
    }
    if (!q.ids.length) return (ui.toast('Nothing to triage here'), false);
    if (library.state?.ref.id !== lib.ref.id) return false; // another library opened meanwhile

    ui.viewer = null;
    ui.closeOverlay();
    const skip = q.scope.kind === 'folder' ? q.scope.id : null;
    const keys = loadKeys(lib.ref.id, queueKey(q.scope), () =>
      seedKeys(library.counts?.folders ?? {}, library.tags, skip),
    );
    const region = focus.region === 'overlay' ? focus.underOverlay : focus.region;
    this.session = new TriageSession({
      libraryId: lib.ref.id,
      ...q,
      keys,
      back: {
        region: RESTORABLE.includes(region) ? region : 'grid',
        selection: [...selection.ids],
        primary: selection.primary,
      },
    });
    focus.region = 'other';
    return true;
  }

  /** Back where you were: the view underneath never changed, so only focus and selection return. */
  close(): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    const keep = new Set(view.result?.ids ?? []);
    const ids = s.back.selection.filter((id) => keep.has(id));
    selection.setMany(ids, s.back.primary && keep.has(s.back.primary) ? s.back.primary : null);
    if (focus.region === 'other') focus.region = s.back.region;
  }
}

export const triage = new TriageStore();
