// "Export to computer": copy originals out of the library into a normal folder. Never moves
// anything, never overwrites, and never writes into a library. Plain Node (no electron import).
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import type { CoreHost } from '../core/contracts';
import { capUtf8, sanitizeFolderName, sanitizeItemName } from '../core/eagle';
import type { FolderNode, JobProgress } from '../shared/types';

export interface ExportResult {
  /** The folder to show when it is done (a folder export's own folder inside the one picked). */
  dir: string;
  copied: number;
  skipped: { id: string; reason: string }[];
}

type ExportHost = Pick<CoreHost, 'originalPath'> & {
  api: Pick<CoreHost['api'], 'getItems' | 'getLibraryState'>;
};

const MAX_NAME_BYTES = 240; // filesystems allow 255 bytes; leave room for "-01" and the extension

// Every file and folder name below comes from library records, which the partner's Eagle (or any library
// you open) controls. Eagle's own Windows-safe name rules make each one a single, harmless path
// segment: no slashes, no "..", no trailing dots.

/** A folder name as one safe path segment. */
export function safeSegment(name: string): string {
  return sanitizeFolderName(name, { maxBytes: MAX_NAME_BYTES });
}

/** An extension as one plain word. A dot left after cleaning means it was never an extension. */
function safeExt(ext: string): string {
  const e = ext ? sanitizeItemName(ext, 16) : '';
  return e !== '_' && !e.includes('.') ? e : '';
}

function nameWith(base: string, n: number, ext: string): string {
  const suffix = n === 0 ? '' : `-${String(n).padStart(2, '0')}`;
  const dot = ext ? `.${ext}` : '';
  const room = MAX_NAME_BYTES - Buffer.byteLength(suffix + dot);
  return `${capUtf8(base, Infinity, room)}${suffix}${dot}`;
}

/**
 * Copies `src` into `dir` as `<base>.<ext>` (both cleaned; a bad extension falls back to the
 * source file's own). When that name is taken it becomes `<base>-01.<ext>`, then `-02`, and so on
 * (Eagle's rule). COPYFILE_EXCL makes "taken" atomic, so nothing is ever overwritten even if two
 * exports run at once. Returns the final file name.
 */
export async function copyUnique(
  src: string,
  dir: string,
  base: string,
  ext: string,
): Promise<string> {
  const safeBase = sanitizeItemName(base, 1024);
  const safeExtension = ext ? safeExt(ext) || safeExt(extname(src).slice(1)) : '';
  for (let n = 0; n < 10_000; n++) {
    const name = nameWith(safeBase, n, safeExtension);
    const target = resolve(dir, name);
    if (dirname(target) !== resolve(dir)) throw new Error('bad file name');
    try {
      await copyFile(src, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      return name;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  throw new Error('Too many files with the same name in the export folder.');
}

/** Folder id -> ["Parent", "Child"] using safe segment names. */
export function folderPaths(folders: FolderNode[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (nodes: FolderNode[], parents: string[]) => {
    for (const f of nodes) {
      const path = [...parents, safeSegment(f.name)];
      out.set(f.id, path);
      walk(f.children ?? [], path);
    }
  };
  walk(folders, []);
  return out;
}

/** Refuse to export into (or under) a `.library` folder: that would put foreign files in a library. */
function isInsideLibrary(dir: string): boolean {
  return resolve(dir)
    .split(sep)
    .some((seg) => seg.toLowerCase().endsWith('.library'));
}

interface Running {
  job: JobProgress;
  abort: AbortController;
}

export interface ExportOptions {
  keepFolders?: boolean;
  /** Folder export: a folder named after this folder is made in `dir`, with its subfolders below. */
  baseFolderId?: string;
}

/**
 * Where each item goes, as folder names below the export folder ([] = the export folder itself).
 * - no keepFolders: everything flat.
 * - keepFolders: the item's first folder, as its full path from the top of the tree.
 * - keepFolders + baseFolderId (Eagle's "Export folder"): a folder named after the base, and a copy
 *   in EVERY folder of that subtree the item is in, as Eagle does. Items outside it go in the top.
 */
function exportTargets(
  folders: FolderNode[],
  opts: ExportOptions,
): (itemFolders: string[]) => string[][] {
  if (!opts.keepFolders) return () => [[]];
  const paths = folderPaths(folders);
  const base = opts.baseFolderId;
  if (!base) {
    return (itemFolders) => {
      const first = itemFolders.find((f) => paths.has(f));
      return [first ? paths.get(first)! : []];
    };
  }
  const basePath = paths.get(base);
  if (!basePath) throw new Error('That folder is no longer in the library.');
  const top = basePath.length - 1; // keep the base's own name, drop its parents
  const inside = new Set<string>();
  const walk = (nodes: FolderNode[], within: boolean) => {
    for (const f of nodes) {
      const now = within || f.id === base;
      if (now) inside.add(f.id);
      walk(f.children ?? [], now);
    }
  };
  walk(folders, false);
  return (itemFolders) => {
    const out = new Map<string, string[]>();
    for (const f of itemFolders) {
      if (!inside.has(f)) continue;
      const rel = paths.get(f)!.slice(top);
      out.set(rel.join('/'), rel);
    }
    return out.size ? [...out.values()] : [basePath.slice(top)];
  };
}

export class ExportJobs {
  private jobs = new Map<string, Running>();

  constructor(
    private host: ExportHost,
    private emit: (job: JobProgress) => void,
  ) {}

  /** Checks the folder, then runs the export in the background. Returns the job id at once. */
  async start(ids: string[], dir: string, opts: ExportOptions = {}): Promise<{ jobId: string }> {
    if (!isAbsolute(dir)) throw new Error('Pick a folder to export into.');
    if (isInsideLibrary(dir)) throw new Error('Pick a folder outside any Eagle library.');
    let isDir = false;
    try {
      isDir = (await stat(dir)).isDirectory();
    } catch {
      /* falls through to the error below */
    }
    if (!isDir) throw new Error('That export folder does not exist.');
    const folders = (await this.host.api.getLibraryState())?.folders ?? [];
    const targets = exportTargets(folders, opts); // throws for a folder that is gone
    // A folder export lands in its own folder; "Show folder" should open that one.
    const top = opts.keepFolders && opts.baseFolderId ? targets([])[0] : [];

    const jobId = randomUUID();
    const job: JobProgress = {
      jobId,
      kind: 'export',
      label: `Exporting ${ids.length} ${ids.length === 1 ? 'item' : 'items'}`,
      done: 0,
      total: ids.length,
      state: 'running',
      error: null,
    };
    const running: Running = { job, abort: new AbortController() };
    this.jobs.set(jobId, running);
    this.emit({ ...job });
    void this.run(running, ids, dir, join(dir, ...top), targets);
    return { jobId };
  }

  cancel(jobId: string): boolean {
    const r = this.jobs.get(jobId);
    if (!r || r.job.state !== 'running') return false;
    r.abort.abort();
    return true;
  }

  list(): JobProgress[] {
    return [...this.jobs.values()].map((r) => ({ ...r.job }));
  }

  private async run(
    r: Running,
    ids: string[],
    dir: string,
    shown: string,
    targets: (itemFolders: string[]) => string[][],
  ): Promise<void> {
    const { job, abort } = r;
    const result: ExportResult = { dir: shown, copied: 0, skipped: [] };
    let lastEmit = 0;
    const progress = (force: boolean) => {
      const now = Date.now();
      if (!force && now - lastEmit < 250) return;
      lastEmit = now;
      this.emit({ ...job });
    };
    try {
      for (let i = 0; i < ids.length && !abort.signal.aborted; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const items = new Map((await this.host.api.getItems(chunk)).map((it) => [it.id, it]));
        for (const id of chunk) {
          if (abort.signal.aborted) break;
          try {
            const item = items.get(id);
            const src = await this.host.originalPath(id);
            if (!item || !src) throw new Error('the file is missing');
            for (const segments of targets(item.folders)) {
              const target = join(dir, ...segments);
              const rel = relative(dir, target);
              if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('bad folder name');
              await mkdir(target, { recursive: true });
              await copyUnique(src, target, item.name, item.ext);
              result.copied++;
            }
          } catch (e) {
            result.skipped.push({ id, reason: e instanceof Error ? e.message : String(e) });
          }
          job.done++;
          progress(false);
        }
      }
      if (abort.signal.aborted) job.state = 'cancelled';
      else if (result.copied === 0 && ids.length > 0) {
        job.state = 'failed';
        job.error = `Could not export any of the ${ids.length} items.`;
      } else job.state = 'done';
    } catch (e) {
      job.state = 'failed';
      job.error = e instanceof Error ? e.message : String(e);
    }
    job.result = result;
    progress(true);
    this.prune();
  }

  /** Keep the last few finished jobs so listJobs() can show them, but not forever. */
  private prune(): void {
    const finished = [...this.jobs.values()].filter((r) => r.job.state !== 'running');
    for (const r of finished.slice(0, Math.max(0, finished.length - 10)))
      this.jobs.delete(r.job.jobId);
  }
}
