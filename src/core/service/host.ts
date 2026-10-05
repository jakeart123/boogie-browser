// The host: owns settings, the known-library list, the open sessions, jobs, status and events.
// The window shows one library (`session`). Agents (MCP) name a library on every call and work on
// it directly: if the window isn't showing it, it is opened in the background, where its events
// never reach the window, and closed again once agents leave it alone. One library is never open
// twice (one index, one journal), so the window and agents share a session when they meet.
// The CoreApi the UI/HTTP/MCP call is built on top of this (api.ts).
import { join } from 'node:path';
import type { BoogieEventName, BoogieEvents } from '../../shared/api';
import type {
  AgentActivity,
  AppSettings,
  AppStatus,
  HistoryEntry,
  KnownLibrary,
  LibraryRef,
  LibraryState,
} from '../../shared/types';
import type { AppPaths, MediaService } from '../contracts';
import type { KnownStore } from '../libraries/known';
import type { SettingsStore } from '../libraries/settings';
import { pathExists } from '../libraries/fsutil';
import { libraryRef } from '../libraryId';
import { whyNotWritable } from '../safety/writeGuard';
import type { CoreDeps } from './deps';
import { conflictFiles, runConflictPass } from './conflicts';
import { Bus } from './events';
import { quoted } from './labels';
import { resolveItemFile } from './files';
import { isItemId } from './group';
import { JobManager } from './jobs';
import { startVerify } from './external';
import { AgentPauses } from './agents';
import { closeSession, decideReadOnly, openSession, startSession, startSync } from './session';
import { buildLibraryState } from './state';
import type { Env, Session } from './types';
import { Mutex, throttle } from './util';

const TICK_MS = 10_000;
/** A background library stays open this long after an agent's last call (agents work in bursts). */
export const AGENT_IDLE_MS = 5 * 60_000;

export class CoreService {
  readonly bus = new Bus();
  readonly jobs = new JobManager((p) => this.bus.emit('job', p));
  /** The library the window shows. */
  session: Session | null = null;
  closed = false;
  /** Libraries open only for agents, by id. */
  private readonly background = new Map<string, Session>();
  /** Agents' use of each library: calls running now, and when the last one ended. */
  private readonly agentUse = new Map<string, { holds: number; at: number }>();

  private mediaService: MediaService | null = null;
  private ports: AppStatus['ports'] = { eagleApi: null, extension: null, mcp: null, reason: null };
  private agents: AgentActivity[] = [];
  /** Agents the user paused from the status strip (the MCP waits between chunks while paused). */
  readonly agentPauses = new AgentPauses(() => this.statusThrottled());
  private lastExternal: HistoryEntry | null = null;
  private lastStatus = '';
  private ticking = false;
  private readonly timer: NodeJS.Timeout;
  /** Open / create / close run one at a time. */
  private readonly busy = new Mutex();
  private readonly statusThrottled = throttle(() => void this.emitStatus(), 250);
  private readonly env: Env;

  constructor(
    readonly paths: AppPaths,
    readonly deps: CoreDeps,
    readonly settings: SettingsStore,
    readonly known: KnownStore,
  ) {
    this.env = {
      deps,
      paths,
      jobs: this.jobs,
      settings: () => this.settings.get(),
      media: () => this.media(),
      emit: (event, payload) => this.bus.emit(event, payload),
      hasListener: (event: BoogieEventName) => this.bus.has(event),
      statusChanged: () => this.statusThrottled(),
      setLastExternal: (entry) => {
        this.lastExternal = entry;
        this.statusThrottled();
      },
      findOpen: (id) => this.sessionById(id),
    };
    // Also re-checks whether Eagle opened or closed this library (every 10 s, per the spec).
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  media(): MediaService {
    this.mediaService ??= this.deps.createMedia({ cacheDir: join(this.paths.cache, 'media') });
    return this.mediaService;
  }

  /** The open library, or a plain-English error. */
  need(): Session {
    if (!this.session || this.session.closed) throw new Error('Open a library first.');
    return this.session;
  }

  /** The open session of a library (the window's or a background one), or null. */
  sessionById(id: string): Session | null {
    const s = this.session?.ref.id === id ? this.session : this.background.get(id);
    return s && !s.closed ? s : null;
  }

  private openSessions(): Session[] {
    return [this.session, ...this.background.values()].filter(
      (s): s is Session => !!s && !s.closed,
    );
  }

  /** A session's Env: its events and status reach the window only while the window shows it. */
  private envFor(id: string): Env {
    const shown = () => this.session?.ref.id === id;
    return {
      ...this.env,
      emit: (event, payload) => {
        if (shown()) this.bus.emit(event, payload);
      },
      hasListener: (event) => shown() && this.bus.has(event),
      statusChanged: () => {
        if (shown()) this.statusThrottled();
      },
      setLastExternal: (entry) => {
        if (shown()) this.env.setLastExternal(entry);
      },
    };
  }

  on<K extends BoogieEventName>(event: K, fn: (payload: BoogieEvents[K]) => void): () => void {
    return this.bus.on(event, fn);
  }

  // ───────────────────────── libraries ─────────────────────────

  listLibraries(): Promise<KnownLibrary[]> {
    return this.known.list();
  }

  openLibrary(path: string, opts: { readOnly?: boolean } = {}): Promise<LibraryState> {
    return this.busy.run(() => this.openInternal(path, opts));
  }

  private async openInternal(path: string, opts: { readOnly?: boolean }): Promise<LibraryState> {
    const ref = libraryRef(path);
    // Look before closing the current library, so a wrong folder doesn't close what you have open.
    if (!(await pathExists(join(ref.path, 'metadata.json')))) {
      throw new Error(
        `${quoted(ref.name)} doesn't look like an Eagle library (there is no metadata.json in it).`,
      );
    }
    const old = this.session;
    // Agents have it open already: show their session, unless view-only was asked for.
    let session = this.background.get(ref.id) ?? null;
    if (session) {
      this.background.delete(ref.id);
      if (session.userReadOnly !== !!opts.readOnly) {
        await closeSession(session);
        session = null;
      }
    }
    const adopted = !!session;
    if (!session) {
      // The same library can't be open twice (one index, one journal), so it is closed first. A
      // different one is opened before the current one is closed, so if it fails (a library that
      // is still syncing, say) what you had open stays open.
      if (old && old.ref.id === ref.id) {
        this.session = null;
        await closeSession(old);
      }
      const entry = (await this.known.find(ref.path)) ?? (await this.known.add(ref.path, 'user'));
      session = await openSession(this.envFor(ref.id), ref.path, opts, {
        shared: entry.shared,
        partnerName: entry.partnerName,
      });
    }
    if (this.session && this.session !== session) {
      const previous = this.session;
      this.session = null;
      await this.retire(previous);
    }
    this.session = session;
    this.lastExternal = null;
    await this.known.touch(session.ref.path);
    if (!adopted) startSession(session);
    const state = buildLibraryState(session);
    this.bus.emit('library', state);
    this.statusThrottled();
    return state;
  }

  createLibrary(parentDir: string, name: string): Promise<LibraryState> {
    return this.busy.run(async () => {
      const clean = name.trim();
      if (!clean) throw new Error('Give the library a name.');
      if (whyNotWritable(join(parentDir, `${clean}.library`))) {
        throw new Error(
          "Boogie can't create libraries there yet. Allow that folder in Settings first.",
        );
      }
      const path = await this.deps.eagle.create(parentDir, clean);
      await this.known.add(path, 'created');
      return this.openInternal(path, {});
    });
  }

  async addLibrary(path: string): Promise<KnownLibrary> {
    const ref = libraryRef(path);
    if (!(await pathExists(join(ref.path, 'metadata.json')))) {
      throw new Error(
        `${quoted(ref.name)} doesn't look like an Eagle library (there is no metadata.json in it).`,
      );
    }
    return { ...(await this.known.add(ref.path, 'user')), exists: true };
  }

  forgetLibrary(path: string): Promise<void> {
    return this.known.forget(path);
  }

  async setLibraryOptions(
    path: string,
    opts: { partnerName?: string | null; shared?: boolean },
  ): Promise<void> {
    const entry = await this.known.setOptions(path, opts);
    const s = entry ? this.sessionById(entry.id) : null;
    if (entry && s) {
      // No longer shared: nothing waits for a partner's Eagle, and months-old bases must not be
      // used if it is shared again later (review should-fix 5).
      if (s.shared && !entry.shared) s.partner?.unshared();
      s.shared = entry.shared;
      s.partnerName = entry.partnerName;
      this.statusThrottled();
    } else if (entry && !entry.shared) {
      // Not open: the journal keeps its pending list until the next open, so clear it there.
      const journal = this.deps.createJournal({ dir: join(this.paths.data, 'journal') });
      try {
        journal.clearAllPartnerPending?.(entry.id);
      } finally {
        journal.close();
      }
    }
  }

  getLibraryState(): LibraryState | null {
    return this.session && !this.session.closed ? buildLibraryState(this.session) : null;
  }

  closeLibrary(): Promise<void> {
    return this.busy.run(async () => {
      const s = this.session;
      this.session = null;
      this.lastExternal = null;
      if (s) await this.retire(s);
      this.statusThrottled();
    });
  }

  // ───────────────────────── agents' libraries ─────────────────────────

  /**
   * For an agent call: the session of the library at `path`, opened in the background when the
   * window isn't showing it. Only libraries Boogie knows (the user adds them in the app). The
   * library stays open until `release()` and a while after (AGENT_IDLE_MS).
   */
  async useLibrary(path: string): Promise<{ session: Session; release(): void }> {
    const ref = libraryRef(path);
    let use = this.agentUse.get(ref.id);
    if (!use) this.agentUse.set(ref.id, (use = { holds: 0, at: 0 }));
    const held = use;
    held.holds++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      held.holds--;
      held.at = Date.now();
    };
    try {
      const session =
        this.sessionById(ref.id) ?? (await this.busy.run(() => this.openBackground(ref)));
      return { session, release };
    } catch (e) {
      release();
      throw e;
    }
  }

  private async openBackground(ref: LibraryRef): Promise<Session> {
    const open = this.sessionById(ref.id); // opened while this call waited its turn
    if (open) return open;
    const entry = await this.known.find(ref.path);
    if (!entry)
      throw new Error(
        `Boogie doesn't know ${quoted(ref.name)}. The user adds libraries in the app.`,
      );
    const session = await openSession(
      this.envFor(ref.id),
      ref.path,
      {},
      {
        shared: entry.shared,
        partnerName: entry.partnerName,
      },
    );
    this.background.set(ref.id, session);
    startSession(session);
    return session;
  }

  private agentBusy(id: string): boolean {
    const use = this.agentUse.get(id);
    return !!use && (use.holds > 0 || Date.now() - use.at < AGENT_IDLE_MS);
  }

  /** The window stopped showing `s`: agents still working in it keep it open in the background. */
  private async retire(s: Session): Promise<void> {
    // View-only was the window's choice; agents get the library opened normally on their next call.
    if (!s.userReadOnly && this.agentBusy(s.ref.id)) this.background.set(s.ref.id, s);
    else await closeSession(s);
  }

  /** Close background libraries agents have left alone (never while a job runs: it may need one). */
  private async closeIdle(): Promise<void> {
    if (this.jobs.list().some((j) => j.state === 'running')) return;
    for (const [id, s] of [...this.background]) {
      if (this.agentBusy(id)) continue;
      await this.busy.run(async () => {
        if (this.background.get(id) !== s || this.agentBusy(id)) return;
        this.background.delete(id);
        await closeSession(s);
      });
    }
    for (const [id, use] of this.agentUse)
      if (!this.agentBusy(id) && !use.holds) this.agentUse.delete(id);
  }

  /**
   * Both check whether Eagle opened this library here. Cheap (window focus): poke the watcher to
   * look at mtime.json now. Full (Eagle's "reload"): sync the index, then re-read every changed file.
   */
  async refresh(opts: { full?: boolean } = {}): Promise<void> {
    const s = this.need();
    await this.recheckReadOnly();
    if (s.closed) return; // the recheck reopened it (editing was allowed meanwhile)
    if (!opts.full) {
      await s.watcher.poke();
      void runConflictPass(s); // a copy that was still syncing may be ready now
      return;
    }
    await startSync(s);
    if (!s.closed) await startVerify(s, { pauseMs: 0 }); // ends with a look at the conflicted copies
  }

  // ───────────────────────── settings ─────────────────────────

  getSettings(): AppSettings {
    const s = this.settings.get();
    return { ...s, writableRoots: [...s.writableRoots] }; // a copy: callers in this process can't edit ours
  }

  async setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const guard = (s: AppSettings) => [s.allowProtectedWrites, ...s.writableRoots].join('\n');
    const before = guard(this.settings.get());
    // Edits made while writing was allowed still owe mtime.json their raises (batched ~1 s). Write
    // them before the guard may close, or the partner's Eagle never notices those edits. A failure
    // shows as the library's write problem; it mustn't stop the settings change.
    const touchesGuard = 'writableRoots' in patch || 'allowProtectedWrites' in patch;
    if (touchesGuard)
      for (const s of this.openSessions())
        if (!s.readOnly) await s.lib.flushMtime().catch(() => {});
    await this.settings.update(patch);
    // Allowing (or forbidding) writes can change what the open library may do. (The name cap is
    // handed to the adapter and importer when a library opens, so it applies from the next open.)
    if (guard(this.settings.get()) !== before) await this.recheckReadOnly();
    return this.getSettings();
  }

  /** Re-decide whether the open libraries may be edited (settings, or Eagle opened/closed here). */
  private async recheckReadOnly(): Promise<void> {
    for (const s of this.openSessions()) await this.recheckOne(s);
  }

  private async recheckOne(s: Session): Promise<void> {
    const now = await decideReadOnly(this.env, s.ref, {
      userReadOnly: s.userReadOnly,
      versionReason: s.versionReason,
    });
    if (now.reason === s.readOnlyReason) return;
    if (now.reason === null && s.adapterReadOnly) {
      // Nothing blocks it any more, but the adapter was opened read-only: open it again. A
      // background one is just closed; the next agent call opens it editable.
      await this.busy.run(async () => {
        if (s.closed) return;
        if (this.session === s) await this.openInternal(s.ref.path, { readOnly: s.userReadOnly });
        else if (this.background.get(s.ref.id) === s) {
          this.background.delete(s.ref.id);
          await closeSession(s);
        }
      });
      return;
    }
    s.readOnly = now.reason !== null;
    s.readOnlyReason = now.reason;
    s.readOnlyKind = now.kind;
    s.env.emit('library', buildLibraryState(s));
    s.env.statusChanged();
    // Editable again: re-sends to the partner's Eagle that waited go ahead, and so do conflicted copies.
    if (!s.readOnly) {
      s.partner?.resume();
      void runConflictPass(s);
    }
    // Eagle opened it here (or writing was switched off): running imports stop between files.
    if (s.readOnly) await this.jobs.cancelScope(s.ref.id, ['import', 'thumbnails']);
  }

  // ───────────────────────── status ─────────────────────────

  async getStatus(): Promise<AppStatus> {
    const s = this.session && !this.session.closed ? this.session : null;
    // Dropbox only matters for a library shared through it; anything else says so plainly.
    const notShared = { state: 'idle' as const, detail: s ? 'Not in Dropbox' : 'No library open' };
    const [dropbox, eagle] = await Promise.all([
      s?.shared
        ? this.deps.dropbox
            .check()
            .catch(() => ({ state: 'unknown' as const, detail: 'Dropbox status unavailable' }))
        : notShared,
      this.deps.eagleMonitor.check().catch(() => ({ running: false, openLibraryPath: null })),
    ]);
    const partner = s?.partner?.status();
    // Anything that keeps the partner's Eagle from seeing edits: mtime.json writes failing, their
    // clock far behind ours, or changes their Eagle keeps not picking up.
    const writeProblem = s?.lib.writeProblem?.() ?? s?.partner?.problem() ?? null;
    return {
      sync: {
        state: dropbox.state,
        detail: dropbox.detail,
        conflicts: s ? conflictFiles(s) : [],
      },
      eagle: { running: eagle.running, openLibraryPath: eagle.openLibraryPath },
      ports: { ...this.ports },
      agents: this.agents.map((a) => ({ ...a, paused: this.agentPauses.isPaused(a.name) })),
      lastExternal: this.lastExternal,
      unreadableItems: s?.index.unreadableIds?.().length ?? 0,
      ...(partner ? { partner } : {}),
      ...(writeProblem ? { writeProblem } : {}),
    };
  }

  private async emitStatus(): Promise<void> {
    if (this.closed) return;
    const status = await this.getStatus();
    const text = JSON.stringify(status);
    if (text === this.lastStatus) return;
    this.lastStatus = text;
    this.bus.emit('status', status);
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      await this.recheckReadOnly();
      await this.closeIdle();
      await this.emitStatus();
    } catch (e) {
      console.error('[boogie] status check failed', e);
    } finally {
      this.ticking = false;
    }
  }

  setPorts(ports: Partial<AppStatus['ports']>): void {
    this.ports = { ...this.ports, ...ports };
    this.statusThrottled();
  }

  /** The port our own Eagle-compatible server answers on, so the Eagle monitor never mistakes it for Eagle. */
  eagleApiPort(): number | null {
    return this.ports.eagleApi;
  }

  setAgentActivity(list: AgentActivity[]): void {
    this.agents = list;
    this.statusThrottled();
  }

  // ───────────────────────── files ─────────────────────────

  async resolveFile(
    kind: 'thumb' | 'file' | 'preview',
    libraryId: string,
    itemId: string,
  ): Promise<{ path: string; mime: string } | null> {
    const s = this.session && !this.session.closed ? this.session : null;
    const source =
      this.sessionById(libraryId) ?? s?.dupeSources.find((d) => d.ref.id === libraryId);
    return source ? resolveItemFile(source, this.media(), kind, itemId) : null;
  }

  async originalPath(itemId: string): Promise<string | null> {
    const s = this.session;
    if (!s || s.closed || !isItemId(itemId)) return null;
    const rec = s.index.getRecord(itemId) ?? (await s.lib.readItem(itemId))?.value ?? null;
    return rec ? s.lib.locateOriginal(itemId, rec) : null;
  }

  // ───────────────────────── close ─────────────────────────

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.statusThrottled.cancel();
    try {
      await this.busy.run(async () => {
        const all = this.openSessions();
        this.session = null;
        this.background.clear();
        for (const s of all) await closeSession(s);
      });
    } finally {
      // Whatever happened above, quitting still stops jobs and the media workers.
      this.jobs.abortAll();
      await this.jobs.whenIdle();
      await this.mediaService?.close().catch(() => undefined);
      this.bus.clear();
    }
  }
}
