// The history list behind the History tab, the "N today" badge and "Last changed by".
import { api, on } from '../../lib/api';
import { errorText } from '../../lib/edit';
import { library } from '../../lib/stores/library.svelte';
import type { HistoryEntry } from '../../../shared/types';
import { countToday, reversedIds } from './logic';

const PAGE = 100;

class HistoryModel {
  entries = $state.raw<HistoryEntry[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);
  hasMore = $state(false);
  /** Ticks so "5 min ago" and the badge stay honest. */
  now = $state(Date.now());
  today = $derived(countToday(this.entries, this.now));
  /** Entries whose effect is reversed right now (undone, and not brought back by a redo). */
  reversed = $derived(reversedIds(this.entries));

  /** Set by the status strip's "Review": the History tab brings the changes the partner's Eagle
   *  may have overwritten into view, then clears it. */
  revealStale = $state(0);

  private libId: string | null = null;
  private seq = 0;

  /** Load (or reload) when the open library changes. */
  ensure(libId: string | null): void {
    if (libId === this.libId) return;
    this.libId = libId;
    this.entries = [];
    this.hasMore = false;
    if (libId) void this.reload();
  }

  async reload(): Promise<void> {
    const seq = ++this.seq;
    this.loading = true;
    try {
      const list = await api.listHistory({ limit: PAGE });
      if (seq !== this.seq) return;
      this.entries = list;
      this.hasMore = list.length >= PAGE;
      this.error = null;
    } catch (e) {
      if (seq === this.seq) this.error = errorText(e);
    } finally {
      if (seq === this.seq) this.loading = false;
    }
  }

  /** The next page. `before` is inclusive, so the page repeats the boundary entry (and any that
   *  share its millisecond); entries already here are dropped by groupId. */
  async more(): Promise<void> {
    const before = this.entries.at(-1)?.at;
    if (before === undefined || this.loading) return;
    const seq = this.seq;
    this.loading = true;
    try {
      const list = await api.listHistory({ limit: PAGE, before });
      if (seq !== this.seq) return;
      const have = new Set(this.entries.map((e) => e.groupId));
      const fresh = list.filter((e) => !have.has(e.groupId));
      this.entries = [...this.entries, ...fresh];
      // A page with nothing new means we reached the end.
      this.hasMore = list.length >= PAGE && fresh.length > 0;
    } catch (e) {
      if (seq === this.seq) this.error = errorText(e);
    } finally {
      this.loading = false;
    }
  }

  /** Load older pages until the list reaches back to `at` (a few pages at most). */
  async loadBack(at: number): Promise<void> {
    for (let i = 0; i < 5 && this.hasMore && (this.entries.at(-1)?.at ?? 0) > at; i++)
      await this.more();
  }

  /** A new entry (or a changed one, e.g. now undone) from the live feed. */
  add(entry: HistoryEntry): void {
    const rest = this.entries.filter((e) => e.groupId !== entry.groupId);
    this.entries = [entry, ...rest].sort((a, b) => b.at - a.at);
    // The undo entry itself is all the feed sends; the entry it reversed only learns it was
    // undone from the journal. That is written a moment after the feed fires, so wait a beat.
    if (entry.kind === 'undo') this.refreshSoon();
  }

  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshSoon(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refreshTop(), 400);
  }

  /** Re-read the newest page and fold it in, keeping any older pages already loaded ("Load more"). */
  async refreshTop(): Promise<void> {
    const seq = this.seq;
    try {
      const list = await api.listHistory({ limit: PAGE });
      if (seq !== this.seq) return;
      const fresh = new Set(list.map((e) => e.groupId));
      const older = this.entries.filter((e) => !fresh.has(e.groupId));
      this.entries = [...list, ...older].sort((a, b) => b.at - a.at);
      if (!older.length) this.hasMore = list.length >= PAGE;
    } catch {
      /* the list stays as it was */
    }
  }

  /** Follow the live feed while the inspector is mounted. Returns the stop function. */
  start(): () => void {
    this.now = Date.now();
    const tick = setInterval(() => (this.now = Date.now()), 30_000);
    const off = on('history', (e) => {
      const id = library.state?.ref.id;
      if (!id || e.libraryId === id) this.add(e);
    });
    return () => {
      clearInterval(tick);
      clearTimeout(this.refreshTimer);
      off();
    };
  }
}

export const history = new HistoryModel();
