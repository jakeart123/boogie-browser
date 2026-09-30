// What the grid shows: scope (sidebar), filter (search/filter bar), sort, and the query result.
// Also the display prefs (layout, thumbnail size), back/forward history of scopes, and the last
// place you were in each library (kept per library in local storage, like Eagle's lastFolder).
import { api, on } from '../api';
import { readJSON, writeJSON } from '../storage';
import type { FilterSpec, QueryResult, Scope, SortSpec, AppSettings } from '../../../shared/types';

/** The longest a background refresh waits for a burst of changes to end. */
const REFRESH_MAX_WAIT = 1500;

function sameScope(a: Scope, b: Scope): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

class ViewStore {
  scope = $state<Scope>({ kind: 'all' });
  filter = $state<FilterSpec>({});
  sort = $state<SortSpec | null>(null);
  /** Raw: 85k ids must not become a deep proxy. Replace, never mutate. */
  result = $state.raw<QueryResult | null>(null);
  loading = $state(false);
  /**
   * The result may be missing items: it was asked for while the library's first scan was still
   * running (a newer one is on its way once the scan ends). Empty then doesn't mean empty.
   */
  partial = $state(false);
  error = $state<string | null>(null);

  layout = $state<AppSettings['layout']>('justified');
  thumbSize = $state(190);
  showNames = $state(true);
  showMeta = $state(true);
  showSubfolderContents = $state(true);
  /** Grayscale thumbnails for value checks (Ctrl+Alt+G in the grid). This session only. */
  grayscale = $state(false);
  /** A checkerboard behind thumbnails, to see transparency. Kept on this computer. */
  checker = $state(readJSON<boolean>('gridChecker', false) === true);

  back = $state.raw<Scope[]>([]);
  forward = $state.raw<Scope[]>([]);

  /** True when the filter has anything in it. */
  filtered = $derived(
    Object.values(this.filter).some(
      (v) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0),
    ),
  );

  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The pending run is for something the user did, not a background refresh. */
  private userRun = false;
  /** When the first of the background refreshes now waiting was asked for. */
  private waitingSince = 0;
  /** The open library's first scan is running (from the last 'library' event). */
  private scanning = false;
  private subscribed = false;

  applySettings(s: AppSettings): void {
    this.layout = s.layout;
    this.thumbSize = s.thumbSize;
    this.showNames = s.showNames;
    this.showMeta = s.showMeta;
    this.showSubfolderContents = s.showSubfolderContents;
  }

  /** The open library, for remembering where you were in it. */
  private libraryId: string | null = null;

  /**
   * A different library opened: start over, unfiltered and with no history, where you last were
   * in that library (as Eagle does), if `valid` says that place still exists; else at All.
   */
  reset(libraryId: string | null = null, valid: (s: Scope) => boolean = () => true): void {
    this.libraryId = libraryId;
    const last = libraryId ? readJSON<Scope | null>(`lastScope.${libraryId}`, null) : null;
    this.scope =
      last && typeof last === 'object' && valid(last)
        ? last.kind === 'folder'
          ? { ...last, includeSubfolders: this.showSubfolderContents }
          : last
        : { kind: 'all' };
    this.filter = {};
    this.sort = null;
    this.back = [];
    this.forward = [];
    this.result = null;
    this.partial = false;
    this.scanning = false; // the new library's own 'library' events say whether it is scanning
    this.error = null;
    this.run(0);
  }

  setScope(scope: Scope, opts: { keepFilter?: boolean } = {}): void {
    if (sameScope(scope, this.scope)) return;
    this.back = [...this.back, $state.snapshot(this.scope) as Scope].slice(-50);
    this.forward = [];
    this.scope = scope;
    if (!opts.keepFilter) this.filter = {};
    this.sort = null;
    this.remember();
    this.run(0);
  }

  private remember(): void {
    if (this.libraryId) writeJSON(`lastScope.${this.libraryId}`, $state.snapshot(this.scope));
  }

  goBack(): void {
    const prev = this.back.at(-1);
    if (!prev) return;
    this.forward = [$state.snapshot(this.scope) as Scope, ...this.forward];
    this.back = this.back.slice(0, -1);
    this.scope = prev;
    this.remember();
    this.run(0);
  }

  goForward(): void {
    const next = this.forward[0];
    if (!next) return;
    this.back = [...this.back, $state.snapshot(this.scope) as Scope];
    this.forward = this.forward.slice(1);
    this.scope = next;
    this.remember();
    this.run(0);
  }

  setFilter(patch: Partial<FilterSpec>): void {
    const next = { ...$state.snapshot(this.filter), ...patch } as FilterSpec;
    for (const k of Object.keys(next) as (keyof FilterSpec)[])
      if (next[k] === undefined) delete next[k];
    this.filter = next;
    this.run();
  }

  /** Replace the whole filter (a saved filter). */
  applyFilter(filter: FilterSpec): void {
    this.filter = filter;
    this.run(0);
  }

  clearFilter(): void {
    this.filter = {};
    this.run(0);
  }

  setSort(sort: SortSpec | null): void {
    this.sort = sort;
    this.run(0);
  }

  /** Re-run the query for something the user did (debounced; stale responses are dropped). */
  run(delay = 120): void {
    clearTimeout(this.timer);
    this.userRun = true;
    this.timer = setTimeout(() => void this.exec(), delay);
  }

  /**
   * Re-run the query because the library changed. A burst of changes is merged into one query
   * `delay` ms after the last of them, but a long burst never holds it back more than
   * REFRESH_MAX_WAIT: a first scan sends news every 250 ms for minutes, and the grid should fill
   * in while it runs instead of staying empty until the end.
   */
  refresh(delay: number): void {
    if (this.timer !== undefined && this.userRun) return; // that query will see the change too
    const now = Date.now();
    if (this.timer === undefined) this.waitingSince = now;
    clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(delay, this.waitingSince + REFRESH_MAX_WAIT - now));
    this.timer = setTimeout(() => void this.exec(), wait);
  }

  /** The result for the scope, filter and sort set now: runs a query that is still waiting or out. */
  async settled(): Promise<QueryResult | null> {
    if (this.timer === undefined && !this.loading) return this.result;
    clearTimeout(this.timer);
    await this.exec();
    return this.result;
  }

  private async exec(): Promise<void> {
    this.timer = undefined;
    this.userRun = false;
    const seq = ++this.seq;
    const scanning = this.scanning;
    this.loading = true;
    try {
      const res = await api.query({
        scope: $state.snapshot(this.scope) as Scope,
        filter: $state.snapshot(this.filter) as FilterSpec,
        sort: this.sort ? ($state.snapshot(this.sort) as SortSpec) : null,
      });
      if (seq !== this.seq) return;
      this.result = res;
      this.partial = scanning;
      this.error = null;
    } catch (e) {
      if (seq === this.seq) this.error = e instanceof Error ? e.message : String(e);
    } finally {
      if (seq === this.seq) this.loading = false;
    }
  }

  subscribe(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    // Adds/removes/edits can change membership and order; re-query quietly.
    on('itemsAdded', () => this.refresh(400));
    on('itemsRemoved', () => this.refresh(400));
    on('itemsChanged', () => this.refresh(600));
    on('library', (s) => {
      const ended = this.scanning && !s.indexing;
      this.scanning = !!s.indexing;
      this.refresh(ended ? 0 : 400); // the scan just ended: show everything now
    });
  }
}

export const view = new ViewStore();
