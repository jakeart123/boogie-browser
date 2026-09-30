// Test helpers for the Eagle adapter. Only used by *.test.ts in this folder.
import { constants, existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ChangeContext, JournalGroup, JournalSink } from '../contracts';
import { setWritableRoots } from '../safety/writeGuard';
import { openLibrary, type EagleAdapter } from './library';

export const TMP = resolve('.tmp/eagle');
/** The real library copies when they are here, else the generated ones committed with the tests. */
export const USING_FIXTURES =
  !!process.env.BOOGIE_TEST_FIXTURES ||
  !existsSync(resolve('research/sandbox/templates/sample.library'));
export const TEMPLATES = !USING_FIXTURES
  ? resolve('research/sandbox/templates')
  : resolve('test/fixtures/libraries');

export interface FileChange {
  relPath: string;
  before: string | null;
  after: string | null;
  itemId: string | null;
}

export class FakeJournal implements JournalSink {
  files: FileChange[] = [];
  moves: { itemId: string; storedAt: string }[] = [];
  failNextRecordFile = false;
  recordFile(_group: JournalGroup, change: FileChange): void {
    if (this.failNextRecordFile) {
      this.failNextRecordFile = false;
      throw new Error('journal is down');
    }
    this.files.push(change);
  }
  recordMoveOut(_group: JournalGroup, change: { itemId: string; storedAt: string }): void {
    this.moves.push(change);
  }
  storeDirFor(libraryId: string): string {
    return join(TMP, 'store', libraryId);
  }
}

export const group: JournalGroup = {
  id: 'g1',
  libraryId: 'lib',
  actor: { kind: 'user', name: 'You' },
  label: 'test',
  kind: 'items',
};
export const ctx: ChangeContext = { actor: group.actor, group };

/** Make the write guard allow `.tmp/eagle` only. Call in beforeAll. */
export function allowTmp(): void {
  setWritableRoots([TMP]);
}

const made: string[] = [];

/** A private scratch folder under .tmp/eagle. */
export async function scratch(): Promise<string> {
  await mkdir(TMP, { recursive: true });
  const dir = await mkdtemp(join(TMP, 't-'));
  made.push(dir);
  return dir;
}

/** Copy a template library (reflinked, so cheap) into a fresh scratch folder and return its path. */
export async function copyTemplate(
  name: 'sample' | 'art-archive' = 'sample',
): Promise<string> {
  const dir = await scratch();
  const dest = join(dir, 'lib.library');
  await cp(join(TEMPLATES, `${name}.library`), dest, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
  });
  return dest;
}

export async function cleanup(): Promise<void> {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true });
}

export async function openLib(
  path: string,
  opts: { readOnly?: boolean; journal?: FakeJournal; retryDelayMs?: number } = {},
): Promise<{ lib: EagleAdapter; journal: FakeJournal }> {
  const journal = opts.journal ?? new FakeJournal();
  const lib = await openLibrary(path, {
    readOnly: opts.readOnly ?? false,
    journal,
    nameMaxChars: 120,
    retryDelayMs: opts.retryDelayMs ?? 10,
    mtimeDelayMs: 20,
  });
  return { lib, journal };
}

export const readText = (p: string) => readFile(p, 'utf8');
export const readJson = async <T = any>(p: string): Promise<T> =>
  JSON.parse(await readFile(p, 'utf8')) as T;
export const writeText = (p: string, s: string) => writeFile(p, s);
