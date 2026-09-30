// Test-only: read-only stand-ins for EagleLibrary (the real adapter is built by another agent).
// DiskLibrary reads a real .library folder; MemoryLibrary is a synthetic one for big-library timings.
import { cpSync, constants, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { EagleItemRecord, EagleRootRecord, LibraryRef } from '../../shared/types';
import type { ChangeContext, Doc, EagleLibrary, NewItemInit } from '../contracts';
import type { IndexFs } from './load';

export const PROJECT = resolve(import.meta.dirname, '../../..');
export const TEMPLATES = join(PROJECT, 'research/sandbox/templates');
export const SCRATCH = join(PROJECT, '.tmp/index');

const unsupported = (): never => {
  throw new Error('not available in the test library');
};

abstract class ReadOnlyLibrary implements EagleLibrary {
  abstract readonly root: string;
  readonly readOnly = true;
  /** Every id passed to readItem, in order: the "how much did sync read" spy. */
  readIds: string[] = [];

  abstract readRoot(): Promise<Doc<EagleRootRecord>>;
  abstract listItemIds(): Promise<string[]>;
  abstract readItem(id: string): Promise<Doc<EagleItemRecord> | null>;
  abstract readMtimeIndex(): Promise<Record<string, number>>;
  abstract itemDir(id: string): string;

  locateOriginal = unsupported as EagleLibrary['locateOriginal'];
  locateThumbnail = unsupported as EagleLibrary['locateThumbnail'];
  updateItem = unsupported as EagleLibrary['updateItem'];
  updateItems = unsupported as EagleLibrary['updateItems'];
  renameItem = unsupported as EagleLibrary['renameItem'];
  createItem(_init: NewItemInit, _ctx: ChangeContext): never {
    return unsupported();
  }
  writeThumbnail = unsupported as EagleLibrary['writeThumbnail'];
  moveItemOut = unsupported as EagleLibrary['moveItemOut'];
  moveItemIn = unsupported as EagleLibrary['moveItemIn'];
  updateRoot = unsupported as EagleLibrary['updateRoot'];
  async flushMtime(): Promise<void> {}
  recentSelfWrites(): Map<string, number> {
    return new Map();
  }
  async close(): Promise<void> {}
}

export class DiskLibrary extends ReadOnlyLibrary {
  constructor(readonly root: string) {
    super();
  }
  async readRoot(): Promise<Doc<EagleRootRecord>> {
    const text = readFileSync(join(this.root, 'metadata.json'), 'utf8');
    return { value: JSON.parse(text), text };
  }
  async listItemIds(): Promise<string[]> {
    return readdirSync(join(this.root, 'images'))
      .filter((n) => n.endsWith('.info'))
      .map((n) => n.slice(0, -5))
      .filter((id) => id.length === 13 || id.length === 36);
  }
  async readItem(id: string): Promise<Doc<EagleItemRecord> | null> {
    this.readIds.push(id);
    try {
      const text = readFileSync(join(this.itemDir(id), 'metadata.json'), 'utf8');
      return { value: JSON.parse(text), text };
    } catch {
      return null; // missing, or zero-filled: the adapter's tolerant read does the same
    }
  }
  async readMtimeIndex(): Promise<Record<string, number>> {
    try {
      return JSON.parse(readFileSync(join(this.root, 'mtime.json'), 'utf8'));
    } catch {
      return {};
    }
  }
  itemDir(id: string): string {
    return join(this.root, 'images', `${id}.info`);
  }
}

export class MemoryLibrary extends ReadOnlyLibrary {
  readonly root = '/memory/test.library';
  rootRecord: EagleRootRecord;
  records = new Map<string, EagleItemRecord>();
  mtimeIndex: Record<string, number> = {};
  constructor(rootRecord?: Partial<EagleRootRecord>) {
    super();
    this.rootRecord = {
      folders: [],
      smartFolders: [],
      quickAccess: [],
      tagsGroups: [],
      modificationTime: 1,
      applicationVersion: '4.0.0',
      ...rootRecord,
    };
  }
  async readRoot(): Promise<Doc<EagleRootRecord>> {
    const text = JSON.stringify(this.rootRecord);
    return { value: JSON.parse(text), text };
  }
  async listItemIds(): Promise<string[]> {
    return [...this.records.keys()];
  }
  /** Let each read go through the event loop, like a real file read (timing tests). */
  yieldOnRead = false;
  async readItem(id: string): Promise<Doc<EagleItemRecord> | null> {
    this.readIds.push(id);
    if (this.yieldOnRead) await new Promise((r) => setImmediate(r));
    const value = this.records.get(id);
    return value ? { value, text: JSON.stringify(value) } : null;
  }
  async readMtimeIndex(): Promise<Record<string, number>> {
    return this.mtimeIndex;
  }
  itemDir(id: string): string {
    return `${this.root}/images/${id}.info`;
  }
  /** Fake metadata.json mtimes (0 when unset), for the index's file-system questions. */
  mtimes = new Map<string, number>();
  fs(): IndexFs {
    const idOf = (dir: string) => basename(dir).slice(0, -'.info'.length);
    return {
      metaMtime: async (dir) => this.mtimes.get(idOf(dir)) ?? 0,
      dirExists: async (dir) => this.records.has(idOf(dir)),
      dirStamp: async () => null, // no folder to stamp: every sync lists
    };
  }
}

/** Fresh scratch folder under .tmp/index (removed first, so reruns start clean). */
export function scratchDir(name: string): string {
  const dir = join(SCRATCH, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Reflink copy of a template library into scratch, so a test may edit it. */
export function copyLibrary(template: string, dest: string): string {
  cpSync(join(TEMPLATES, template), dest, { recursive: true, mode: constants.COPYFILE_FICLONE });
  return dest;
}

export function testRef(id = 'testlib', path = '/memory/test.library'): LibraryRef {
  return { id, path, name: 'test' };
}

export function makeItem(id: string, over: Partial<EagleItemRecord> = {}): EagleItemRecord {
  return {
    id,
    name: `Item ${id}`,
    size: 1000,
    btime: 1700000000000,
    mtime: 1700000000000,
    ext: 'jpg',
    tags: [],
    folders: [],
    isDeleted: false,
    url: '',
    annotation: '',
    modificationTime: 1700000000000,
    height: 100,
    width: 100,
    lastModified: 1700000000001,
    ...over,
  };
}

/** Independent brute-force version of counts(), written the plain way over parsed records. */
export function bruteCounts(records: EagleItemRecord[], root: EagleRootRecord) {
  const parent = new Map<string, string | null>();
  const walk = (nodes: { id: string; children?: unknown[] }[], p: string | null) => {
    for (const n of nodes) {
      parent.set(n.id, p);
      walk((n.children ?? []) as { id: string; children?: unknown[] }[], n.id);
    }
  };
  walk(root.folders as { id: string; children?: unknown[] }[], null);
  const withAncestors = (id: string): string[] => {
    const out: string[] = [];
    for (let cur: string | null | undefined = id; cur; cur = parent.get(cur)) out.push(cur);
    return out;
  };

  const live = records.filter((r) => !r.isDeleted);
  const own: Record<string, Set<string>> = {};
  const deep: Record<string, Set<string>> = {};
  for (const id of parent.keys()) ((own[id] = new Set()), (deep[id] = new Set()));
  for (const r of live) {
    for (const f of r.folders ?? []) {
      if (!parent.has(f)) continue;
      own[f].add(r.id);
      for (const a of withAncestors(f)) deep[a].add(r.id);
    }
  }
  return {
    all: live.length,
    uncategorized: live.filter((r) => !(r.folders ?? []).some((f) => parent.has(f))).length,
    untagged: live.filter((r) => !(r.tags ?? []).length).length,
    trash: records.length - live.length,
    folders: Object.fromEntries(
      [...parent.keys()].map((id) => [id, { own: own[id].size, deep: deep[id].size }]),
    ),
  };
}
