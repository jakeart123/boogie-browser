// The undo journal: every change to a library (ours, an agent's, or one that arrived from
// the partner) recorded OUTSIDE the library, grouped per action, with the exact before/after text.
// It powers the History tab and undo, and doubles as a backup of anything we overwrite.
//
//   <dir>/<libraryId>/journal.sqlite   groups, changes, blobs, moved_out, partner_pending (WAL)
//   <dir>/<libraryId>/store/           item folders moved out by "delete permanently"
//
// It also keeps, for a library shared with a partner, which items Boogie changed that the
// partner's Eagle may not have shown yet (and the copy it most likely still holds), so a stale
// overwrite from that Eagle can be recognised (stale.ts, service/partner), and whether each such
// entry was resolved: undone ("Put my change back") or kept as the partner's ("Keep theirs").
//
// See docs/specs/journal.md. The planning rules (what undo may touch) live in plan.ts,
// undoItem.ts and undoRoot.ts.
import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Actor, HistoryEntry } from '../../shared/types';
import type { Journal, JournalGroup, UndoPlan } from '../contracts';
import { isUndoablePath, planUndo as buildPlan, type CurrentState, type GroupChange } from './plan';
import { staleRevert } from './stale';
import type { Rec } from './util';

export { staleRevert } from './stale';

export interface JournalOptions {
  /** Journal root, e.g. ~/.local/share/boogie-browser/journal. One folder per library inside. */
  dir: string;
  /** How long history is kept. Default 90. */
  retentionDays?: number;
  /** Clock, for tests. */
  now?: () => number;
}

/** An item folder sitting in the journal store after "delete permanently". */
export interface StoredItem {
  itemId: string;
  storedAt: string;
  groupId: string;
  at: number;
}

/** The contract's Journal plus two read helpers the service and UI can use. */
export interface JournalStore extends Journal {
  /** Moved-out item folders still in the store, newest first. Never pruned automatically. */
  listStored(libraryId: string): StoredItem[];
  getEntry(groupId: string): HistoryEntry | null;
  markPartnerPending(groupId: string): void;
  clearPartnerPending(libraryId: string, ids: string[]): void;
  partnerPendingIds(libraryId: string, opts?: { unseenOnly?: boolean }): string[];
  partnerPendingBase(libraryId: string, id: string): string | null | undefined;
  partnerPendingState(
    libraryId: string,
    id: string,
  ): { base: string | null; seen: boolean } | undefined;
  partnerPendingCount(libraryId: string): number;
  markPartnerSeen(libraryId: string, ids: string[]): void;
  clearAllPartnerPending(libraryId: string): void;
  countStale(libraryId: string, since: number): number;
  markKeptTheirs(groupId: string): HistoryEntry | null;
}

const MAX_ITEM_IDS = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A "seen" pending row is dropped this long after it was marked (review5 should-fix 4). */
const SEEN_KEEP_MS = DAY_MS;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS groups (
  id          TEXT PRIMARY KEY,
  actor_kind  TEXT NOT NULL,
  actor_name  TEXT NOT NULL,
  label       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  at          INTEGER NOT NULL,
  item_ids    TEXT NOT NULL DEFAULT '[]',   -- JSON, first 500
  item_count  INTEGER NOT NULL DEFAULT 0,
  undoable    INTEGER NOT NULL DEFAULT 1,
  undone_by   TEXT,
  undo_of     TEXT,
  stale       INTEGER NOT NULL DEFAULT 0,     -- an external stale overwrite (see stale.ts)
  kept        INTEGER NOT NULL DEFAULT 0      -- ...resolved by keeping the partner's version
);
CREATE INDEX IF NOT EXISTS groups_at ON groups(at);
CREATE TABLE IF NOT EXISTS changes (
  group_id    TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  rel_path    TEXT NOT NULL,
  item_id     TEXT,
  before_hash TEXT,                          -- NULL = the file did not exist
  after_hash  TEXT,                          -- NULL = the file was removed
  PRIMARY KEY (group_id, seq)
) WITHOUT ROWID;
-- Content-addressed by sha1: a 500-item batch with identical before-texts stores one blob.
CREATE TABLE IF NOT EXISTS blobs (
  hash TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  at   INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS blobs_at ON blobs(at);
-- Written the moment a folder is moved out (not at commit), so a crash never loses track of it.
CREATE TABLE IF NOT EXISTS moved_out (
  group_id  TEXT NOT NULL,
  item_id   TEXT NOT NULL,
  stored_at TEXT NOT NULL,
  at        INTEGER NOT NULL,
  PRIMARY KEY (group_id, item_id)
) WITHOUT ROWID;
-- Shared libraries: items Boogie changed that the partner's Eagle may not have shown yet, with the
-- text it most likely still holds (the item before the first such change). NULL: not known.
-- seen = 1: their running Eagle most likely re-read our version (not proof: see service/partner);
-- at is then when it was marked seen, and the row is dropped a day later.
CREATE TABLE IF NOT EXISTS partner_pending (
  item_id   TEXT PRIMARY KEY,
  base_hash TEXT,
  at        INTEGER NOT NULL,
  seen      INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
-- For a stale-overwrite group: per item, the copy the partner's Eagle held (so undo keeps their new edits).
CREATE TABLE IF NOT EXISTS stale_bases (
  group_id  TEXT NOT NULL,
  item_id   TEXT NOT NULL,
  base_hash TEXT NOT NULL,
  PRIMARY KEY (group_id, item_id)
) WITHOUT ROWID;
`;
// v3 added groups.heal (automatic repair, removed since: journals that have it still open).
const SCHEMA_VERSION = 4;

/** One file change as stored: texts live in `blobs`, keyed by sha1. */
interface ChangeRow {
  relPath: string;
  itemId: string | null;
  beforeHash: string | null;
  afterHash: string | null;
}

/** What a begun-but-not-committed group has recorded so far (hashes only: the texts are already on disk). */
interface Buffer {
  group: JournalGroup;
  changes: ChangeRow[];
  moves: number;
}

interface GroupRow {
  id: string;
  actor_kind: Actor['kind'];
  actor_name: string;
  label: string;
  kind: HistoryEntry['kind'];
  at: number;
  item_ids: string;
  item_count: number;
  undoable: number;
  undone_by: string | null;
  undo_of: string | null;
  stale: number;
  kept: number;
}

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');

/** Older databases get the columns and indexes the newer code relies on. */
function migrate(db: Database.Database): void {
  if ((db.pragma('user_version', { simple: true }) as number) >= SCHEMA_VERSION) return;
  const addColumn = (table: string, col: string, decl: string) => {
    const cols = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).pluck().all();
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  };
  db.transaction(() => {
    addColumn('groups', 'stale', 'INTEGER NOT NULL DEFAULT 0');
    addColumn('groups', 'kept', 'INTEGER NOT NULL DEFAULT 0');
    addColumn('partner_pending', 'seen', 'INTEGER NOT NULL DEFAULT 0');
    db.exec('CREATE INDEX IF NOT EXISTS changes_item ON changes(item_id)');
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}

/** Group ids start with the library id so planUndo(groupId) can find the right database. */
function newGroupId(libraryId: string): string {
  return `${libraryId}.${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
}

function libraryOfGroup(groupId: string): string {
  const dot = groupId.lastIndexOf('.');
  if (dot <= 0) throw new Error(`Unknown history group: ${groupId}`);
  return groupId.slice(0, dot);
}

function safeLibraryId(libraryId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(libraryId))
    throw new Error(`Bad library id: ${libraryId}`);
  return libraryId;
}

/** Eagle's own mtime.json is raised again by the adapter on undo, and it can be megabytes. */
function isMtimeIndex(relPath: string): boolean {
  return relPath === 'mtime.json';
}

export function createJournal(opts: JournalOptions): JournalStore {
  return new JournalImpl(opts);
}

class JournalImpl implements JournalStore {
  private dbs = new Map<string, Database.Database>();
  private buffers = new Map<string, Buffer>();
  /** markUndone can arrive before the undo group commits; the link waits for the commit. */
  private pendingUndoOf = new Map<string, string>();
  private readonly now: () => number;
  private readonly retentionMs: number;

  constructor(private readonly opts: JournalOptions) {
    this.now = opts.now ?? Date.now;
    this.retentionMs = (opts.retentionDays ?? 90) * DAY_MS;
  }

  // ───────────────────────── JournalSink (what the Eagle adapter calls) ─────────────────────────

  storeDirFor(libraryId: string): string {
    const dir = join(this.opts.dir, safeLibraryId(libraryId), 'store');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  begin(libraryId: string, actor: Actor, label: string, kind: HistoryEntry['kind']): JournalGroup {
    safeLibraryId(libraryId);
    const group: JournalGroup = { id: newGroupId(libraryId), libraryId, actor, label, kind };
    this.buffers.set(group.id, { group, changes: [], moves: 0 });
    return group;
  }

  recordFile(
    group: JournalGroup,
    change: { relPath: string; before: string | null; after: string | null; itemId: string | null },
  ): void {
    const relPath = change.relPath.replace(/\\/g, '/');
    if (change.before === change.after || isMtimeIndex(relPath)) return;
    const buf = this.bufferFor(group);
    // Both texts go to disk right now: a crash mid-batch still leaves the old text behind, and an
    // 85k-item batch doesn't hold every new text in memory until commit. Errors propagate on
    // purpose: no journal entry means the caller must not write.
    const db = this.db(group.libraryId);
    buf.changes.push({
      relPath,
      itemId: change.itemId,
      beforeHash: change.before === null ? null : this.putBlob(db, change.before),
      afterHash: change.after === null ? null : this.putBlob(db, change.after),
    });
  }

  recordMoveOut(group: JournalGroup, change: { itemId: string; storedAt: string }): void {
    const buf = this.bufferFor(group);
    this.db(group.libraryId)
      .prepare(
        'INSERT OR REPLACE INTO moved_out (group_id, item_id, stored_at, at) VALUES (?, ?, ?, ?)',
      )
      .run(group.id, change.itemId, change.storedAt, this.now());
    buf.moves++;
  }

  // ───────────────────────── Journal ─────────────────────────

  commit(group: JournalGroup, summary: { itemIds: string[] }): HistoryEntry | null {
    const buf = this.buffers.get(group.id);
    this.buffers.delete(group.id);
    const undoOf = this.pendingUndoOf.get(group.id) ?? null;
    this.pendingUndoOf.delete(group.id);
    // An undo that changed nothing leaves its target undoable.
    if (!buf || (buf.changes.length === 0 && buf.moves === 0)) return null;

    const db = this.db(group.libraryId);
    const ids = [...new Set(summary.itemIds)];
    const undoable = buf.moves > 0 || buf.changes.some((c) => isUndoablePath(c.relPath));
    const row: GroupRow = {
      id: group.id,
      actor_kind: group.actor.kind,
      actor_name: group.actor.name,
      label: group.label,
      kind: group.kind,
      at: this.now(),
      item_ids: JSON.stringify(ids.slice(0, MAX_ITEM_IDS)),
      item_count: ids.length,
      undoable: undoable ? 1 : 0,
      undone_by: null,
      undo_of: undoOf,
      stale: 0,
      kept: 0,
    };
    this.insertGroup(db, row, buf.changes);
    if (undoOf) db.prepare('UPDATE groups SET undone_by = ? WHERE id = ?').run(group.id, undoOf);
    return this.toEntry(group.libraryId, row);
  }

  /**
   * `staleBases` marks the group as a stale overwrite (HistoryEntry.staleOverwrite): per item, the
   * copy the partner's Eagle held. Undoing the group then puts back only what that copy reverted.
   */
  recordExternal(
    libraryId: string,
    actor: Actor,
    changes: {
      itemId: string | null;
      relPath: string;
      before: string | null;
      after: string | null;
    }[],
    label: string,
    opts: { staleBases?: Record<string, string> } = {},
  ): HistoryEntry | null {
    const real = changes.filter(
      (c) => c.before !== c.after && !isMtimeIndex(c.relPath.replace(/\\/g, '/')),
    );
    if (real.length === 0) return null;
    const db = this.db(libraryId);
    const ids = [...new Set(real.flatMap((c) => (c.itemId ? [c.itemId] : [])))];
    const touched = new Set(ids);
    const bases = Object.entries(opts.staleBases ?? {}).filter(([id]) => touched.has(id));
    const row: GroupRow = {
      id: newGroupId(libraryId),
      actor_kind: actor.kind,
      actor_name: actor.name,
      label,
      kind: 'external',
      at: this.now(),
      item_ids: JSON.stringify(ids.slice(0, MAX_ITEM_IDS)),
      item_count: ids.length,
      undoable: real.some((c) => isUndoablePath(c.relPath.replace(/\\/g, '/'))) ? 1 : 0,
      undone_by: null,
      undo_of: null,
      stale: bases.length ? 1 : 0,
      kept: 0,
    };
    db.transaction(() => {
      this.insertGroup(
        db,
        row,
        real.map((c) => ({
          relPath: c.relPath.replace(/\\/g, '/'),
          itemId: c.itemId,
          beforeHash: c.before === null ? null : this.putBlob(db, c.before),
          afterHash: c.after === null ? null : this.putBlob(db, c.after),
        })),
      );
      const insert = db.prepare(
        'INSERT INTO stale_bases (group_id, item_id, base_hash) VALUES (?, ?, ?)',
      );
      for (const [id, text] of bases) insert.run(row.id, id, this.putBlob(db, text));
    })();
    return this.toEntry(libraryId, row);
  }

  // ───────────────────────── partner-pending items ─────────────────────────

  /**
   * After a Boogie group in a shared library commits: every existing item it changed becomes
   * pending, keeping the text from before the FIRST pending change (what the partner's Eagle
   * still holds). An item their Eagle had most likely picked up (seen) starts over from this change.
   * New items are left out: Eagle always reads an item folder it hasn't seen.
   */
  markPartnerPending(groupId: string): void {
    const db = this.db(libraryOfGroup(groupId), false);
    db?.prepare(
      `INSERT INTO partner_pending (item_id, base_hash, at, seen)
       SELECT item_id, before_hash, ?, 0 FROM changes
       WHERE group_id = ? AND item_id IS NOT NULL AND before_hash IS NOT NULL
         AND rel_path = 'images/' || item_id || '.info/metadata.json'
       ORDER BY seq
       ON CONFLICT(item_id) DO UPDATE SET base_hash = excluded.base_hash, at = excluded.at, seen = 0
         WHERE partner_pending.seen = 1`,
    ).run(this.now(), groupId);
  }

  clearPartnerPending(libraryId: string, ids: string[]): void {
    const db = this.db(libraryId, false);
    if (!db || !ids.length) return;
    const del = db.prepare('DELETE FROM partner_pending WHERE item_id = ?');
    db.transaction(() => {
      for (const id of ids) del.run(id);
    })();
  }

  clearAllPartnerPending(libraryId: string): void {
    this.db(libraryId, false)?.exec('DELETE FROM partner_pending');
  }

  markPartnerSeen(libraryId: string, ids: string[]): void {
    const db = this.db(libraryId, false);
    if (!db || !ids.length) return;
    const mark = db.prepare('UPDATE partner_pending SET seen = 1, at = ? WHERE item_id = ?');
    const now = this.now();
    db.transaction(() => {
      for (const id of ids) mark.run(now, id);
    })();
  }

  /** Oldest first. */
  partnerPendingIds(libraryId: string, opts: { unseenOnly?: boolean } = {}): string[] {
    const db = this.db(libraryId, false);
    if (!db) return [];
    const where = opts.unseenOnly ? 'WHERE seen = 0 ' : '';
    return db
      .prepare(`SELECT item_id FROM partner_pending ${where}ORDER BY at`)
      .pluck()
      .all() as string[];
  }

  partnerPendingCount(libraryId: string): number {
    const db = this.db(libraryId, false);
    if (!db) return 0;
    return db
      .prepare('SELECT COUNT(*) FROM partner_pending WHERE seen = 0')
      .pluck()
      .get() as number;
  }

  /** The copy the partner's Eagle most likely holds; null if unknown, undefined if not pending. */
  partnerPendingBase(libraryId: string, id: string): string | null | undefined {
    return this.partnerPendingState(libraryId, id)?.base;
  }

  partnerPendingState(
    libraryId: string,
    id: string,
  ): { base: string | null; seen: boolean } | undefined {
    const row = this.db(libraryId, false)
      ?.prepare(
        'SELECT b.text AS text, p.seen AS seen FROM partner_pending p LEFT JOIN blobs b ON b.hash = p.base_hash WHERE p.item_id = ?',
      )
      .get(id) as { text: string | null; seen: number } | undefined;
    return row ? { base: row.text ?? null, seen: row.seen === 1 } : undefined;
  }

  // ───────────────────────── stale-overwrite entries ─────────────────────────

  /** Stale-overwrite entries since `since` nobody has resolved yet (the status notice). */
  countStale(libraryId: string, since: number): number {
    const db = this.db(libraryId, false);
    if (!db) return 0;
    return db
      .prepare(
        'SELECT COUNT(*) FROM groups WHERE stale = 1 AND kept = 0 AND undone_by IS NULL AND at >= ?',
      )
      .pluck()
      .get(since) as number;
  }

  /** "Keep theirs": the partner's version stands; nothing on disk changes. The entry, or null. */
  markKeptTheirs(groupId: string): HistoryEntry | null {
    try {
      const libraryId = libraryOfGroup(groupId);
      const db = this.db(libraryId, false);
      db?.prepare('UPDATE groups SET kept = 1 WHERE id = ? AND stale = 1').run(groupId);
      return this.getEntry(groupId);
    } catch {
      return null; // not one of our group ids
    }
  }

  /** Newest first. `before` is inclusive (at <= before), so a page boundary never skips a group; callers dedupe by groupId. */
  list(libraryId: string, opts: { limit?: number; before?: number } = {}): HistoryEntry[] {
    const db = this.db(libraryId, false);
    if (!db) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 5000));
    const rows = db
      .prepare('SELECT * FROM groups WHERE at <= ? ORDER BY at DESC, rowid DESC LIMIT ?')
      .all(opts.before ?? Number.MAX_SAFE_INTEGER, limit) as GroupRow[];
    return rows.map((r) => this.toEntry(libraryId, r));
  }

  getEntry(groupId: string): HistoryEntry | null {
    try {
      const libraryId = libraryOfGroup(groupId);
      const row = this.db(libraryId, false)
        ?.prepare('SELECT * FROM groups WHERE id = ?')
        .get(groupId) as GroupRow | undefined;
      return row ? this.toEntry(libraryId, row) : null;
    } catch {
      return null; // not one of our group ids
    }
  }

  async planUndo(groupId: string, current: CurrentState): Promise<UndoPlan> {
    const libraryId = libraryOfGroup(groupId);
    const db = this.db(libraryId, false);
    const row = db?.prepare('SELECT * FROM groups WHERE id = ?').get(groupId) as
      GroupRow | undefined;
    if (!db || !row) throw new Error(`Unknown history group: ${groupId}`);
    const label = `Undo: ${row.label}`;
    if (row.undone_by) {
      // Already undone: hand back an empty plan rather than undoing twice.
      return {
        groupId,
        items: [],
        root: null,
        moveBackIn: [],
        conflicts: [{ id: groupId, field: 'group', reason: 'already undone' }],
        label,
      };
    }
    const moves = (
      db.prepare('SELECT item_id, stored_at FROM moved_out WHERE group_id = ?').all(groupId) as {
        item_id: string;
        stored_at: string;
      }[]
    ).map((m) => ({
      itemId: m.item_id,
      storedAt: m.stored_at,
    }));
    let changes = this.netChanges(db, groupId);
    if (row.stale) changes = this.limitToReverts(db, groupId, changes);
    return buildPlan({ id: groupId, label: row.label, changes, moves }, current);
  }

  /**
   * Link an undo group to the group it undid. Before the undo group commits, the link waits and
   * lands at commit (so the committed entry already carries `undoOf`), or is dropped if the undo
   * changed nothing. After commit it applies right away.
   */
  markUndone(groupId: string, undoGroupId: string): void {
    if (!undoGroupId) return;
    if (this.buffers.has(undoGroupId)) {
      this.pendingUndoOf.set(undoGroupId, groupId);
      return;
    }
    const db = this.db(libraryOfGroup(groupId), false);
    if (!db) return;
    const linked = db
      .prepare('UPDATE groups SET undo_of = ? WHERE id = ?')
      .run(groupId, undoGroupId);
    if (linked.changes === 0) return; // not a committed group of this library: nothing to link
    db.prepare('UPDATE groups SET undone_by = ? WHERE id = ?').run(undoGroupId, groupId);
  }

  listStored(libraryId: string): StoredItem[] {
    const db = this.db(libraryId, false);
    if (!db) return [];
    const rows = db
      .prepare('SELECT group_id, item_id, stored_at, at FROM moved_out ORDER BY at DESC')
      .all() as { group_id: string; item_id: string; stored_at: string; at: number }[];
    return rows
      .filter((r) => existsSync(r.stored_at))
      .map((r) => ({ itemId: r.item_id, storedAt: r.stored_at, groupId: r.group_id, at: r.at }));
  }

  close(): void {
    for (const db of this.dbs.values()) db.close();
    this.dbs.clear();
    this.buffers.clear();
  }

  // ───────────────────────── internals ─────────────────────────

  private bufferFor(group: JournalGroup): Buffer {
    let buf = this.buffers.get(group.id);
    if (!buf) this.buffers.set(group.id, (buf = { group, changes: [], moves: 0 }));
    return buf;
  }

  /** Open (and with `create`, make) one library's database. Old history is pruned on open. */
  private db(libraryId: string, create?: true): Database.Database;
  private db(libraryId: string, create: boolean): Database.Database | null;
  private db(libraryId: string, create = true): Database.Database | null {
    let db = this.dbs.get(libraryId);
    if (db) return db;
    const dir = join(this.opts.dir, safeLibraryId(libraryId));
    const file = join(dir, 'journal.sqlite');
    if (!create && !existsSync(file)) return null;
    mkdirSync(dir, { recursive: true });
    db = new Database(file);
    db.exec(SCHEMA);
    migrate(db);
    this.prune(db);
    this.dbs.set(libraryId, db);
    return db;
  }

  /**
   * Retention: drop history older than the limit, and blobs nothing points at any more. Blobs
   * left by a crashed batch (never committed) age out the same way, so they stay recoverable
   * for the full period. Groups that moved items into the store are kept: those folders are
   * never pruned automatically.
   */
  private prune(db: Database.Database): void {
    const cutoff = this.now() - this.retentionMs;
    const old = 'at < ? AND NOT EXISTS (SELECT 1 FROM moved_out m WHERE m.group_id = groups.id)';
    db.transaction(() => {
      db.prepare('DELETE FROM partner_pending WHERE seen = 1 AND at < ?').run(
        this.now() - SEEN_KEEP_MS,
      );
      for (const table of ['changes', 'stale_bases'])
        db.prepare(
          `DELETE FROM ${table} WHERE group_id IN (SELECT id FROM groups WHERE ${old})`,
        ).run(cutoff);
      db.prepare(`DELETE FROM groups WHERE ${old}`).run(cutoff);
      db.prepare(
        `DELETE FROM blobs WHERE at < ? AND hash NOT IN (
           SELECT before_hash FROM changes WHERE before_hash IS NOT NULL
           UNION SELECT after_hash FROM changes WHERE after_hash IS NOT NULL
           UNION SELECT base_hash FROM partner_pending WHERE base_hash IS NOT NULL
           UNION SELECT base_hash FROM stale_bases)`,
      ).run(cutoff);
    })();
  }

  private putBlob(db: Database.Database, text: string): string {
    const hash = sha1(text);
    db.prepare('INSERT OR IGNORE INTO blobs (hash, text, at) VALUES (?, ?, ?)').run(
      hash,
      text,
      this.now(),
    );
    return hash;
  }

  /** The group row and its change rows, in one transaction. */
  private insertGroup(db: Database.Database, r: GroupRow, changes: ChangeRow[]): void {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO groups (id, actor_kind, actor_name, label, kind, at, item_ids, item_count, undoable, undone_by, undo_of, stale, kept)
         VALUES (@id, @actor_kind, @actor_name, @label, @kind, @at, @item_ids, @item_count, @undoable, @undone_by, @undo_of, @stale, @kept)`,
      ).run(r);
      const insert = db.prepare(
        'INSERT INTO changes (group_id, seq, rel_path, item_id, before_hash, after_hash) VALUES (?, ?, ?, ?, ?, ?)',
      );
      changes.forEach((c, seq) =>
        insert.run(r.id, seq, c.relPath, c.itemId, c.beforeHash, c.afterHash),
      );
    })();
  }

  /** Per file, the first before and last after, so a two-step write (import) reads as one change. */
  private netChanges(db: Database.Database, groupId: string): GroupChange[] {
    const rows = db
      .prepare(
        'SELECT rel_path, item_id, before_hash, after_hash FROM changes WHERE group_id = ? ORDER BY seq',
      )
      .all(groupId) as {
      rel_path: string;
      item_id: string | null;
      before_hash: string | null;
      after_hash: string | null;
    }[];
    const net = new Map<
      string,
      { itemId: string | null; before: string | null; after: string | null }
    >();
    for (const r of rows) {
      const seen = net.get(r.rel_path);
      if (seen) seen.after = r.after_hash;
      else net.set(r.rel_path, { itemId: r.item_id, before: r.before_hash, after: r.after_hash });
    }
    const text = db.prepare('SELECT text FROM blobs WHERE hash = ?').pluck();
    const read = (hash: string | null) =>
      hash === null ? null : ((text.get(hash) as string | undefined) ?? null);
    return [...net]
      .filter(([, n]) => n.before !== n.after)
      .map(([relPath, n]) => ({
        relPath,
        itemId: n.itemId,
        before: read(n.before),
        after: read(n.after),
      }));
  }

  /** A stale overwrite's undo puts back only what the old copy reverted (stale.ts). */
  private limitToReverts(db: Database.Database, groupId: string, changes: GroupChange[]) {
    const bases = new Map(
      (
        db
          .prepare(
            'SELECT s.item_id AS id, b.text AS text FROM stale_bases s JOIN blobs b ON b.hash = s.base_hash WHERE s.group_id = ?',
          )
          .all(groupId) as { id: string; text: string }[]
      ).map((r) => [r.id, r.text]),
    );
    const parse = (t: string | null): Rec | null => {
      try {
        const v: unknown = t === null ? null : JSON.parse(t);
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null;
      } catch {
        return null;
      }
    };
    return changes.map((c) => {
      const base = c.itemId ? parse(bases.get(c.itemId) ?? null) : null;
      const ours = parse(c.before);
      const theirs = parse(c.after);
      if (!base || !ours || !theirs) return c;
      const limited = staleRevert(base, ours, theirs);
      return { ...c, after: JSON.stringify(limited ?? ours) };
    });
  }

  private toEntry(libraryId: string, r: GroupRow): HistoryEntry {
    return {
      groupId: r.id,
      libraryId,
      actor: { kind: r.actor_kind, name: r.actor_name },
      label: r.label,
      at: r.at,
      itemIds: JSON.parse(r.item_ids) as string[],
      itemCount: r.item_count,
      kind: r.kind,
      // An undone action is not offered again; redo is the undo group's own entry.
      undoable: r.undoable === 1 && r.undone_by === null,
      undoneBy: r.undone_by,
      undoOf: r.undo_of,
      ...(r.stale ? { staleOverwrite: true } : {}),
      ...(r.kept ? { keptTheirs: true } : {}),
    };
  }
}
