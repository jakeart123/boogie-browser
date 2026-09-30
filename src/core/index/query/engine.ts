// The query engine: scopes + filters + sorts over the SQLite index (schema.sql), plus briefs, full
// items, smart folder counts and fuzzy suggestions. Read-only: it never writes to the index.
import type Database from 'better-sqlite3';
import type {
  EagleItemRecord,
  EagleSmartFolderRecord,
  Item,
  ItemBrief,
  QueryRequest,
  QueryResult,
  Scope,
  SortSpec,
} from '../../../shared/types';
import type { LibraryIndex, QueryEngine, UrlBuilder } from '../../contracts';
import { canRenderLocally } from '../../media/formats';
import { LOCKED_ROWIDS } from '../folders';
import { changesOf, PaletteCache, SmartMemberCache, type IndexChanges } from './caches';
import { compileFilter } from './filters';
import { DEFAULT_SORT, folderSort, isOrderBy, naturalKey, seededHash, sqlOrderExpr } from './sorts';
import {
  compileSmartFolder,
  evaluateSmartFolder,
  findSmartFolder,
  flattenSmartFolders,
  normalizeSmartFolders,
  type EvalContext,
  type SmartFolderEntry,
} from './smartFolders';
import { FALSE, frag, joinFrags, type SqlFrag } from './sql';
import {
  folderEntries,
  rankSuggestions,
  smartFolderEntries,
  tagEntries,
  type SuggestEntry,
  type SuggestKind,
} from './suggest';

type Stmt = Database.Statement<unknown[], unknown>;
type Row = [
  rowid: number,
  id: string,
  width: number | null,
  height: number | null,
  key?: string | null,
];
type PostFilter = (rec: EagleItemRecord) => boolean;

interface ScopePlan {
  where: SqlFrag;
  /** Set when a smart folder could not be compiled to exact SQL: its members (see smartMembers). */
  smart: SmartFolderEntry | null;
  /** MANUAL order uses this folder's `order` key. */
  manualFolderId: string | null;
}

/** Up to this many candidate items, the color search only looks at their swatches. */
const COLOR_SCOPED_MAX = 15_000;

/** SortSpec plus an optional seed (a RANDOM sort outside the Random scope reshuffles when it changes). */
type SeededSort = SortSpec & { seed?: number };

export class SqlQueryEngine implements QueryEngine {
  private readonly db: Database.Database;
  private readonly stmts = new Map<string, Stmt>();
  private readonly caches = new Map<string, { stamp: string; value: unknown }>();
  private readonly sessionSeed = (Math.random() * 0x7fffffff) | 0;
  private readonly changes: IndexChanges | null;
  private readonly smart: SmartMemberCache;
  private readonly palette: PaletteCache;

  constructor(
    private readonly index: LibraryIndex,
    private readonly urls: UrlBuilder,
    private readonly filePathOf: (id: string) => string,
  ) {
    this.db = index.db;
    this.changes = changesOf(index);
    this.smart = new SmartMemberCache(this.changes);
    this.palette = new PaletteCache(this.db, this.changes);
  }

  // ───────────────────────── plumbing ─────────────────────────

  private prepare(sql: string): Stmt {
    let s = this.stmts.get(sql);
    if (!s) {
      if (this.stmts.size > 200) this.stmts.clear();
      s = this.db.prepare(sql) as Stmt;
      this.stmts.set(sql, s);
    }
    return s;
  }

  /**
   * `build()`'s answer, kept until the index's counters say what it depends on changed: the root
   * (folders, smart folders, tag groups) or the item rows (and the root). An index without the
   * counters gets a fresh answer every time.
   */
  private cached<T>(key: string, dependsOn: 'root' | 'items', build: () => T): T {
    const v = this.changes?.versions();
    if (!v) return build();
    const stamp = dependsOn === 'root' ? `${v.root}` : `${v.items}:${v.root}`;
    const hit = this.caches.get(key);
    if (hit && hit.stamp === stamp) return hit.value as T;
    const value = build();
    this.caches.set(key, { stamp, value });
    return value;
  }

  private smartTree(): EagleSmartFolderRecord[] {
    return this.cached('smartTree', 'root', () =>
      normalizeSmartFolders(this.index.getRoot()?.smartFolders),
    );
  }

  private folderNames(): Map<string, string> {
    return this.cached('folderNames', 'root', () => {
      const m = new Map<string, string>();
      for (const r of this.prepare('SELECT id, name FROM folders').all() as {
        id: string;
        name: string;
      }[])
        m.set(r.id, r.name);
      return m;
    });
  }

  private evalContext(now: number): EvalContext {
    const names = this.folderNames();
    return { folderName: (id) => names.get(id), now };
  }

  // ───────────────────────── sorts ─────────────────────────

  defaultSort(scope: Scope): SortSpec {
    if (scope.kind === 'random') return { by: 'RANDOM', ascending: true };
    if (scope.kind === 'folder') {
      const row = this.prepare('SELECT order_by, sort_increase FROM folders WHERE id = ?').get(
        String(scope.id ?? ''),
      ) as { order_by: string | null; sort_increase: number | null } | undefined;
      if (row) return folderSort(row.order_by, row.sort_increase) ?? { ...DEFAULT_SORT };
    } else if (scope.kind === 'smartFolder') {
      const entry = findSmartFolder(this.smartTree(), String(scope.id ?? ''));
      if (entry)
        return folderSort(entry.node.orderBy, entry.node.sortIncrease) ?? { ...DEFAULT_SORT };
    }
    return { ...DEFAULT_SORT };
  }

  // ───────────────────────── scopes ─────────────────────────

  private scopePlan(scope: Scope, now: number): ScopePlan {
    const plain = (where: SqlFrag): ScopePlan => ({ where, smart: null, manualFolderId: null });
    switch (scope.kind) {
      case 'all':
      case 'random':
        return plain(frag('i.is_deleted = 0'));
      case 'uncategorized':
        return plain(frag('i.is_deleted = 0 AND i.folder_count = 0'));
      case 'untagged':
        return plain(frag('i.is_deleted = 0 AND i.tag_count = 0'));
      case 'trash':
        return plain(frag('i.is_deleted = 1'));
      case 'tag':
        return plain(
          frag(
            'i.is_deleted = 0 AND i.rowid IN (SELECT item_rowid FROM item_tags WHERE tag = ?)',
            String(scope.name ?? ''),
          ),
        );
      case 'ids':
        // Explicit ids include trashed items: "show what this change touched" must show them.
        return plain(
          frag(
            'i.id IN (SELECT value FROM json_each(?))',
            JSON.stringify(Array.isArray(scope.ids) ? scope.ids : []),
          ),
        );
      case 'folder': {
        const id = String(scope.id ?? '');
        const member = scope.includeSubfolders
          ? frag(
              'i.rowid IN (SELECT item_rowid FROM item_folders WHERE folder_id IN (SELECT descendant_id FROM folder_closure WHERE ancestor_id = ?))',
              id,
            )
          : frag('i.rowid IN (SELECT item_rowid FROM item_folders WHERE folder_id = ?)', id);
        return {
          where: joinFrags([frag('i.is_deleted = 0'), member], 'AND'),
          smart: null,
          manualFolderId: id,
        };
      }
      case 'smartFolder': {
        const entry = findSmartFolder(this.smartTree(), String(scope.id ?? ''));
        if (!entry) return plain(FALSE);
        const compiled = compileSmartFolder(entry.node, entry.ancestors, now);
        return {
          where: joinFrags(
            [frag('i.is_deleted = 0'), { sql: compiled.sql, params: compiled.params }],
            'AND',
          ),
          smart: compiled.exact ? null : entry,
          manualFolderId: null,
        };
      }
    }
  }

  /**
   * Items in password-locked folders stay hidden everywhere but the trash (Eagle never lists
   * trashed items as locked). Nothing to add in the usual case, a library without passwords.
   */
  private unlocked(scope: Scope): SqlFrag[] {
    if (scope.kind === 'trash') return [];
    const locked = this.cached('anyLocked', 'root', () =>
      Boolean(this.prepare('SELECT 1 FROM folders WHERE locked = 1 LIMIT 1').get()),
    );
    return locked ? [frag(`i.rowid NOT IN (${LOCKED_ROWIDS})`)] : [];
  }

  /** Rowids among the rows `where` selects that also pass `post` (the JS-only part of a smart folder). */
  private rowidsPassing(where: SqlFrag, post: PostFilter | null): Set<number> {
    if (!post)
      return new Set(
        this.prepare(`SELECT i.rowid FROM items i WHERE ${where.sql}`)
          .pluck()
          .all(...where.params) as number[],
      );
    const pass = new Set<number>();
    const stmt = this.prepare(`SELECT i.rowid, i.record_json FROM items i WHERE ${where.sql}`).raw(
      true,
    );
    for (const [rowid, json] of stmt.iterate(...where.params) as Iterable<[number, string]>) {
      let rec: EagleItemRecord;
      try {
        rec = JSON.parse(json);
      } catch {
        continue;
      }
      if (post(rec)) pass.add(rowid);
    }
    return pass;
  }

  /** The live, unlocked items in a smart folder (kept between queries: SmartMemberCache). */
  private smartMembers(entry: SmartFolderEntry, now: number): Set<number> {
    const { node, ancestors } = entry;
    const compiled = compileSmartFolder(node, ancestors, now);
    const where = joinFrags(
      [
        frag('i.is_deleted = 0'),
        ...this.unlocked({ kind: 'smartFolder', id: node.id }),
        { sql: compiled.sql, params: compiled.params },
      ],
      'AND',
    );
    const ctx = this.evalContext(now);
    const post: PostFilter | null = compiled.exact
      ? null
      : (rec) => evaluateSmartFolder(node, ancestors, rec, ctx);
    return this.smart.get(entry, now, (only) =>
      this.rowidsPassing(
        only
          ? joinFrags(
              [where, frag('i.rowid IN (SELECT value FROM json_each(?))', JSON.stringify(only))],
              'AND',
            )
          : where,
        post,
      ),
    );
  }

  // ───────────────────────── query ─────────────────────────

  query(req: QueryRequest): QueryResult {
    const t0 = performance.now();
    const now = Date.now();
    const plan = this.scopePlan(req.scope, now);
    const filter = compileFilter(req.filter, now);
    const where = joinFrags([plan.where, ...this.unlocked(req.scope), ...filter.where], 'AND');

    const asked = req.sort && isOrderBy(req.sort.by) ? (req.sort as SeededSort) : null;
    const sort: SeededSort = asked
      ? { by: asked.by, ascending: asked.ascending !== false, seed: asked.seed }
      : this.defaultSort(req.scope);

    let rows = this.fetchOrdered(where, sort, req.scope, plan.manualFolderId);

    if (plan.smart) {
      const members = this.smartMembers(plan.smart, now);
      rows = rows.filter((r) => members.has(r[0]));
    }
    if (filter.color) {
      const hits = this.palette.match(
        filter.color,
        rows.length <= COLOR_SCOPED_MAX ? new Set(rows.map((r) => r[0])) : null,
      );
      rows = rows.filter((r) => hits.has(r[0]));
    }

    const n = rows.length;
    const ids = new Array<string>(n);
    const aspects = new Array<number>(n);
    for (let k = 0; k < n; k++) {
      const r = rows[k];
      ids[k] = r[1];
      aspects[k] = r[2] && r[3] ? r[2] / r[3] : 1;
    }
    const applied: SortSpec = { by: sort.by, ascending: sort.ascending };
    return {
      total: n,
      ids,
      aspects,
      sort: applied,
      elapsedMs: Math.round((performance.now() - t0) * 10) / 10,
    };
  }

  /** Rows [rowid, id, width, height] in display order. Ties always break by id, ascending. */
  private fetchOrdered(
    where: SqlFrag,
    sort: SeededSort,
    scope: Scope,
    manualFolderId: string | null,
  ): Row[] {
    const sqlOrder = sqlOrderExpr(sort.by, manualFolderId);
    if (sqlOrder) {
      const dir = sort.ascending ? 'ASC' : 'DESC';
      const sql = `SELECT i.rowid, i.id, i.width, i.height FROM items i WHERE ${where.sql} ORDER BY ${sqlOrder.expr} ${dir}, i.id`;
      return this.prepare(sql)
        .raw(true)
        .all(...where.params, ...sqlOrder.params) as Row[];
    }

    // NAME (natural) and RANDOM (seeded) are ordered in JS.
    const keyExpr = sort.by === 'NAME' ? 'i.name' : 'NULL';
    const rows = this.prepare(
      `SELECT i.rowid, i.id, i.width, i.height, ${keyExpr} FROM items i WHERE ${where.sql}`,
    )
      .raw(true)
      .all(...where.params) as Row[];
    const n = rows.length;
    const sortKeys: (string | number)[] = new Array(n);
    if (sort.by === 'RANDOM') {
      const seed = scope.kind === 'random' ? scope.seed : (sort.seed ?? this.sessionSeed);
      for (let k = 0; k < n; k++) sortKeys[k] = seededHash(rows[k][1], seed);
    } else {
      for (let k = 0; k < n; k++) sortKeys[k] = naturalKey(rows[k][4] ?? '');
    }
    const order = Array.from({ length: n }, (_, k) => k);
    const sign = sort.by === 'RANDOM' || sort.ascending ? 1 : -1;
    order.sort((a, b) => {
      const ka = sortKeys[a];
      const kb = sortKeys[b];
      if (ka !== kb) return (ka < kb ? -1 : 1) * sign;
      const ia = rows[a][1];
      const ib = rows[b][1];
      return ia < ib ? -1 : ia > ib ? 1 : 0;
    });
    return order.map((k) => rows[k]);
  }

  // ───────────────────────── briefs and items ─────────────────────────

  briefs(ids: string[]): ItemBrief[] {
    if (ids.length === 0) return [];
    const rows = this.prepare(
      `SELECT i.id, i.name, i.ext, i.width, i.height, i.star, i.size, i.duration, i.is_deleted, i.no_preview, i.tag_count, i.last_modified, i.animated
       FROM items i WHERE i.id IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify(ids)) as {
      id: string;
      name: string;
      ext: string;
      width: number | null;
      height: number | null;
      star: number;
      size: number;
      duration: number | null;
      is_deleted: number;
      no_preview: number;
      tag_count: number;
      last_modified: number;
      animated: number;
    }[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: ItemBrief[] = [];
    for (const id of ids) {
      const r = byId.get(id);
      if (!r) continue;
      const brief: ItemBrief = {
        id: r.id,
        name: r.name,
        ext: r.ext,
        width: r.width,
        height: r.height,
        star: r.star,
        size: r.size,
        duration: r.duration,
        isDeleted: r.is_deleted === 1,
        noPreview: r.no_preview === 1,
        tagCount: r.tag_count,
        thumbUrl: this.urls.thumb(r.id, r.last_modified),
        version: r.last_modified,
      };
      // Icon-only in the library (Eagle can't draw it), but the thumb URL serves our own preview.
      if (r.no_preview === 1 && canRenderLocally(r.ext)) brief.localThumb = true;
      if (r.animated === 1) brief.animated = true;
      out.push(brief);
    }
    return out;
  }

  item(id: string): Item | null {
    return this.items([id])[0] ?? null;
  }

  items(ids: string[]): Item[] {
    if (ids.length === 0) return [];
    const rows = this.prepare(
      'SELECT i.id, i.record_json, i.last_modified FROM items i WHERE i.id IN (SELECT value FROM json_each(?))',
    ).all(JSON.stringify(ids)) as {
      id: string;
      record_json: string;
      last_modified: number;
    }[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: Item[] = [];
    for (const id of ids) {
      const r = byId.get(id);
      if (!r) continue;
      let rec: EagleItemRecord;
      try {
        rec = JSON.parse(r.record_json);
      } catch {
        continue; // the index only stores records that parsed, but never throw from a read
      }
      out.push(this.toItem(r.id, rec, r.last_modified));
    }
    return out;
  }

  private toItem(id: string, rec: EagleItemRecord, version: number): Item {
    const num = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null;
    return {
      id,
      name: typeof rec.name === 'string' ? rec.name : '',
      ext: typeof rec.ext === 'string' ? rec.ext : '',
      size: num(rec.size) ?? 0,
      width: num(rec.width),
      height: num(rec.height),
      star: num(rec.star) ?? 0,
      tags: Array.isArray(rec.tags) ? rec.tags : [],
      folders: Array.isArray(rec.folders) ? rec.folders : [],
      url: typeof rec.url === 'string' ? rec.url : '',
      annotation: typeof rec.annotation === 'string' ? rec.annotation : '',
      isDeleted: !!rec.isDeleted,
      deletedTime: num(rec.deletedTime),
      importedAt: Number(rec.modificationTime) || 0,
      modifiedAt: num(rec.lastModified) ?? 0,
      btime: num(rec.btime) ?? 0,
      mtime: num(rec.mtime) ?? 0,
      duration: num(rec.duration),
      palettes: Array.isArray(rec.palettes)
        ? rec.palettes
            .filter((p) => Array.isArray(p?.color) && p.color.length >= 3)
            .map((p) => ({ color: p.color, ratio: Number(p.ratio) || 0 }))
        : [],
      noThumbnail: !!rec.noThumbnail,
      noPreview: !!rec.noPreview,
      comments: Array.isArray(rec.comments) ? rec.comments : [],
      order: rec.order && typeof rec.order === 'object' ? rec.order : {},
      thumbUrl: this.urls.thumb(id, version),
      fileUrl: this.urls.file(id, version),
      previewUrl: this.urls.preview(id, typeof rec.ext === 'string' ? rec.ext : '', version),
      filePath: this.filePathOf(id),
      version,
    };
  }

  // ───────────────────────── smart folder counts ─────────────────────────

  smartFolderCounts(): Record<string, number> {
    const now = Date.now();
    const out: Record<string, number> = {};
    for (const entry of flattenSmartFolders(this.smartTree())) {
      // Eagle shows 0 for a folder with no conditions (a group of other smart folders).
      out[entry.node.id] =
        (entry.node.conditions ?? []).length === 0 ? 0 : this.smartMembers(entry, now).size;
    }
    // Smart folders that are gone don't keep their members around.
    this.smart.keepOnly(out);
    return out;
  }

  // ───────────────────────── suggestions ─────────────────────────

  suggest(
    text: string,
    kinds: SuggestKind[],
    limit: number,
  ): { kind: SuggestKind; id: string; label: string; path: string; count: number }[] {
    const entries: SuggestEntry[] = [];
    if (kinds.includes('tag'))
      entries.push(...this.cached('tagCorpus', 'items', () => tagEntries(this.index.tags())));
    if (kinds.includes('folder'))
      entries.push(...this.cached('folderCorpus', 'items', () => folderEntries(this.db)));
    if (kinds.includes('smartFolder'))
      entries.push(...smartFolderEntries(this.smartTree(), this.smartFolderCounts()));
    return rankSuggestions(entries, text, limit > 0 ? limit : 20);
  }
}
