import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSandbox, sandboxAvailable } from '../core/service/testSandbox';
import type { FolderNode, Item, JobProgress } from '../shared/types';
import { copyUnique, ExportJobs, folderPaths, safeSegment } from './exporter';

let dir: string; // scratch for this file
const folder = (id: string, name: string, children: FolderNode[] = []) =>
  ({ id, name, children }) as unknown as FolderNode;

beforeAll(async () => {
  const scratch = resolve(import.meta.dirname, '../../.tmp/app');
  await mkdir(scratch, { recursive: true });
  dir = await mkdtemp(join(scratch, 'export-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('copyUnique', () => {
  it('numbers clashes -01, -02 and never overwrites', async () => {
    const src = join(dir, 'src.txt');
    await writeFile(src, 'data');
    const out = join(dir, 'out1');
    await mkdir(out);
    await writeFile(join(out, 'cat.jpg'), 'someone elses file');
    expect(await copyUnique(src, out, 'cat', 'jpg')).toBe('cat-01.jpg');
    expect(await copyUnique(src, out, 'cat', 'jpg')).toBe('cat-02.jpg');
    expect(await readFile(join(out, 'cat.jpg'), 'utf8')).toBe('someone elses file');
    expect(await copyUnique(src, out, 'no extension', '')).toBe('no extension');
  });

  it('keeps very long names under the filesystem limit', async () => {
    const src = join(dir, 'src.txt');
    const out = join(dir, 'out2');
    await mkdir(out);
    const name = await copyUnique(src, out, 'あ'.repeat(200), 'jpg');
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
    expect(name.endsWith('.jpg')).toBe(true);
  });
});

describe('safeSegment / folderPaths', () => {
  it('cannot climb out of the export folder', () => {
    expect(safeSegment('..')).toBe('_');
    expect(safeSegment(' .. ')).toBe('_');
    expect(safeSegment('a/b\\c')).toBe('abc');
    expect(safeSegment('  ')).toBe('_');
    expect(folderPaths([folder('A', 'Art', [folder('B', 'Anatomy/Hands')])]).get('B')).toEqual([
      'Art',
      'AnatomyHands',
    ]);
  });
});

describe('ExportJobs', () => {
  function setup(items: Partial<Item>[], files: Record<string, string | null>) {
    const events: JobProgress[] = [];
    const jobs = new ExportJobs(
      {
        originalPath: async (id: string) => files[id] ?? null,
        api: {
          getItems: async (ids: string[]) => items.filter((i) => ids.includes(i.id!)) as Item[],
          getLibraryState: async () =>
            ({ folders: [folder('F1', 'Studies', [folder('F2', 'Hands')])] }) as never,
        },
      },
      (j) => events.push(j),
    );
    const finished = async () => {
      for (let i = 0; i < 200; i++) {
        const last = events.at(-1);
        if (last && last.state !== 'running') return last;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('export never finished');
    };
    return { jobs, events, finished };
  }

  it('copies with clash suffixes, recreates folders, and skips missing files', async () => {
    const a = join(dir, 'a.bin');
    const b = join(dir, 'b.bin');
    await writeFile(a, 'AAA');
    await writeFile(b, 'BBB');
    const { jobs, finished } = setup(
      [
        { id: '1', name: 'sketch', ext: 'png', folders: ['F2'] },
        { id: '2', name: 'sketch', ext: 'png', folders: ['F2'] },
        { id: '3', name: 'loose', ext: 'jpg', folders: [] },
        { id: '4', name: 'gone', ext: 'jpg', folders: [] },
      ],
      { '1': a, '2': b, '3': a, '4': join(dir, 'does-not-exist') },
    );
    // 4 has a path that the host returns but that is missing: copyFile fails, item is skipped
    const out = join(dir, 'export-a');
    await mkdir(out);
    await jobs.start(['1', '2', '3', '4', '5'], out, { keepFolders: true });
    const last = await finished();
    expect(last.state).toBe('done');
    expect(last.done).toBe(5);
    const result = last.result as { copied: number; skipped: { id: string }[] };
    expect(result.copied).toBe(3);
    expect(result.skipped.map((s) => s.id).sort()).toEqual(['4', '5']);
    expect(readdirSync(join(out, 'Studies', 'Hands')).sort()).toEqual([
      'sketch-01.png',
      'sketch.png',
    ]);
    expect(readdirSync(out)).toContain('loose.jpg');
    expect(existsSync(a) && existsSync(b)).toBe(true); // originals untouched
  });

  it('keeps crafted names, extensions and folder names from a library inside the export folder', async () => {
    const src = join(dir, 'real.jpg');
    await writeFile(src, 'JPG');
    const out = join(dir, 'export-b', 'inner');
    await mkdir(out, { recursive: true });
    const { jobs, finished } = setup(
      [
        { id: '1', name: 'cat', ext: 'jpg/../../../escaped', folders: [] },
        { id: '2', name: '../../escaped2', ext: 'png', folders: ['F2'] },
      ],
      { '1': src, '2': src },
    );
    await jobs.start(['1', '2'], out, { keepFolders: true });
    expect((await finished()).state).toBe('done');
    expect(readdirSync(join(dir, 'export-b'))).toEqual(['inner']);
    expect(readdirSync(out).sort()).toEqual(['Studies', 'cat.jpg']); // the file's own extension
    expect(readdirSync(join(out, 'Studies', 'Hands'))).toEqual(['....escaped2.png']); // one segment
  });

  it('refuses to export into a library or a missing folder', async () => {
    const { jobs } = setup([], {});
    await expect(jobs.start(['1'], join(dir, 'Art.library'))).rejects.toThrow(
      /outside any Eagle library/,
    );
    await expect(jobs.start(['1'], join(dir, 'Art.library', 'images'))).rejects.toThrow(
      /outside any Eagle library/,
    );
    await expect(jobs.start(['1'], join(dir, 'nope'))).rejects.toThrow(/does not exist/);
    await expect(jobs.start(['1'], 'relative/dir')).rejects.toThrow(/Pick a folder/);
  });
});

describe.skipIf(!sandboxAvailable)('ExportJobs on the real core', () => {
  it('exports a folder like Eagle: its own folder, subfolders below, a copy in each folder an item is in', async () => {
    const sb = await openSandbox({ area: 'surfaces' });
    try {
      const { api } = sb.host;
      const [a, b, c, d] = sb.itemIds;
      const art = (await api.createFolder('Art', null)).id;
      const hands = (await api.createFolder('Hands', art)).id;
      const faces = (await api.createFolder('Faces', hands)).id;
      const other = (await api.createFolder('Elsewhere', null)).id;
      await api.updateItems([a], { addFolders: [hands] });
      await api.updateItems([b], { addFolders: [faces, hands] }); // in two folders of the subtree
      await api.updateItems([c], { addFolders: [faces, other] }); // the other folder is outside
      const events: JobProgress[] = [];
      const jobs = new ExportJobs(sb.host, (j) => events.push(j));
      const out = join(sb.dir, 'export');
      await mkdir(out);
      // What the UI sends for "Export folder…" on Hands: everything in it and below it.
      const ids = (
        await api.query({
          scope: { kind: 'folder', id: hands, includeSubfolders: true },
          filter: {},
          sort: null,
        })
      ).ids;
      expect(ids.sort()).toEqual([a, b, c].sort());
      await jobs.start([...ids, d], out, { keepFolders: true, baseFolderId: hands });
      await sb.waitFor(() => events.at(-1)?.state === 'done');
      const result = events.at(-1)!.result as { dir: string; copied: number };
      expect(result.dir).toBe(join(out, 'Hands')); // what "Show folder" opens
      expect(result.copied).toBe(5); // a, b twice, c, d
      const names = async (id: string) => {
        const it = (await api.getItem(id))!;
        return `${it.name}.${it.ext}`;
      };
      expect(readdirSync(out)).toEqual(['Hands']); // the parent "Art" is not recreated
      expect(readdirSync(join(out, 'Hands')).sort()).toEqual(
        ['Faces', await names(a), await names(b), await names(d)].sort(),
      );
      expect(readdirSync(join(out, 'Hands', 'Faces')).sort()).toEqual(
        [await names(b), await names(c)].sort(),
      );
      await expect(
        jobs.start([a], out, { keepFolders: true, baseFolderId: 'GONE' }),
      ).rejects.toThrow(/no longer in the library/);
    } finally {
      await sb.close();
    }
  });
});
