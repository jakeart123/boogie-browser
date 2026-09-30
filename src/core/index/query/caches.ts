// What the query engine keeps between queries, and when it must forget it: a smart folder's
// members and the color search's swatches. Both follow the index's change counters
// (LibraryIndex.versions and changedRowidsSince).
import type Database from 'better-sqlite3';
import type { LibraryIndex } from '../../contracts';
import { PaletteMemory, type ColorQuery } from './color';
import type { SmartFolderEntry } from './smartFolders';

export type IndexChanges = Required<Pick<LibraryIndex, 'versions' | 'changedRowidsSince'>>;

/** The index's change counters, or null for an index without them (then nothing is kept). */
export function changesOf(index: LibraryIndex): IndexChanges | null {
  return index.versions && index.changedRowidsSince ? (index as IndexChanges) : null;
}

/** A smart folder's member rowids, as of the index's `items` version, for one root and minute. */
interface Members {
  key: string;
  items: number;
  set: Set<number>;
}

/** Does this smart folder (or an ancestor) have a rule whose answer moves with the clock? */
function usesClock(e: SmartFolderEntry): boolean {
  const list = <T>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : []);
  return [e.node, ...e.ancestors].some((f) =>
    list(f.conditions).some((c) => list(c?.rules).some((r) => r?.method === 'within')),
  );
}

/**
 * The live, unlocked items in each smart folder. Evaluating one can mean parsing every record
 * (regex, color and folder-name rules: ~280 ms on 85k items), so the answer is kept and, after
 * item edits, only the edited items are evaluated again. A new root (folder or smart folder
 * change) starts over, and so does the next minute for rules like "added within 3 days".
 */
export class SmartMemberCache {
  private readonly members = new Map<string, Members>();

  constructor(private readonly changes: IndexChanges | null) {}

  /**
   * `entry`'s members. `evaluate(only)` answers from the index: for the rows in `only`, or for
   * every row when it is null.
   */
  get(
    entry: SmartFolderEntry,
    now: number,
    evaluate: (only: number[] | null) => Set<number>,
  ): Set<number> {
    if (!this.changes) return evaluate(null);
    const v = this.changes.versions();
    const key = `${v.root}:${usesClock(entry) ? Math.floor(now / 60_000) : ''}`;
    const id = entry.node.id;
    const kept = this.members.get(id);
    const changed = kept?.key === key ? this.changes.changedRowidsSince(kept.items) : null;
    if (kept && changed) {
      if (changed.length) {
        const ids = [...new Set(changed)];
        const pass = evaluate(ids);
        for (const rowid of ids) {
          if (pass.has(rowid)) kept.set.add(rowid);
          else kept.set.delete(rowid);
        }
      }
      kept.items = v.items;
      return kept.set;
    }
    const set = evaluate(null);
    this.members.set(id, { key, items: v.items, set });
    return set;
  }

  /** Forget smart folders that are gone. */
  keepOnly(ids: Record<string, unknown>): void {
    if (this.members.size > Object.keys(ids).length)
      for (const id of this.members.keys()) if (!(id in ids)) this.members.delete(id);
  }
}

/**
 * Past this many items changed since the full load, the next palette change loads everything
 * again (455 ms on Master's 715k swatches) instead of adding to the side load (~1 ms per 100).
 */
const PALETTE_RELOAD_AFTER = 3000;

/**
 * The swatches for color search. All of them are loaded once (`base`); after that, a palette
 * change (an import, or the partner's Eagle filling in palettes) only loads the swatches of the items
 * written since (`recent`), and a match leaves those items out of the base answer.
 */
export class PaletteCache {
  private base: { items: number; memory: PaletteMemory } | null = null;
  private recent: { palette: number; changed: Set<number>; memory: PaletteMemory | null } | null =
    null;

  constructor(
    private readonly db: Database.Database,
    private readonly changes: IndexChanges | null,
  ) {}

  /** Rowids of the items with a matching swatch (see PaletteMemory.match). */
  match(q: ColorQuery, only: ReadonlySet<number> | null): Set<number> {
    if (!this.changes) return PaletteMemory.load(this.db).match(q, only);
    const v = this.changes.versions();
    if (!this.base || this.recent?.palette !== v.palette) this.update(v);
    const { changed, memory } = this.recent!;
    const hits = this.base!.memory.match(q, only, changed);
    if (memory) for (const rowid of memory.match(q, only)) hits.add(rowid);
    return hits;
  }

  private update(v: { items: number; palette: number }): void {
    const since = this.base ? this.changes!.changedRowidsSince(this.base.items) : null;
    const changed = since ? new Set(since) : null;
    if (!changed || changed.size > PALETTE_RELOAD_AFTER) {
      this.base = { items: v.items, memory: PaletteMemory.load(this.db) };
      this.recent = { palette: v.palette, changed: new Set(), memory: null };
    } else {
      const memory = changed.size ? PaletteMemory.load(this.db, [...changed]) : null;
      this.recent = { palette: v.palette, changed, memory };
    }
  }
}
