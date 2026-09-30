// LibraryWatcher: notices changes that arrive from outside (the partner's Eagle via Dropbox, a
// Wine Eagle on this machine) and tells the service which items to re-read.
//
// Why it looks the way it does (research/tech-notes.md §4, format-spec.md §13):
// - Never recursive. An item is a folder, so watching recursively would cost one inotify watch
//   per item (85k) on top of the ones Dropbox already holds. We watch the library root and
//   `images/` non-recursively and let `mtime.json` tell us which existing items changed.
// - Item edits only count when `mtime.json[id]` goes up (that is how Eagle itself notices them),
//   root edits only when `modificationTime` goes up.
// - Dropbox delivers files by rename and non-atomically, so a JSON file that fails to parse means
//   "still syncing": retry on the next poll, never treat it as a change or a deletion.
// - Dropbox also has no order: mtime.json can land before the item file it points at, and a new
//   `<id>.info` folder before its metadata.json. So an id we report whose file isn't there yet (or
//   is an older copy) is watched for a while, and reported again when its file arrives.
// - Our own writes echo back through the same channels; `lib.recentSelfWrites()` lets us skip them.
// - A partner's Eagle rewrites mtime.json from memory about 3 s after each of its saves, which can
//   swallow or revert one of our raises (test/eagle-proof FINDINGS 2). Such a "foreign" rewrite is
//   reported with the ids we raised lately, so the service can judge which need raising again. It
//   also tells us that Eagle is running. A Boogie on another computer (raising only its own
//   marked, backdated values, eagle/stamp.ts) is not that, though it may still undo a raise. Eagle's `backup/backup-*.json` files are no signal:
//   one comes with each of those rewrites anyway, they keep the root's time, and Boogie writes
//   them too (eagle-proof FINDINGS-2 R2-4).
// - A value that goes DOWN is a rewrite from someone's memory, or a save by a partner whose clock
//   is behind ours: either way that item is read again.
//
// The watcher only READS the library (stat, readFile). It never writes.
import { statSync, watch, type FSWatcher } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConflictFile } from '../../shared/types';
import type { EagleLibrary, LibraryWatcher, WatchEvents } from '../contracts';
import { isBoogieWrite, isConflictedCopy } from '../eagle';
import { isPlainObject } from '../eagle/json';
import { rootConflicts } from './conflicts';

export interface WatcherOptions {
  /** Backstop poll of metadata.json / mtime.json / root conflicts. Default 2000. */
  pollMs?: number;
  /** Quiet time after the last `images/` event before we report (Dropbox renames in bursts). Default 1500. */
  itemDebounceMs?: number;
  /** A burst that never goes quiet still gets reported after this long. Default 8000. */
  itemMaxWaitMs?: number;
  /** Delay between a root-level fs event and the check it triggers. Default 250. */
  rootDebounceMs?: number;
  /**
   * How long a reported id whose file hasn't arrived yet is watched (checked every poll). Default
   * 120000: when a partner's Eagle writes a thousand items, Dropbox can take well over 30 s.
   */
  recheckMs?: number;
}

/** A watcher whose `poke()` also tells you when the poll it started has finished (handy in tests). */
export interface PokeableWatcher extends LibraryWatcher {
  poke(): Promise<void>;
}

const ID_LENGTHS = new Set([13, 36]);
/** Ids watched for a late file at once; beyond this the index's next sync still catches them. */
const MAX_PENDING = 5000;
/** Our raises this recent are handed over with a foreign mtime.json rewrite (Eagle's lands ~3 s after its save). */
const RAISED_WINDOW_MS = 20_000;
const ROOT_FILES = { 'tags.json': 'tags', 'saved-filters.json': 'savedFilters' } as const;
type RootFile = keyof typeof ROOT_FILES;

/** An id we reported before its file was what the report promised. */
interface Pending {
  /** The mtime.json value its record must reach, or null (a new folder: any readable record). */
  want: number | null;
  /** metadata.json's stat when we last looked. */
  sig: string;
  until: number;
}

function itemIdFromName(name: string): string | null {
  if (!name.endsWith('.info')) return null;
  const id = name.slice(0, -5);
  return ID_LENGTHS.has(id.length) ? id : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Changes whenever a file is replaced or rewritten (Dropbox and Eagle both replace by rename). */
const statSig = (st: { ino: number; size: number; mtimeMs: number }) =>
  `${st.ino}:${st.size}:${st.mtimeMs}`;

class Session {
  private stopped = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private rootTimer: NodeJS.Timeout | null = null;
  private itemTimer: NodeJS.Timeout | null = null;
  private rootWatcher: FSWatcher | null = null;
  private imagesWatcher: FSWatcher | null = null;
  /** Inode of the folder each watcher follows: fs.watch keeps following a folder that was moved away. */
  private readonly watchedIno = { root: 0, images: 0 };
  private readonly pending = new Map<string, Pending>();

  // Everything runs on one promise chain so a poll never overlaps another one.
  private chain: Promise<void>;
  private queuedPoll: Promise<void> | null = null;

  // What we last saw. Baselines are captured in init(), before any event can be reported.
  private rootSig: string | null = null;
  private rootMod: number | null = null;
  private mtimeSig: string | null = null;
  private prevMtime: Record<string, unknown> | null = null;
  private prevMtimeText = '';
  private readonly rootFileSigs = new Map<RootFile, string>();
  private readonly known = new Map<string, number>(); // highest mtime.json value ever seen per id
  private readonly conflicts = new Map<string, ConflictFile>();
  private conflictKey = '';

  // `images/` events waiting out the debounce.
  private pendingIds = new Set<string>();
  private pendingListDir = false;
  private pendingSince = 0;

  private readonly root: string;

  constructor(
    private readonly lib: EagleLibrary,
    private readonly events: WatchEvents,
    private readonly o: Required<WatcherOptions>,
  ) {
    this.root = lib.root;
    this.startWatchers();
    this.chain = this.init();
    void this.chain.then(() => this.armPoll());
  }

  // ───────────────────────── lifecycle ─────────────────────────

  stop(): void {
    this.stopped = true;
    for (const t of [this.pollTimer, this.rootTimer, this.itemTimer]) if (t) clearTimeout(t);
    this.pollTimer = this.rootTimer = this.itemTimer = null;
    for (const w of [this.rootWatcher, this.imagesWatcher]) {
      try {
        w?.close();
      } catch {
        // already closed
      }
    }
    this.rootWatcher = this.imagesWatcher = null;
    this.pendingIds.clear();
    this.pending.clear();
    this.queuedPoll = null;
  }

  /** Run a poll as soon as the current one (if any) is done. Calls made while one is queued share it. */
  poke(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.queuedPoll) return this.queuedPoll;
    const p = this.chain.then(async () => {
      this.queuedPoll = null;
      if (this.stopped) return;
      try {
        await this.pollOnce();
      } catch {
        // retry on the next poll; nobody awaits this, so it must never reject
      } finally {
        this.armPoll(); // whatever happened, keep polling
      }
    });
    this.queuedPoll = p;
    this.chain = p;
    return p;
  }

  private armPoll(): void {
    if (this.stopped) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.poke(), this.o.pollMs);
  }

  private async init(): Promise<void> {
    try {
      await this.checkRoot(true);
      await this.checkMtime(true);
      await this.checkRootFiles(true);
      await this.checkConflicts();
    } catch {
      // A baseline we couldn't take just means the first successful poll becomes the baseline.
    }
  }

  private async pollOnce(): Promise<void> {
    // Each check handles its own read errors; the try/catch is only a belt for surprises.
    for (const check of [
      () => this.checkRoot(false),
      () => this.checkMtime(false),
      () => this.checkPending(),
      () => this.checkRootFiles(false),
      () => this.checkConflicts(),
      () => this.checkWatchedDirs(),
    ]) {
      if (this.stopped) return;
      try {
        await check();
      } catch {
        // retry on the next poll
      }
    }
  }

  // ───────────────────────── fs.watch ─────────────────────────

  /** Opens the watchers that aren't running. True if `images/` got a watcher on a new folder. */
  private startWatchers(): boolean {
    if (this.stopped) return false;
    this.rootWatcher ??= this.openWatcher(
      this.root,
      'root',
      (name) => this.onRootEvent(name),
      () => (this.rootWatcher = null),
    );
    const before = this.watchedIno.images;
    this.imagesWatcher ??= this.openWatcher(
      join(this.root, 'images'),
      'images',
      (name) => this.onImagesEvent(name),
      () => (this.imagesWatcher = null),
    );
    return before !== 0 && this.watchedIno.images !== before;
  }

  /**
   * A folder that was moved away and replaced (Dropbox restoring it, a copy put back) gets no event,
   * and fs.watch keeps following the old one. Compare inodes, re-open, and have the new images/
   * listed, since whatever changed in between was never reported.
   */
  private async checkWatchedDirs(): Promise<void> {
    const dirs = { root: this.root, images: join(this.root, 'images') };
    for (const key of ['root', 'images'] as const) {
      const w = key === 'root' ? this.rootWatcher : this.imagesWatcher;
      if (!w) continue;
      const ino = await stat(dirs[key]).then(
        (st) => st.ino,
        () => 0,
      );
      if (ino === this.watchedIno[key]) continue;
      try {
        w.close();
      } catch {
        // already closed
      }
      if (key === 'root') this.rootWatcher = null;
      else this.imagesWatcher = null;
    }
    if (this.startWatchers()) this.emit(() => this.events.items({ ids: [], listDir: true }));
  }

  private openWatcher(
    dir: string,
    key: 'root' | 'images',
    onName: (name: string | null) => void,
    onDead: () => void,
  ): FSWatcher | null {
    try {
      const w = watch(dir, (_event, filename) => {
        if (!this.stopped) onName(filename == null ? null : String(filename));
      });
      try {
        this.watchedIno[key] = statSync(dir).ino;
      } catch {
        // gone again already: the next poll sees a different inode and retries
      }
      w.on('error', () => {
        try {
          w.close();
        } catch {
          // ignore
        }
        onDead();
      });
      return w;
    } catch {
      return null; // missing folder or out of inotify watches: the poll still covers the root files
    }
  }

  private onRootEvent(name: string | null): void {
    // Only the files we care about; Eagle's temp files (~$...tmp) and `images` itself are noise.
    if (
      name !== null &&
      name !== 'metadata.json' &&
      name !== 'mtime.json' &&
      !(name in ROOT_FILES) &&
      !isConflictedCopy(name)
    )
      return;
    if (this.rootTimer) return; // already scheduled
    this.rootTimer = setTimeout(() => {
      this.rootTimer = null;
      void this.poke();
    }, this.o.rootDebounceMs);
  }

  private onImagesEvent(name: string | null): void {
    if (name === null) this.pendingListDir = true;
    else {
      const id = itemIdFromName(name);
      if (!id) return;
      this.pendingIds.add(id);
    }
    const now = Date.now();
    if (!this.pendingSince) this.pendingSince = now;
    if (this.itemTimer) clearTimeout(this.itemTimer);
    const wait = Math.max(
      0,
      Math.min(this.o.itemDebounceMs, this.pendingSince + this.o.itemMaxWaitMs - now),
    );
    this.itemTimer = setTimeout(() => this.flushItems(), wait);
  }

  private flushItems(): void {
    this.itemTimer = null;
    const ids = [...this.pendingIds];
    const listDir = this.pendingListDir || ids.length > 0;
    this.pendingIds = new Set();
    this.pendingListDir = false;
    this.pendingSince = 0;
    if (this.stopped || !listDir) return;
    // Checked now, not when the event fired: the adapter records a write after it lands, and our
    // own folder shows up in fs events a moment before that.
    const { ids: selfIds } = this.selfWrites();
    const external = ids.filter((id) => !selfIds.has(id));
    if (external.length === 0 && ids.length > 0) return; // every folder was ours
    // On the poll chain, so it never overlaps a poll. A folder that shows up before its
    // metadata.json is watched until the file arrives.
    const run = this.chain.then(() =>
      this.reportItems(
        external.map((id) => [id, null]),
        true,
      ),
    );
    this.chain = run.catch(() => {});
  }

  // ───────────────────────── ids whose file hasn't arrived yet ─────────────────────────

  /** metadata.json's stat signature, and its lastModified if it parses (null otherwise). */
  private async probeItem(id: string): Promise<{ sig: string; lastModified: number | null }> {
    const path = join(this.root, 'images', `${id}.info`, 'metadata.json');
    let sig: string;
    try {
      sig = statSig(await stat(path));
    } catch {
      return { sig: 'missing', lastModified: null };
    }
    try {
      const v: unknown = JSON.parse(await readFile(path, 'utf8'));
      return { sig, lastModified: isPlainObject(v) ? (num(v.lastModified) ?? 0) : null };
    } catch {
      return { sig, lastModified: null }; // half-written or zero-filled
    }
  }

  private static arrived(p: { lastModified: number | null }, want: number | null): boolean {
    return p.lastModified !== null && (want === null || p.lastModified >= want);
  }

  /**
   * Report ids to the service, first noting which files aren't what the report promised yet.
   * Looking BEFORE reporting matters: a file that changes after this look has a new signature,
   * so the next poll reports it again whatever order the index read it in.
   */
  private async reportItems(entries: [string, number | null][], listDir: boolean): Promise<void> {
    if (this.stopped) return;
    const until = Date.now() + this.o.recheckMs;
    for (let i = 0; i < entries.length; i += 32) {
      const part = entries.slice(i, i + 32);
      const probes = await Promise.all(part.map(([id]) => this.probeItem(id)));
      part.forEach(([id, want], j) => {
        if (Session.arrived(probes[j], want)) this.pending.delete(id);
        else if (this.pending.size < MAX_PENDING || this.pending.has(id))
          this.pending.set(id, { want, sig: probes[j].sig, until });
      });
    }
    this.emit(() => this.events.items({ ids: entries.map(([id]) => id), listDir }));
  }

  /** Every poll: a watched id whose file changed and now is what we were promised is reported again. */
  private async checkPending(): Promise<void> {
    if (this.pending.size === 0) return;
    const now = Date.now();
    const arrived: string[] = [];
    const list = [...this.pending];
    for (let i = 0; i < list.length; i += 32) {
      const part = list.slice(i, i + 32);
      await Promise.all(
        part.map(async ([id, p]) => {
          const probe = await this.probeItem(id);
          if (probe.sig === p.sig) {
            if (now > p.until) this.pending.delete(id); // gave up: the index's next sync looks again
            return;
          }
          if (Session.arrived(probe, p.want)) {
            this.pending.delete(id);
            arrived.push(id);
          } else p.sig = probe.sig; // another in-between copy: keep waiting
        }),
      );
    }
    if (arrived.length) this.emit(() => this.events.items({ ids: arrived, listDir: false }));
  }

  // ───────────────────────── root metadata.json ─────────────────────────

  private async checkRoot(baseline: boolean): Promise<void> {
    const path = join(this.root, 'metadata.json');
    let sig: string;
    try {
      const st = await stat(path);
      sig = `${st.size}:${st.mtimeMs}`;
    } catch {
      return;
    }
    if (sig === this.rootSig) return;
    let mod: number | null;
    try {
      const v: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!isPlainObject(v)) return;
      mod = num(Number(v.modificationTime));
    } catch {
      return; // half-written or zero-filled: still syncing. Keep the old signature so we retry.
    }
    this.rootSig = sig;
    if (mod === null) return;
    const prev = this.rootMod;
    if (prev !== null && mod <= prev) return; // Eagle ignores an older or equal root too
    this.rootMod = mod;
    if (baseline) return;
    if (this.isSelfPath('metadata.json', mod)) return;
    this.emit(() => this.events.root());
  }

  // ───────────────────────── mtime.json ─────────────────────────

  private async checkMtime(baseline: boolean): Promise<void> {
    const path = join(this.root, 'mtime.json');
    let sig: string;
    let fileTime: number;
    try {
      const st = await stat(path);
      if (st.size === 0) return; // Eagle ignores a size-0 mtime.json as well
      sig = `${st.size}:${st.mtimeMs}`;
      fileTime = st.mtimeMs;
    } catch {
      return;
    }
    if (sig === this.mtimeSig) return;
    let cur: Record<string, unknown>;
    let text: string;
    try {
      text = await readFile(path, 'utf8');
      const v: unknown = JSON.parse(text);
      if (!isPlainObject(v)) return;
      cur = v;
    } catch {
      return;
    }
    this.mtimeSig = sig;
    const prev = this.prevMtime;
    const prevText = this.prevMtimeText;
    this.prevMtime = cur;
    this.prevMtimeText = text;

    if (baseline || prev === null) {
      for (const [id, v] of Object.entries(cur)) {
        const n = id === 'all' ? null : num(v);
        if (n !== null) this.known.set(id, n);
      }
      return;
    }

    const { ids: selfIds, paths } = this.selfWrites();
    const changed: string[] = [];
    let lowered = 0; // we only ever raise: a value going down is someone else's rewrite
    let selfCount = 0;
    let othersRaised = 0;
    let newestRaised: number | null = null; // the newest save stamp in it (see `at` below)
    let allBoogie = true; // every value someone else raised is a Boogie's (eagle/stamp.ts)
    const previous: Record<string, number | null> = {}; // raised by someone else: the value before
    const arrived = Date.now();
    for (const [id, v] of Object.entries(cur)) {
      const n = id === 'all' ? null : num(v);
      if (n === null) continue;
      const seen = this.known.get(id);
      if (seen === n) continue; // Eagle re-adding an entry we already knew about
      this.known.set(id, n);
      if (seen !== undefined && n < seen) {
        lowered++;
        changed.push(id); // its file may be a save behind ours (see the top of the file)
        continue;
      }
      // Ours only if we wrote this value: the adapter remembers the values it wrote. (Comparing our
      // write time with the value can't tell: the value is the writer's clock, and a partner's save
      // made just before ours can arrive just after it.) Adapters without that: our write time.
      const ours = this.lib.raisedValue ? this.raisedValue(id) : selfIds.get(id);
      if (ours !== undefined && ours >= n) selfCount++;
      else {
        changed.push(id);
        othersRaised++;
        previous[id] = seen ?? null;
        newestRaised = Math.max(newestRaised ?? n, n);
        if (!isBoogieWrite(n, arrived)) allBoogie = false;
      }
    }
    const removed: string[] = [];
    let dropped = 0; // we never remove entries either
    for (const id of Object.keys(prev)) {
      if (id === 'all' || id in cur) continue;
      dropped++;
      if (selfIds.has(id)) selfCount++;
      else removed.push(id);
    }

    // `all` is the number of item folders. When it moves, Eagle itself re-lists images/.
    const a = num(prev.all);
    const b = num(cur.all);
    const allChanged = a !== null && b !== null && a !== b;
    const listDir = allChanged && (changed.length > 0 || removed.length > 0 || selfCount === 0);
    // Not our write: we haven't written mtime.json lately, or the content says so. (The file's
    // time can't tell: Dropbox keeps the writer's time, so a rewrite made just before ours but
    // delivered after it looks older than ours.) Another Boogie's write raises only its own
    // (marked, backdated) values; it can still drop or lower ours when its copy of the file was
    // older, and then ours must be sent again, but it says nothing about the partner's Eagle.
    const otherBoogie = othersRaised > 0 && allBoogie;
    const foreign =
      text !== prevText &&
      (!paths.has('mtime.json') || changed.length > 0 || lowered > 0 || dropped > 0) &&
      (!otherBoogie || lowered > 0 || dropped > 0);
    if (foreign && this.events.foreignMtime) {
      let raisedByUs: string[] = [];
      try {
        raisedByUs = this.lib.recentRaises?.(RAISED_WINDOW_MS) ?? [];
      } catch {
        // an adapter bug must not stop the watcher
      }
      // When it was written, by the writer's clock: Eagle rewrites mtime.json ~3 s after a save,
      // and the value it raised is that save's own stamp, so a backlog delivered hours late reads
      // as hours old whether or not Dropbox kept the file's time. Only a rewrite that raised
      // nothing (Eagle quitting) falls back on the file time.
      const at = newestRaised ?? Math.min(Date.now(), fileTime);
      const values: Record<string, number> = {};
      for (const [id, v] of Object.entries(cur))
        if (id !== 'all' && num(v) !== null) values[id] = v as number;
      const byBoogie = otherBoogie || undefined;
      // Before the items it announces: the service judges who wrote them by what they replaced.
      this.emit(() => this.events.foreignMtime!({ at, raisedByUs, values, previous, byBoogie }));
    }
    if (changed.length > 0 || listDir)
      await this.reportItems(
        changed.map((id) => [id, num(cur[id])]),
        listDir,
      );
  }

  // ───────────────────────── tags.json, saved-filters.json ─────────────────────────

  private async checkRootFiles(baseline: boolean): Promise<void> {
    for (const name of Object.keys(ROOT_FILES) as RootFile[]) {
      let sig: string;
      let changeTime: number;
      try {
        const st = await stat(join(this.root, name));
        sig = statSig(st);
        changeTime = st.mtimeMs;
      } catch {
        sig = 'missing';
        changeTime = 0;
      }
      const before = this.rootFileSigs.get(name);
      this.rootFileSigs.set(name, sig);
      if (baseline || before === undefined || before === sig) continue;
      if (sig !== 'missing' && this.isSelfPath(name, changeTime)) continue;
      this.emit(() => this.events.rootFiles?.(ROOT_FILES[name]));
    }
  }

  // ───────────────────────── conflicted copies at the root ─────────────────────────

  private async checkConflicts(): Promise<void> {
    let list: ConflictFile[];
    try {
      list = await rootConflicts(this.root);
    } catch {
      return; // root unreadable right now (drive gone?): keep what we reported
    }
    const next = new Map<string, ConflictFile>();
    for (const f of list) next.set(f.path, this.conflicts.get(f.path) ?? f); // keep the first detectedAt
    const key = [...next.keys()].join('\n');
    this.conflicts.clear();
    for (const [p, f] of next) this.conflicts.set(p, f);
    if (key === this.conflictKey) return;
    this.conflictKey = key;
    const files = [...next.values()];
    this.emit(() => this.events.conflicts(files));
  }

  // ───────────────────────── our own writes ─────────────────────────

  /** Paths (relative, forward slashes) and per-item ids the adapter wrote in the last few seconds. */
  private selfWrites(): { paths: Map<string, number>; ids: Map<string, number> } {
    const paths = new Map<string, number>();
    const ids = new Map<string, number>();
    let raw: Map<string, number>;
    try {
      raw = this.lib.recentSelfWrites();
    } catch {
      return { paths, ids };
    }
    for (const [key, at] of raw) {
      let rel = key.replace(/\\/g, '/');
      if (rel.startsWith(this.root + '/')) rel = rel.slice(this.root.length + 1);
      rel = rel.replace(/^\.\//, '');
      paths.set(rel, Math.max(at, paths.get(rel) ?? 0));
      const m = /^images\/([^/]+)\.info(?:\/|$)/.exec(rel);
      if (m) ids.set(m[1]!, Math.max(at, ids.get(m[1]!) ?? 0));
    }
    return { paths, ids };
  }

  private raisedValue(id: string): number | undefined {
    try {
      return this.lib.raisedValue?.(id);
    } catch {
      return undefined; // an adapter bug must not stop the watcher
    }
  }

  /** Did we write `rel` at or after `changeTime`? A newer change from someone else still gets through. */
  private isSelfPath(rel: string, changeTime: number): boolean {
    const at = this.selfWrites().paths.get(rel);
    return at !== undefined && at >= changeTime;
  }

  private emit(fn: () => void): void {
    if (this.stopped) return;
    try {
      fn();
    } catch {
      // a listener's bug must not stop the watcher
    }
  }
}

export function createWatcher(opts: WatcherOptions = {}): PokeableWatcher {
  const o: Required<WatcherOptions> = {
    pollMs: opts.pollMs ?? 2000,
    itemDebounceMs: opts.itemDebounceMs ?? 1500,
    itemMaxWaitMs: opts.itemMaxWaitMs ?? 8000,
    rootDebounceMs: opts.rootDebounceMs ?? 250,
    recheckMs: opts.recheckMs ?? 120_000,
  };
  let session: Session | null = null;
  return {
    start(lib, events) {
      session?.stop();
      session = new Session(lib, events, o);
    },
    poke() {
      return session?.poke() ?? Promise.resolve();
    },
    stop() {
      session?.stop();
      session = null;
    },
  };
}
