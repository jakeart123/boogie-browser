// The partner's Eagle (on another computer), as far as the shared files let us see it.
//
// Two Eagle bugs mean a change of ours can reach their library and still not reach their screen
// (test/eagle-proof FINDINGS 1 and 2): a cached start keeps showing its old copy of an item even
// though mtime.json says it changed, and a running Eagle rewrites mtime.json from memory ~3 s
// after its own saves, which can undo our raise. Either way their next save of that item writes the
// old copy back over ours. The cure for both is to re-send the item while their Eagle is running.
// So (the decisions themselves are pure functions in judge.ts):
//
// - PENDING. In a shared library every existing item Boogie changes is pending (journal), with the
//   copy their Eagle most likely holds (the base). An outside write of a pending item is judged
//   against that base. Pending ends when their Eagle saves the item (it holds some version then),
//   or the library stops being shared.
// - SEEN. A pending item becomes "seen" when their Eagle most likely re-read our version: their
//   rewrite of mtime.json from memory holds exactly the value we last wrote, sent while their Eagle
//   ran and kept running, and not so fresh that they could have skipped it (seenByRewrite). It is
//   no proof: it only stops re-sends and the "waiting" count. An outside write that puts back a
//   pending change, seen or not, is logged as "may have written an old copy" for the user to decide
//   (outside.ts). The journal drops seen rows a day later.
// - ACTIVE. Their Eagle counts as running for 10 minutes after it last wrote something, timed by
//   their own stamps put on our clock (clock.ts), so a backlog delivered hours late doesn't count.
// - RE-SENDS. While they are active, pending items that weren't sent while they were running get
//   touched (rewritten with a higher lastModified), at most TOUCH_PER_MIN a minute. After a rewrite
//   of theirs from memory, our raises it put back or dropped are raised again first (just
//   mtime.json: their memory holds an older value, so that is enough); ones it kept are left alone
//   (FINDINGS-2 R2-5). One item is re-sent at most 3 times in 10 minutes: an Eagle that keeps
//   putting it back isn't re-reading it, so it gets a warning instead of a write per save of
//   theirs. A re-send first reads the batch again and logs anything that changed (never re-send an
//   outside write as ours), and skips an item whose mtime.json already announces a newer version
//   that hasn't arrived.
// - RE-CHECKS. Items we wrote are read again a few seconds later and after a minute, so a save of
//   theirs that raced ours without raising mtime.json is seen (FINDINGS 3).
import type { AppStatus, EagleItemRecord } from '../../../shared/types';
import { ItemNotFoundError, isSkippableItemError } from '../../eagle';
import { pathExists } from '../../libraries/fsutil';
import type { Session } from '../types';
import { mapLimit } from '../util';
import { PartnerClock } from './clock';
import {
  JUDGE_RULES,
  isBoogieValue,
  raiseFate,
  seenByRewrite,
  touchChoice,
  type Sent,
} from './judge';

/** Timings and caps. A plain object so a test can shorten them. */
export const PARTNER_TIMING = {
  /** The partner's Eagle counts as running this long after it last wrote something. */
  activeMs: 10 * 60_000,
  touchBatch: 500,
  touchPerMin: 1000,
  /** At most this many re-sends of one item per touchWindowMs. */
  maxTouches: 3,
  touchWindowMs: 10 * 60_000,
  /** A pending item sent while they were running is sent again after this long without a sign. */
  resendAfterMs: 10 * 60_000,
  /** When our own item writes are read again (a racing save of theirs). */
  recheckAfterMs: [6_000, 60_000],
  maxRecheck: 5000,
  /** The status notice counts unresolved old-copy entries this far back. */
  noticeMs: 7 * 24 * 60 * 60_000,
};

const MAX_SIGNALS = 200;
/** Values another Boogie may build on (root times, mtime.json entries a rewrite replaced). */
const MAX_ROOTS = 32;
const MAX_ENTRIES = 20_000;

/**
 * What the partner needs from the rest of the service, handed in by session.ts (so this module
 * doesn't import external.ts, which imports this one).
 */
export interface PartnerIO {
  /** Read these items from disk now and log whatever changed outside, before a re-send (lock held). */
  refreshAndLog(ids: string[]): Promise<void>;
  /** Read these items again later (takes the lock itself). */
  readAgain(ids: string[]): Promise<void>;
}

interface Recheck {
  after: number;
  due: Map<string, number>; // id -> when to look
  timer: NodeJS.Timeout | null;
}

type Urgent = 'reraise' | 'bump';

export class Partner {
  /** When the partner's Eagle last wrote something (our clock), if ever this session. */
  lastSeen: number | null = null;
  /** Pending items their Eagle hasn't been seen to pick up. */
  pending = 0;
  readonly clock = new PartnerClock();
  /** When their writes happened (our clock), oldest first. */
  private readonly signals: number[] = [];
  /** When their Eagle started running after a quiet spell (a cached start shows old copies). */
  private runningSince: number | null = null;
  /** Raises of ours a rewrite of theirs put back or dropped (reraise), or maybe adopted unread (bump). */
  private readonly urgent = new Map<string, Urgent>();
  private readonly queue = new Set<string>(); // pending items to re-send
  /** Pending id -> what we last wrote for it and when (an edit or a re-send), until it is seen. */
  private readonly sent = new Map<string, Sent>();
  private readonly touches = new Map<string, number[]>();
  /** Items that hit the re-send cap: their Eagle isn't picking them up. */
  private readonly stuck = new Set<string>();
  /** Root modificationTimes this library has had lately (ours and outside ones). */
  private readonly roots: number[] = [];
  /** id -> the mtime.json value an outside rewrite replaced, the "entry" another Boogie saw. */
  private readonly priorEntries = new Map<string, number>();
  private lastSweep = 0;
  private nextSlot = 0;
  private draining = false;
  private wait: { timer: NodeJS.Timeout; wake: () => void } | null = null;
  private readonly rechecks: Recheck[];
  private stopped = false;

  constructor(
    private readonly s: Session,
    private readonly io: PartnerIO,
  ) {
    this.rechecks = PARTNER_TIMING.recheckAfterMs.map((after) => ({
      after,
      due: new Map(),
      timer: null,
    }));
    this.noteRoot(s.root.modificationTime);
    this.countPending();
  }

  /** The root's modificationTime is `t` now (a write of ours, or one that arrived). */
  noteRoot(t: unknown): void {
    if (typeof t !== 'number' || this.roots.includes(t)) return;
    this.roots.push(t);
    if (this.roots.length > MAX_ROOTS) this.roots.shift();
  }

  /**
   * Did another Boogie (the user's other computer) write `stamp`? Marked and backdated, or exactly
   * one more than a value it knew: the item's previous lastModified or mtime.json value (`prev`),
   * the mtime.json entry a rewrite of someone's replaced, or a recent root time (judge.ts
   * isBoogieValue, review6 must-fix 2).
   */
  byOtherBoogie(stamp: unknown, id: string | null, ...prev: unknown[]): boolean {
    const known: number[] = [...this.roots];
    for (const p of prev) if (typeof p === 'number') known.push(p);
    const entry = id ? this.priorEntries.get(id) : undefined;
    if (entry !== undefined) known.push(entry);
    return isBoogieValue(stamp, Date.now(), known, this.clock.offset());
  }

  status(): AppStatus['partner'] {
    if (!this.s.shared) return undefined;
    const oldCopies =
      this.s.journal.countStale?.(this.s.ref.id, Date.now() - PARTNER_TIMING.noticeMs) ?? 0;
    return {
      active: this.isActive(),
      lastSeen: this.lastSeen,
      pending: this.pending,
      ...(oldCopies ? { oldCopies } : {}),
    };
  }

  isActive(now = Date.now()): boolean {
    return this.lastSeen !== null && now - this.lastSeen < PARTNER_TIMING.activeMs;
  }

  /** Plain English when something keeps their Eagle from seeing our edits, else null. */
  problem(): string | null {
    if (!this.s.shared) return null;
    const clock = this.clock.problem(this.s.partnerName);
    if (clock) return clock;
    if (!this.stuck.size) return null;
    const who = this.s.partnerName ?? 'your partner';
    const n = this.stuck.size;
    return `${this.s.partnerName ? `${this.s.partnerName}'s` : "Your partner's"} Eagle isn't picking up ${n === 1 ? '1 of your changes' : `${n} of your changes`}. Ask ${who} to restart Eagle.`;
  }

  /** A quiet spell this long breaks "their Eagle ran all along" (never longer than "active"). */
  private gap(): number {
    return Math.min(JUDGE_RULES.runningGapMs, PARTNER_TIMING.activeMs);
  }

  /** Their time `at` on our clock, never in our future. */
  private ours(at: number, now = Date.now()): number {
    return Math.trunc(Math.min(now, this.clock.toOurs(at, now)));
  }

  /**
   * The partner's Eagle wrote something stamped `at` (their clock). `sample`: `at` is an Eagle
   * Date.now() we can learn their clock from (an item or root save, not a file time).
   */
  noteWrite(at: number, opts: { sample?: boolean } = {}): void {
    if (!this.s.shared || this.stopped || !Number.isFinite(at)) return;
    const now = Date.now();
    if (opts.sample) this.clock.add(at, now);
    const when = this.ours(at, now);
    if (now - when >= PARTNER_TIMING.activeMs) return; // old news: that Eagle may be closed by now
    const before = this.lastSeen;
    if (before === null || when > before) {
      this.lastSeen = when;
      this.s.env.statusChanged();
    }
    if (before === null || when - before >= PARTNER_TIMING.activeMs) this.runningSince = when;
    this.signals.push(when);
    this.signals.sort((a, b) => a - b);
    if (this.signals.length > MAX_SIGNALS) this.signals.shift();
    this.sweep(now);
    this.drain();
  }

  /**
   * Someone else rewrote mtime.json: a partner's Eagle ~3 s after one of its saves (from its
   * memory), or another Boogie (`byBoogie`, or every value it raised is a Boogie's), which may
   * still have dropped a raise of ours but says nothing about their Eagle.
   * Two sources on purpose: whether a raise of ours still needs sending depends on the file as it
   * is NOW (a flush of ours since may already have put it back); whether their Eagle re-read an
   * item depends on what THEIR MEMORY held, the rewrite as the watcher read it (`values`).
   */
  async onForeignMtime(info: {
    at: number;
    raisedByUs: string[];
    values?: Record<string, number>;
    previous?: Record<string, number | null>;
    byBoogie?: boolean;
  }): Promise<void> {
    if (this.stopped || !this.s.shared) return;
    // Before anything else (the item writes this announces are judged against it): which of the
    // raised values are another Boogie's, and what they replaced.
    const raised = Object.entries(info.previous ?? {});
    const byBoogie =
      info.byBoogie ||
      (raised.length > 0 &&
        raised.every(([id, before]) =>
          this.byOtherBoogie(
            info.values?.[id],
            id,
            before,
            this.s.index.getRecord(id)?.lastModified,
          ),
        ));
    for (const [id, before] of raised) if (before !== null) this.priorEntries.set(id, before);
    if (this.priorEntries.size > MAX_ENTRIES) this.priorEntries.clear();

    const file = await this.s.lib.readMtimeIndex().catch(() => ({}) as Record<string, number>);
    for (const id of info.raisedByUs) {
      const ours = this.s.lib.raiseInfo?.(id);
      const fate = ours ? raiseFate(ours, file[id]) : 'kept';
      if (fate === 'reraise' || fate === 'bump') this.urgent.set(id, fate);
    }
    if (byBoogie) return this.drain(); // says nothing about their Eagle: no "seen", no activity
    const memory = info.values ?? {};
    const rewriteAt = this.ours(info.at);
    const offset = this.clock.offset();
    const seen = [...this.sent]
      .filter(
        ([id, sent]) =>
          !this.urgent.has(id) &&
          seenByRewrite(sent, memory[id], rewriteAt, this.signals, offset, this.gap()),
      )
      .map(([id]) => id);
    this.markSeen(seen);
    this.noteWrite(info.at);
    this.drain();
  }

  /** One of our actions committed as `groupId`, writing `changed` (existing items). */
  afterGroup(groupId: string, changed: Iterable<string>): void {
    if (!this.s.shared || this.stopped) return;
    this.s.journal.markPartnerPending?.(groupId);
    const now = Date.now();
    const ids = [...changed];
    for (const id of ids) {
      const value = this.s.index.getRecord(id)?.lastModified;
      if (typeof value === 'number') this.sent.set(id, { at: now, value });
      this.stuck.delete(id);
    }
    this.countPending();
    this.recheck(ids);
  }

  /** The partner's Eagle saved these items, so it holds some version of them now. */
  clearPending(ids: string[]): void {
    if (!ids.length || !this.s.shared) return;
    this.s.journal.clearPartnerPending?.(this.s.ref.id, ids);
    this.forget(ids);
    this.countPending();
  }

  /** Their running Eagle most likely re-read our version of these (see the top of the file). */
  markSeen(ids: string[]): void {
    if (!ids.length || !this.s.shared) return;
    this.s.journal.markPartnerSeen?.(this.s.ref.id, ids);
    this.forget(ids);
    this.countPending();
  }

  /** The library stopped being shared: nothing is pending, nothing is re-sent. */
  unshared(): void {
    this.s.journal.clearAllPartnerPending?.(this.s.ref.id);
    this.forget([...this.queue, ...this.urgent.keys(), ...this.stuck, ...this.sent.keys()]);
    this.countPending();
  }

  stop(): void {
    this.stopped = true;
    for (const r of this.rechecks) if (r.timer) clearTimeout(r.timer);
    if (this.wait) {
      clearTimeout(this.wait.timer);
      this.wait.wake();
    }
  }

  /** Re-send whatever is waiting (the library became editable again, say). */
  resume(): void {
    this.drain();
  }

  // ───────────────────────── internals ─────────────────────────

  private forget(ids: string[]): void {
    for (const id of ids) {
      this.queue.delete(id);
      this.urgent.delete(id);
      this.stuck.delete(id);
      this.sent.delete(id);
    }
  }

  private countPending(): void {
    const before = this.pending;
    this.pending = this.s.shared ? (this.s.journal.partnerPendingCount?.(this.s.ref.id) ?? 0) : 0;
    if (this.pending !== before) this.s.env.statusChanged();
  }

  /**
   * While they are active: queue the pending items their running Eagle hasn't had a fresh raise of
   * (never sent this session, sent before it started running, or sent long ago with no sign).
   */
  private sweep(now: number): void {
    if (!this.isActive(now) || this.stopped) return;
    const started = this.runningSince ?? now;
    if (now - this.lastSweep < 30_000 && this.lastSweep >= started) return;
    this.lastSweep = now;
    for (const id of this.s.journal.partnerPendingIds?.(this.s.ref.id, { unseenOnly: true }) ??
      []) {
      const sent = this.sent.get(id)?.at;
      if (sent === undefined || sent < started || now - sent >= PARTNER_TIMING.resendAfterMs)
        this.queue.add(id);
    }
  }

  private drain(): void {
    if (this.draining || this.stopped) return;
    if (!this.urgent.size && !this.queue.size) return;
    this.draining = true;
    void this.drainLoop()
      .catch((e: unknown) => {
        if (!this.s.closed)
          console.error("[boogie] re-sending changes to the partner's Eagle failed", e);
        return false;
      })
      .then((finished) => {
        this.draining = false;
        // Ids queued while the loop was on its way out.
        if (finished && (this.urgent.size || this.queue.size)) this.drain();
      });
  }

  /** False when it had to stop with work left (closed, or read-only for now). */
  private async drainLoop(): Promise<boolean> {
    while (!this.stopped && (this.urgent.size || this.queue.size)) {
      const wait = this.nextSlot - Date.now();
      if (wait > 0) await this.sleep(wait);
      // Read-only now (Eagle opened it here, say): the ids stay pending for the next time.
      if (this.stopped || this.s.closed || this.s.readOnly) return false;
      const batch = this.take(PARTNER_TIMING.touchBatch);
      await this.s.lock.run(() => this.sendAll(batch));
      this.nextSlot = Date.now() + (batch.length * 60_000) / PARTNER_TIMING.touchPerMin;
    }
    return !this.stopped;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wait = null;
        resolve();
      }, ms);
      timer.unref?.();
      this.wait = { timer, wake: resolve };
    });
  }

  private take(n: number): { id: string; urgent: Urgent | null }[] {
    const out = new Map<string, Urgent | null>();
    for (const [id, why] of this.urgent) {
      if (out.size >= n) break;
      this.urgent.delete(id);
      out.set(id, why);
    }
    for (const id of this.queue) {
      if (out.size >= n) break;
      this.queue.delete(id);
      if (!out.has(id)) out.set(id, null);
    }
    return [...out].map(([id, urgent]) => ({ id, urgent }));
  }

  /** Runs in the session lock, like any write. */
  private async sendAll(batch: { id: string; urgent: Urgent | null }[]): Promise<void> {
    const s = this.s;
    if (s.closed || s.readOnly || !batch.length) return;
    // Read them again first, so an outside write waiting there is logged and judged, never
    // re-sent as ours (review4 must-fix 2). A running index sync re-reads them afterwards anyway.
    if (!s.syncPromise) await this.io.refreshAndLog(batch.map((b) => b.id));
    const file = await s.lib.readMtimeIndex().catch(() => ({}) as Record<string, number>);
    const now = Date.now();
    const done: string[] = [];
    const gone: string[] = [];
    const records: EagleItemRecord[] = [];
    try {
      await mapLimit(batch, 8, async ({ id, urgent }) => {
        // Still waiting? An outside save just read (above) may have settled it.
        const pending = s.journal.partnerPendingState?.(s.ref.id, id);
        if (!urgent && (!pending || pending.seen)) return;
        const doc = await s.lib.readItem(id);
        if (!doc) {
          if (!(await pathExists(s.lib.itemDir(id)))) gone.push(id);
          return;
        }
        const indexed = s.index.getRecord(id);
        const recent = (this.touches.get(id) ?? []).filter(
          (t) => now - t < PARTNER_TIMING.touchWindowMs,
        );
        const lm = typeof doc.value.lastModified === 'number' ? doc.value.lastModified : 0;
        const ourRaise = s.lib.raisedValue?.(id);
        const choice = touchChoice({
          urgent: !!urgent,
          pending,
          indexMatchesFile: !!indexed && JSON.stringify(indexed) === JSON.stringify(doc.value),
          fileLastModified: lm,
          announced: file[id],
          ourRaise,
          recentTouches: recent.length,
          maxTouches: PARTNER_TIMING.maxTouches,
        });
        if (choice === 'capped' && !this.stuck.has(id)) {
          this.stuck.add(id);
          s.env.statusChanged();
        }
        if (choice !== 'touch') return; // changedSince / newerAnnounced: the watcher brings it
        try {
          // Their memory holds an older value (or none) and the file is still what we raised:
          // writing that value to mtime.json again is enough. Otherwise a real touch.
          if (urgent === 'reraise' && lm === ourRaise) {
            if ((await s.lib.reannounce?.(id)) == null) return;
            this.sent.set(id, { at: Date.now(), value: lm });
          } else {
            const w = await s.lib.touchItem?.(id, { ifText: doc.text });
            if (!w?.after) return;
            records.push(JSON.parse(w.after) as EagleItemRecord);
            this.sent.set(id, { at: Date.now(), value: w.lastModified });
            done.push(id);
          }
          this.touches.set(id, [...recent, Date.now()]);
        } catch (e) {
          if (e instanceof ItemNotFoundError) gone.push(id);
          else if (!isSkippableItemError(e)) throw e; // unreadable ones wait for the next time
        }
      });
    } finally {
      // Our own touch must never look like an outside change to the index.
      if (records.length) s.index.upsertRecords(records);
      if (s.syncPromise) for (const id of done) s.dirtyDuringSync.add(id);
      this.clearPending(gone);
      this.recheck(done);
      for (const [id, list] of this.touches)
        if (!list.some((t) => Date.now() - t < PARTNER_TIMING.touchWindowMs)) {
          this.touches.delete(id);
          if (this.stuck.delete(id)) s.env.statusChanged();
        }
    }
  }

  /** Read these items again later: a save of theirs that raced our write shows up as an outside change. */
  private recheck(ids: Iterable<string>): void {
    if (!this.s.shared || this.stopped) return;
    const now = Date.now();
    const list = [...ids];
    for (const r of this.rechecks) {
      for (const id of list)
        if (r.due.size < PARTNER_TIMING.maxRecheck || r.due.has(id)) r.due.set(id, now + r.after);
      this.arm(r);
    }
  }

  private arm(r: Recheck): void {
    if (r.timer || !r.due.size || this.stopped) return;
    const first = Math.min(...r.due.values());
    r.timer = setTimeout(
      () => {
        r.timer = null;
        const now = Date.now();
        const ids = [...r.due].filter(([, at]) => at <= now).map(([id]) => id);
        for (const id of ids) r.due.delete(id);
        this.arm(r);
        if (ids.length && !this.s.closed)
          void this.io.readAgain(ids).catch((e: unknown) => {
            if (!this.s.closed) console.error('[boogie] reading items again failed', e);
          });
      },
      Math.max(0, first - Date.now()),
    );
    r.timer.unref?.();
  }
}
