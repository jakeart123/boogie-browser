// Tests only: the REAL core host (adapter, index, query, journal, importer, watcher) on a copy of a
// sandbox library under .tmp/<area>/. Used by the service, http and mcp tests, so they test what
// actually runs instead of a fake that can drift from it. Never touches your Eagle or Dropbox.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { BoogieEventName } from '../../shared/api';
import type { EagleItemRecord, JobProgress } from '../../shared/types';
import type { CoreHost, EagleMonitor } from '../contracts';
import { isBoogieStamp } from '../eagle';
import { setWritableRoots } from '../safety/writeGuard';
import type { CoreDeps } from './deps';
import { createCoreHost } from './index';

/**
 * Copies of real libraries (local research data, gitignored) when they are here; otherwise the
 * small generated ones committed in test/fixtures/libraries (test/fixtures/build.test.ts), so these
 * tests run on any clone. BOOGIE_TEST_FIXTURES=1 uses the generated ones anyway.
 */
const REAL = resolve('research/sandbox/templates');
const TEMPLATES =
  !process.env.BOOGIE_TEST_FIXTURES && existsSync(join(REAL, 'art-archive.library', 'images'))
    ? REAL
    : resolve('test/fixtures/libraries');
const SAMPLE = join(TEMPLATES, 'sample.library');
const ARCHIVE = join(TEMPLATES, 'art-archive.library');

/** Kept for the test files that check it: true unless even the committed fixtures are gone. */
export const sandboxAvailable = existsSync(SAMPLE) && existsSync(join(ARCHIVE, 'images'));

const EVENTS: BoogieEventName[] = [
  'library',
  'itemsChanged',
  'itemsAdded',
  'itemsRemoved',
  'counts',
  'job',
  'history',
  'status',
];

export interface Sandbox {
  dir: string;
  libPath: string;
  host: CoreHost;
  events: { name: BoogieEventName; payload: unknown }[];
  /** Every item id at open, in the All view's order. */
  itemIds: string[];
  /** The item's metadata.json as it is on disk now. */
  read(id: string): EagleItemRecord;
  /**
   * Write an item the way the partner's Eagle would: its whole record from memory (`from`,
   * default the file on disk) with `edit` applied, lastModified = now, then mtime.json raised
   * (unless `raise: false`, when its mtime.json update was skipped, eagle-proof FINDINGS 3).
   */
  writeAsEagle(
    id: string,
    edit: (rec: EagleItemRecord) => void,
    opts?: { from?: EagleItemRecord; raise?: boolean },
  ): EagleItemRecord;
  /** Eagle's rewrite of mtime.json from memory: set these entries (null drops one). */
  rewriteMtimeAsEagle(values: Record<string, number | null>): void;
  /** Wait for a job to finish and return it. */
  job(jobId: string, ms?: number): Promise<JobProgress>;
  waitFor(cond: () => boolean, ms?: number): Promise<void>;
  close(): Promise<void>;
}

const cp = (from: string, to: string) => execFileSync('cp', ['-r', '--reflink=auto', from, to]);

/**
 * An Eagle timestamp for tests: never one that ends in Boogie's mark (eagle/stamp.ts). A real
 * Eagle hits it one save in a thousand (then that save looks like another Boogie's); a test
 * must not fail at random for it.
 */
export const eagleNow = (t = Date.now()) => (isBoogieStamp(t) ? t + 1 : t);

/** Total bytes of an item folder's files (item folders are flat). */
const folderBytes = (p: string) =>
  readdirSync(p).reduce((n, f) => n + statSync(join(p, f)).size, 0);

let smallest: string[] | null = null;
/** The smallest of the first 40 Art Archive items (cheap to copy, real Eagle data). */
function smallArchiveItems(n: number): string[] {
  smallest ??= readdirSync(join(ARCHIVE, 'images'))
    .slice(0, 40)
    .map((name) => ({ name, bytes: folderBytes(join(ARCHIVE, 'images', name)) }))
    .sort((a, b) => a.bytes - b.bytes)
    .map((x) => x.name);
  return smallest.slice(0, n);
}

export async function openSandbox(
  opts: {
    /** Scratch folder name under .tmp (the calling module's own). */
    area?: string;
    /** Extra Art Archive items copied in (sample has 3). Default 8. */
    extraItems?: number;
    writable?: boolean;
    open?: boolean;
    readOnly?: boolean;
    shared?: boolean;
    partner?: string | null;
    eagleMonitor?: EagleMonitor;
    deps?: Partial<CoreDeps>;
    /** List every item in mtime.json, as Eagle's own mtime.json does (the copied-in extra items
     *  aren't there otherwise). */
    completeMtime?: boolean;
  } = {},
): Promise<Sandbox> {
  const base = resolve('.tmp', opts.area ?? 'service');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'sb-'));
  const libPath = join(dir, 'Test.library');
  cp(SAMPLE, libPath);
  for (const name of smallArchiveItems(opts.extraItems ?? 8))
    cp(join(ARCHIVE, 'images', name), join(libPath, 'images', name));
  if (opts.completeMtime) {
    const mtimePath = join(libPath, 'mtime.json');
    const { all: _all, ...entries } = JSON.parse(readFileSync(mtimePath, 'utf8')) as Record<
      string,
      number
    >;
    const names = readdirSync(join(libPath, 'images')).filter((n) => n.endsWith('.info'));
    for (const n of names) {
      const rec = JSON.parse(readFileSync(join(libPath, 'images', n, 'metadata.json'), 'utf8'));
      entries[n.slice(0, -5)] ??= rec.lastModified;
    }
    writeFileSync(mtimePath, JSON.stringify({ ...entries, all: names.length }));
  }
  const config = join(dir, 'home/config');
  mkdirSync(config, { recursive: true });
  // Writing is allowed the way the app allows it: settings.json (loading it arms the write guard).
  if (opts.writable !== false)
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ writableRoots: [dir] }));

  const host = await createCoreHost({
    paths: {
      config,
      cache: join(dir, 'home/cache'),
      data: join(dir, 'home/data'),
      tmp: join(dir, 'home/cache/tmp'),
    },
    deps: {
      eagleMonitor: opts.eagleMonitor ?? {
        check: async () => ({ running: false, openLibraryPath: null }),
      },
      dropbox: { check: async () => ({ state: 'idle', detail: 'Up to date' }) },
      ...opts.deps,
    },
    discovery: { home: dir, settingsFiles: [], dropboxDir: join(dir, 'no-dropbox') },
  });
  const events: Sandbox['events'] = [];
  for (const name of EVENTS) host.on(name, (payload) => events.push({ name, payload }));

  const metaPath = (id: string) => join(libPath, 'images', `${id}.info`, 'metadata.json');
  const waitFor = async (cond: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const sb: Sandbox = {
    dir,
    libPath,
    host,
    events,
    itemIds: [],
    read: (id) => JSON.parse(readFileSync(metaPath(id), 'utf8')) as EagleItemRecord,
    writeAsEagle(id, edit, opts = {}) {
      const rec = structuredClone(opts.from ?? sb.read(id));
      edit(rec);
      rec.lastModified = eagleNow(Math.max(Date.now(), (sb.read(id).lastModified ?? 0) + 1));
      writeFileSync(metaPath(id), JSON.stringify(rec));
      if (opts.raise !== false) sb.rewriteMtimeAsEagle({ [id]: rec.lastModified });
      return rec;
    },
    rewriteMtimeAsEagle(values) {
      const mtimePath = join(libPath, 'mtime.json');
      const mtime = JSON.parse(readFileSync(mtimePath, 'utf8')) as Record<string, number>;
      for (const [id, v] of Object.entries(values))
        if (v === null) delete mtime[id];
        else mtime[id] = v;
      writeFileSync(mtimePath, JSON.stringify(mtime));
    },
    async job(jobId, ms = 15_000) {
      const end = Date.now() + ms;
      for (;;) {
        const found = (await host.api.listJobs()).find((j) => j.jobId === jobId);
        if (found && found.state !== 'running') return found;
        if (Date.now() > end) throw new Error(`job ${jobId} did not finish`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    waitFor,
    async close() {
      await host.close();
      setWritableRoots([]);
      rmSync(dir, { recursive: true, force: true });
    },
  };

  if (opts.partner !== undefined || opts.shared !== undefined) {
    await host.api.addLibrary(libPath);
    await host.api.setLibraryOptions(libPath, {
      partnerName: opts.partner ?? null,
      shared: opts.shared ?? false,
    });
  }
  if (opts.open !== false) {
    await host.api.openLibrary(libPath, { readOnly: opts.readOnly });
    await host.api.refresh({ full: true }); // join the first index sync
    sb.itemIds = (await host.api.query({ scope: { kind: 'all' }, filter: {}, sort: null })).ids;
  }
  return sb;
}
