import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EagleFolderRecord } from '../../shared/types';
import type { ImportDeps } from '../contracts';
import { downloadUrl, isLocalUrl, isPrivateAddress } from './download';
import { importers } from './importer';
import { ctx, makeEnv, makeImage, type Env } from './testkit';

let env: Env;
beforeEach(async () => {
  env = await makeEnv('import');
});
afterEach(async () => env.cleanup());

const file = (name: string) => join(env.src, name);
/** A distinct small JPEG per name, so files don't count as duplicates of each other. */
const jpg = (name: string, w = 100, colors = 'red-blue') => {
  makeImage(file(name), `-size ${w}x80 gradient:${colors}`);
  return file(name);
};
const png = (name: string, w = 200, colors = 'green-yellow') => {
  makeImage(file(name), `-size ${w}x150 gradient:${colors}`, 'png');
  return file(name);
};
const tmpLeftovers = () => (existsSync(env.tmpDir) ? readdirSync(env.tmpDir) : []);
const itemFile = (id: string, name: string) => join(env.lib.itemDir(id), name);

describe('importing files', () => {
  it('imports a small jpg, a big png and a mislabeled png with auto-tags', async () => {
    const small = jpg('small.jpg');
    makeImage(file('big.png'), '-size 1400x1000 gradient:red-blue -depth 8');
    const fake = png('fake.jpg'); // PNG bytes named .jpg
    const progress: number[] = [];

    const res = await env.importer.importPaths(
      [small, file('big.png'), fake],
      {
        folderId: env.folders.sub,
        tags: ['mine'],
        star: 3,
        annotation: 'a note',
        url: 'https://example.com/page',
      },
      ctx,
      (p) => progress.push(p.done),
    );

    expect(res.failed).toEqual([]);
    expect(res.added).toHaveLength(3);
    expect(progress.at(-1)).toBe(3);
    const [a, b, c] = res.added.map((id) => env.recordOf(id));

    // Small jpg: Eagle shows the original, so no thumbnail file, and the palette comes from the source.
    expect(a).toMatchObject({
      name: 'small',
      ext: 'jpg',
      width: 100,
      height: 80,
      noThumbnail: true,
      star: 3,
      annotation: 'a note',
      url: 'https://example.com/page',
    });
    expect(readdirSync(env.lib.itemDir(res.added[0])).sort()).toEqual([
      'metadata.json',
      'small.jpg',
    ]);
    expect(env.media.paletteCalls.map((p) => p.path)).toContain(small);
    // Auto-tags of the folder AND its parent, after the caller's tags; filed in the folder.
    expect(a.tags).toEqual(['mine', 'refs-auto', 'sub-auto']);
    expect(a.folders).toEqual([env.folders.sub]);

    // Big png: a WebP thumbnail is written, and the palette is read from a temp copy of it.
    expect(b).toMatchObject({ name: 'big', ext: 'png', width: 1400, height: 1000 });
    expect(b.noThumbnail).toBeUndefined();
    expect(
      readFileSync(itemFile(res.added[1], 'big_thumbnail.png')).subarray(8, 12).toString(),
    ).toBe('WEBP');
    const fromThumb = env.media.paletteCalls.find((p) => p.path.startsWith(env.tmpDir))!;
    expect(fromThumb.head.startsWith('RIFF')).toBe(true);
    expect(tmpLeftovers()).toEqual([]);

    // A PNG named .jpg is stored as a png.
    expect(c).toMatchObject({ name: 'fake', ext: 'png' });
    expect(existsSync(itemFile(res.added[2], 'fake.png'))).toBe(true);

    // Whole-second file times, unique and ordered "date added", and the index knows the items.
    for (const r of [a, b, c]) {
      expect(r.btime % 1000).toBe(0);
      expect(r.mtime % 1000).toBe(0);
    }
    expect(Number(b.modificationTime)).toBe(Number(a.modificationTime) + 1);
    expect(Number(c.modificationTime)).toBe(Number(a.modificationTime) + 2);
    expect(env.index.getRecord(res.added[1])?.name).toBe('big');
    // The partner's Eagle only notices new items through mtime.json, so the adapter must have raised them.
    const mtimes = await env.mtimeIndex();
    for (const [id, r] of [
      [res.added[0], a],
      [res.added[1], b],
      [res.added[2], c],
    ] as const)
      expect(mtimes[id]).toBe(r.lastModified);
    // Sources are never touched.
    expect([small, file('big.png'), fake].every(existsSync)).toBe(true);
  });

  it('keeps type-specific keys and falls back to icon-only when there is no preview', async () => {
    writeFileSync(file('clip.mp4'), 'not really a video');
    writeFileSync(file('notes.xyz'), 'some bytes');
    const res = await env.importer.importPaths([file('clip.mp4'), file('notes.xyz')], {}, ctx);
    const [video, other] = res.added.map((id) => env.recordOf(id));
    expect(video).toMatchObject({
      ext: 'mp4',
      width: 640,
      height: 360,
      resolutionWidth: 640,
      resolutionHeight: 360,
      duration: 2.5,
    });
    expect(other).toMatchObject({ ext: 'xyz', noPreview: true });
    expect(other.width).toBeUndefined();
    expect(other.palettes).toBeUndefined();
    expect(other.processingPalette).toBeUndefined();
  });

  it('reports bad files and keeps importing the good ones', async () => {
    const good = jpg('good.jpg');
    writeFileSync(file('empty.jpg'), '');
    writeFileSync(file('broken.jpg'), 'x');
    env.media.broken.add(file('broken.jpg'));
    writeFileSync(file('Desktop.ini'), '[.ShellClassInfo]');

    const res = await env.importer.importPaths(
      [file('empty.jpg'), file('broken.jpg'), good, file('missing.jpg'), file('Desktop.ini')],
      {},
      ctx,
    );
    expect(res.added).toHaveLength(1);
    const why = Object.fromEntries(res.failed.map((f) => [f.source.split('/').pop(), f.reason]));
    expect(why).toEqual({
      'empty.jpg': 'empty file',
      'broken.jpg': 'could not read this file',
      'missing.jpg': 'file not found',
      'Desktop.ini': 'skipped: hidden or system file',
    });
  });

  it('never imports a file that lives inside the library, and refuses a read-only library', async () => {
    const before = (await env.lib.listItemIds()).length;
    const inside = join(env.lib.root, 'images/LT24XY3DPJFLK.info/0051.jpg');
    const res = await env.importer.importPaths([inside], {}, ctx);
    expect(res.added).toEqual([]);
    expect(res.failed[0].reason).toMatch(/already in the library/);
    // A whole folder inside the library is refused with one message, not one per file.
    const folder = await env.importer.importPaths([join(env.lib.root, 'images')], {}, ctx);
    expect(folder.failed).toHaveLength(1);
    expect(await env.lib.listItemIds()).toHaveLength(before);
    expect(existsSync(inside)).toBe(true);

    const readOnly = await env.readOnlyImporter();
    await expect(readOnly.importPaths([jpg('x.jpg')], {}, ctx)).rejects.toThrow(/read-only/);
    await expect(readOnly.importBytes(new Uint8Array([1]), 'a.png', {}, ctx)).rejects.toThrow(
      /read-only/,
    );
  });

  it('stops between items when aborted and returns what it finished', async () => {
    const paths = Array.from({ length: 12 }, (_, i) => jpg(`p${i}.jpg`, 100 + i));
    const abort = new AbortController();
    const res = await env.importer.importPaths(
      paths,
      {},
      ctx,
      (p) => p.done >= 1 && abort.abort(),
      abort.signal,
    );
    expect(res.added.length).toBeGreaterThanOrEqual(1);
    expect(res.added.length).toBeLessThan(12);
    expect(res.failed).toEqual([]);
    // Every file is accounted for: the ones not imported (never started, or stopped part way)
    // are listed as skipped.
    const addedPaths = res.added.map((id) => file(`${env.recordOf(id).name}.jpg`));
    expect([...addedPaths, ...(res.skipped ?? [])].sort()).toEqual([...paths].sort());
  });

  it('cancelling stops an md5 read that is under way', async () => {
    const first = jpg('same.jpg');
    await env.importer.importPaths([first], {}, ctx);
    const copy = file('same copy.jpg');
    writeFileSync(copy, readFileSync(first)); // same bytes: it must be read to be compared
    env.media.md5Hangs = true;
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 50);
    const res = await env.importer.importPaths([copy], {}, ctx, undefined, abort.signal);
    expect(res).toMatchObject({ added: [], failed: [], duplicates: [], skipped: [copy] });
  });

  it("uses the caller's name (for one file), date added and extra folders", async () => {
    const one = await env.importer.importPaths(
      [jpg('a.jpg')],
      {
        name: 'Named By API.jpg',
        modificationTime: 1_600_000_000_000,
        folderId: env.folders.sub,
        folderIds: [env.folders.refs],
      },
      ctx,
    );
    expect(env.recordOf(one.added[0])).toMatchObject({
      name: 'Named By API',
      modificationTime: 1_600_000_000_000,
      folders: [env.folders.sub, env.folders.refs],
      tags: ['refs-auto', 'sub-auto'],
    });

    const two = await env.importer.importPaths(
      [jpg('b.jpg', 101), jpg('c.jpg', 102)],
      { name: 'Not for a batch', modificationTime: 1_600_000_000_000 },
      ctx,
    );
    const recs = two.added.map((id) => env.recordOf(id));
    expect(recs.map((r) => r.name)).toEqual(['b', 'c']);
    expect(recs.map((r) => r.modificationTime)).toEqual([1_600_000_000_000, 1_600_000_000_001]);

    await expect(
      env.importer.importPaths([jpg('d.jpg', 103)], { folderIds: ['NOPE'] }, ctx),
    ).rejects.toThrow(/no longer exists/);
  });

  it("keeps a text file's text the way Eagle does, even an empty one", async () => {
    writeFileSync(file('notes.txt'), '\uFEFFhello\n' + 'x'.repeat(40_000));
    writeFileSync(file('empty.txt'), '');
    const res = await env.importer.importPaths([file('notes.txt'), file('empty.txt')], {}, ctx);
    expect(res.failed).toEqual([]);
    const [notes, empty] = res.added.map((id) => env.recordOf(id));
    expect(notes.text).toHaveLength(32_768); // the first 32,768 UTF-16 units, BOM included
    expect(String(notes.text).startsWith('\uFEFFhello\n')).toBe(true);
    expect(notes.noPreview).toBeUndefined();
    expect(notes.width).toBeUndefined();
    expect(notes.palettes).toBeUndefined();
    expect(empty.text).toBe('');
    expect(env.media.thumbCalls).toEqual([]);
  });

  it('rejects a target folder that does not exist', async () => {
    await expect(
      env.importer.importPaths([jpg('a.jpg')], { folderId: 'NOPE' }, ctx),
    ).rejects.toThrow(/no longer exists/);
  });
});

describe('duplicates', () => {
  it('skips a file whose content is already in the library, whatever its name', async () => {
    const original = jpg('one.jpg');
    const first = await env.importer.importPaths([original], {}, ctx);
    expect(first.added).toHaveLength(1);
    const count = (await env.lib.listItemIds()).length;

    writeFileSync(file('renamed.jpg'), readFileSync(original));
    // 'ask' is the default: the caller decides, so nothing is imported here either.
    for (const onDuplicate of ['skip', 'ask', undefined] as const) {
      const again = await env.importer.importPaths(
        [original, file('renamed.jpg')],
        { onDuplicate },
        ctx,
      );
      expect(again.added).toEqual([]);
      expect(again.duplicates).toEqual([
        { source: original, existingId: first.added[0] },
        { source: file('renamed.jpg'), existingId: first.added[0] },
      ]);
    }
    expect(await env.lib.listItemIds()).toHaveLength(count);

    // "Use existing" files the one item where the user asked instead of importing a twin.
    const merged = await env.importer.importPaths(
      [original],
      { onDuplicate: 'use-existing', folderId: env.folders.sub, tags: ['extra'] },
      ctx,
    );
    expect(merged.added).toEqual(first.added);
    expect(env.recordOf(first.added[0])).toMatchObject({
      folders: [env.folders.sub],
      tags: ['extra', 'refs-auto', 'sub-auto'],
    });
    expect(env.index.getRecord(first.added[0])?.folders).toEqual([env.folders.sub]);
    expect(await env.lib.listItemIds()).toHaveLength(count);

    // "Keep both" really does import a twin.
    const both = await env.importer.importPaths([original], { onDuplicate: 'keep-both' }, ctx);
    expect(both.added).toHaveLength(1);
    expect(both.added[0]).not.toBe(first.added[0]);
  });

  it('reads a file for its md5 only when the library has one of the same size and type, and keeps what it read', async () => {
    const a = jpg('a.jpg');
    const first = await env.importer.importPaths([a, png('other.png')], {}, ctx);
    expect(env.media.md5Calls).toEqual([]); // nothing in the library could match
    const [id] = first.added;

    // The same bytes under another name: both are read once, and the library copy's hash is kept
    // with the fingerprint the duplicate finder checks (size + the copy's mtime).
    writeFileSync(file('copy.jpg'), readFileSync(a));
    const again = await env.importer.importPaths([file('copy.jpg')], { onDuplicate: 'skip' }, ctx);
    expect(again.duplicates).toEqual([{ source: file('copy.jpg'), existingId: id }]);
    expect(env.media.md5Calls).toHaveLength(2);
    const row = env.index.getHashes([id])[0];
    expect(row).toMatchObject({ size: env.recordOf(id).size, fileMtime: env.recordOf(id).mtime });

    // A cached hash only counts while the file's mtime still matches it.
    env.index.setHash(id, { size: row.size, fileMtime: row.fileMtime + 5000, md5: 'stale' });
    const third = await env.importer.importPaths([file('copy.jpg')], { onDuplicate: 'skip' }, ctx);
    expect(third.duplicates).toHaveLength(1);

    // Same size, different bytes: imported, and the md5 read for the check is stored for it too.
    writeFileSync(file('one.xyz'), 'aaaa');
    writeFileSync(file('two.xyz'), 'bbbb');
    await env.importer.importPaths([file('one.xyz')], {}, ctx);
    const two = await env.importer.importPaths([file('two.xyz')], {}, ctx);
    expect(two.added).toHaveLength(1);
    expect(env.index.getHashes(two.added)[0]).toMatchObject({
      md5: await env.media.md5(file('two.xyz')),
      fileMtime: env.recordOf(two.added[0]).mtime,
    });
  });

  it('catches identical files inside one batch, and ignores trashed items', async () => {
    const a = jpg('a.jpg');
    writeFileSync(file('a-copy.jpg'), readFileSync(a));
    writeFileSync(file('a-copy2.jpg'), readFileSync(a));
    env.media.thumbDelayMs = 40; // keep all three in flight together
    const res = await env.importer.importPaths(
      [a, file('a-copy.jpg'), file('a-copy2.jpg')],
      { onDuplicate: 'skip' },
      ctx,
    );
    expect(res.added).toHaveLength(1);
    expect(res.duplicates.map((d) => d.existingId)).toEqual([res.added[0], res.added[0]]);

    // A trashed twin doesn't count as "already there".
    const rec = env.index.getRecord(res.added[0])!;
    env.index.upsertRecords([{ ...rec, isDeleted: true }]);
    const back = await env.importer.importPaths([a], { onDuplicate: 'skip' }, ctx);
    expect(back.added).toHaveLength(1);
  });
});

describe('folder structure', () => {
  it('recreates nested folders in one root write and files each item in its folder', async () => {
    const tree = join(env.src, 'tree');
    for (const d of ['Sub1/Deep', 'Sub2', 'Skip.library'])
      mkdirSync(join(tree, d), { recursive: true });
    makeImage(join(tree, 'a.jpg'), '-size 90x80 gradient:red-blue');
    makeImage(join(tree, 'Sub1/b.png'), '-size 91x80 gradient:red-blue', 'png');
    makeImage(join(tree, 'Sub1/Deep/c.jpg'), '-size 92x80 gradient:red-blue');
    makeImage(join(tree, 'Skip.library/x.jpg'), '-size 93x80 gradient:red-blue');
    makeImage(join(tree, 'Sub1/.hidden.jpg'), '-size 94x80 gradient:red-blue');
    writeFileSync(join(tree, 'Sub1/Desktop.ini'), 'x');

    const res = await env.importer.importPaths(
      [tree],
      { folderId: env.folders.refs, keepFolderStructure: true },
      ctx,
    );
    expect(res.failed).toEqual([]);
    expect(res.added).toHaveLength(3);
    expect(env.spy.rootWrites).toBe(1);
    expect(env.spy.events[0]).toBe('root'); // folders exist before any item points at them

    const root = (await env.lib.readRoot()).value;
    const refs = root.folders[0];
    const treeFolder = refs.children.find((f: EagleFolderRecord) => f.name === 'tree')!;
    expect(refs.children.map((f: EagleFolderRecord) => f.name).sort()).toEqual(['Sub', 'tree']);
    expect(treeFolder.children.map((f: EagleFolderRecord) => f.name)).toEqual(['Sub1']); // Sub2 is empty: not created
    const sub1 = treeFolder.children[0];
    const deep = sub1.children[0];
    expect(deep.name).toBe('Deep');
    expect(Object.keys(treeFolder)).toEqual([
      'id',
      'name',
      'description',
      'children',
      'modificationTime',
      'tags',
      'password',
      'passwordTips',
    ]);

    const [a, b, c] = res.added.map((id) => env.recordOf(id));
    expect([a.folders, b.folders, c.folders]).toEqual([[treeFolder.id], [sub1.id], [deep.id]]);
    for (const r of [a, b, c]) expect(r.tags).toEqual(['refs-auto']); // the parent's auto-tag reaches new subfolders
    expect(env.index.getRoot()?.folders[0].children.length).toBe(2); // index saw the new tree

    // Importing the same tree again reuses the folders instead of making twins.
    const again = await env.importer.importPaths(
      [tree],
      { folderId: env.folders.refs, keepFolderStructure: true, onDuplicate: 'skip' },
      ctx,
    );
    expect(again.duplicates).toHaveLength(3);
    expect(env.spy.rootWrites).toBe(1);

    // Without keepFolderStructure everything lands flat in the target folder.
    const flat = await env.importer.importPaths(
      [tree],
      { folderId: env.folders.sub, onDuplicate: 'keep-both' },
      ctx,
    );
    expect(flat.added).toHaveLength(3);
    expect(flat.added.every((id) => env.recordOf(id).folders[0] === env.folders.sub)).toBe(true);
    expect(env.spy.rootWrites).toBe(1);
  });

  it('says so when a folder has nothing to import', async () => {
    mkdirSync(join(env.src, 'empty'));
    const res = await env.importer.importPaths(
      [join(env.src, 'empty')],
      { keepFolderStructure: true },
      ctx,
    );
    expect(res.failed).toEqual([
      { source: join(env.src, 'empty'), reason: 'no files to import in this folder' },
    ]);
    expect(env.spy.rootWrites).toBe(0);
  });
});

describe('URLs, bytes and bookmarks', () => {
  let server: Server;
  let base: string;
  let seen: IncomingHttpHeaders[];
  let bytes: Buffer;

  beforeEach(async () => {
    png('served.png');
    bytes = readFileSync(file('served.png'));
    seen = [];
    server = createServer((req, res) => {
      seen.push(req.headers);
      const url = req.url ?? '';
      if (url === '/with-name') {
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-disposition': `attachment; filename*=UTF-8''Cool%20Pic.png`,
        });
        res.end(bytes);
      } else if (url === '/plain/pic%20one.php') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(bytes);
      } else if (url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          `<html><head><title>ignored</title><meta content="A &amp; B" property="og:title">` +
            `<meta property='og:image' content='/plain/pic%20one.php'></head><body>x</body></html>`,
        );
      } else if (url === '/moved') {
        res.writeHead(302, { location: '/with-name' });
        res.end();
      } else if (url === '/bare-page') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><head><title> Bare\n</title></head></html>');
      } else if (url === '/stall-headers') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.flushHeaders(); // then nothing
      } else if (url === '/stall-body') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.write(bytes.subarray(0, 100)); // then nothing
      } else if (url === '/no-length') {
        res.writeHead(200, { 'content-type': 'image/png' }); // chunked: no Content-Length
        res.end(Buffer.alloc(5000));
      } else if (url === '/huge') {
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': String(3 * 1024 ** 3),
        });
        res.flushHeaders(); // never sends the body
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
  });

  it('downloads with the server file name, a browser-like Referer, and stores the page url', async () => {
    const res = await env.importer.importUrl(
      `${base}/with-name`,
      {
        url: 'https://site.example/post/1',
        headers: { 'X-Test': 'yes' },
        folderId: env.folders.refs,
      },
      ctx,
    );
    expect(res.failed).toEqual([]);
    const rec = env.recordOf(res.added[0]);
    expect(rec).toMatchObject({
      name: 'Cool Pic',
      ext: 'png',
      url: 'https://site.example/post/1',
      folders: [env.folders.refs],
      tags: ['refs-auto'],
    });
    expect(seen[0].referer).toBe(`${base}/`); // origin of the file's own address by default
    expect(seen[0]['user-agent']).toMatch(/Chrome\/\d+/);
    expect(seen[0]['x-test']).toBe('yes');
    expect(tmpLeftovers()).toEqual([]);
    expect(env.spy.created[0].moveSource).toBe(true);

    await env.importer.importUrl(
      `${base}/with-name`,
      { referer: 'https://site.example/post/1', onDuplicate: 'keep-both' },
      ctx,
    );
    expect(seen[1].referer).toBe('https://site.example/post/1');
  });

  it('names from opts, then the URL path; keeps the image url only when no page url is given', async () => {
    const byPath = await env.importer.importUrl(`${base}/plain/pic%20one.php`, {}, ctx);
    expect(env.recordOf(byPath.added[0])).toMatchObject({
      name: 'pic one',
      ext: 'png',
      url: `${base}/plain/pic%20one.php`,
    });
    const named = await env.importer.importUrl(
      `${base}/plain/pic%20one.php`,
      { name: 'My name.png', onDuplicate: 'keep-both' },
      ctx,
    );
    expect(env.recordOf(named.added[0]).name).toBe('My name');
  });

  it('saves a web page link as a bookmark, with its preview picture as the thumbnail', async () => {
    const page = await env.importer.importUrl(`${base}/page`, { url: 'https://elsewhere/' }, ctx);
    expect(page.failed).toEqual([]);
    const rec = env.recordOf(page.added[0]);
    expect(rec).toMatchObject({ name: 'A & B', ext: 'url', url: `${base}/page`, width: 200 });
    expect(rec.noPreview).toBeUndefined();
    expect(readFileSync(itemFile(page.added[0]!, `${rec.name}.url`), 'utf8')).toContain(
      `URL=${base}/page`,
    );
    // No preview picture on the page: the plain card, at Eagle's screenshot size.
    const bare = await env.importer.importUrl(`${base}/bare-page`, {}, ctx);
    expect(env.recordOf(bare.added[0])).toMatchObject({ name: 'Bare', width: 1440, height: 900 });
    expect(tmpLeftovers()).toEqual([]);
  });

  it('turns errors and huge files into failures, and cleans up', async () => {
    const gone = await env.importer.importUrl(`${base}/nope`, {}, ctx);
    expect(gone.failed[0].reason).toMatch(/404/);
    const huge = await env.importer.importUrl(`${base}/huge`, {}, ctx);
    expect(huge.failed[0].reason).toMatch(/2 GB/);
    const bad = await env.importer.importUrl('ftp://example.com/a.png', {}, ctx);
    expect(bad.failed[0].reason).toMatch(/only web links/);
    const offline = await env.importer.importUrl('http://127.0.0.1:1/a.png', {}, ctx);
    expect(offline.failed[0].reason).toMatch(/could not reach/);
    expect(tmpLeftovers()).toEqual([]);
    expect(env.spy.created).toEqual([]);
  });

  it('stops a download at the size cap even without a Content-Length', async () => {
    await expect(downloadUrl(`${base}/no-length`, env.tmpDir, { maxBytes: 1000 })).rejects.toThrow(
      /bigger than/,
    );
    expect(tmpLeftovers()).toEqual([]);
  });

  it('gives up on a server that stops sending, and leaves no partial file', async () => {
    for (const path of ['/stall-headers', '/stall-body']) {
      await expect(downloadUrl(base + path, env.tmpDir, { idleTimeoutMs: 150 })).rejects.toThrow(
        /timed out/,
      );
    }
    expect(tmpLeftovers()).toEqual([]);
  });

  it('never lets a page on the internet point Boogie at a local address; local pages still work', async () => {
    // The picture a public page names (or a redirect from it) is on this computer: refused, unsent.
    const asked = seen.length;
    await expect(
      downloadUrl(`${base}/plain/pic%20one.php`, env.tmpDir, {
        chosenBy: 'http://93.184.216.34/post',
      }),
    ).rejects.toThrow(/address on this computer or network/);
    expect(seen.length).toBe(asked);
    // A local link (a dev server) follows its redirects as before.
    const got = await downloadUrl(`${base}/moved`, env.tmpDir);
    expect(got.headerName).toBe('Cool Pic.png');
    await rm(got.path);
    expect(isPrivateAddress('192.168.1.20')).toBe(true);
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('fd12::1')).toBe(true);
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
    expect(await isLocalUrl('http://localhost:3000/')).toBe(true);
  });

  it('a download stops at once when its job is cancelled', async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 100);
    const t0 = Date.now();
    const res = await env.importer.importUrl(`${base}/stall-body`, {}, ctx, stop.signal);
    expect(res.failed[0]?.reason).toMatch(/cancelled/);
    expect(Date.now() - t0).toBeLessThan(5000); // not the 60 s idle timeout
    expect(tmpLeftovers()).toEqual([]);
  });

  it('imports a data: URL', async () => {
    const res = await env.importer.importUrl(
      `data:image/png;base64,${bytes.toString('base64')}`,
      { url: 'https://page.example/' },
      ctx,
    );
    expect(env.recordOf(res.added[0])).toMatchObject({
      name: 'image',
      ext: 'png',
      url: 'https://page.example/',
    });
    const noPage = await env.importer.importUrl(
      `data:image/png;base64,${bytes.toString('base64')}`,
      { onDuplicate: 'keep-both' },
      ctx,
    );
    expect(env.recordOf(noPage.added[0]).url).toBe(''); // never store a huge data: URL as the source
  });

  it('imports raw bytes such as a clipboard image', async () => {
    const res = await env.importer.importBytes(
      bytes,
      'Clipboard - 2026-09-28 16.10.00.png',
      { folderId: env.folders.sub },
      ctx,
    );
    expect(env.recordOf(res.added[0])).toMatchObject({
      name: 'Clipboard - 2026-09-28 16.10.00',
      ext: 'png',
      folders: [env.folders.sub],
    });
    expect(tmpLeftovers()).toEqual([]);
    // No extension at all (Eagle's clipboard naming): the ".00" of the time is not an extension.
    const bare = await env.importer.importBytes(
      bytes,
      'Clipboard - 2026-09-28 16.10.00',
      { onDuplicate: 'keep-both' },
      ctx,
    );
    expect(env.recordOf(bare.added[0])).toMatchObject({
      name: 'Clipboard - 2026-09-28 16.10.00',
      ext: 'png',
    });
    const empty = await env.importer.importBytes(new Uint8Array(), 'nothing.png', {}, ctx);
    expect(empty.failed[0].reason).toBe('empty file');
  });

  it('writes a bookmark as a .url file with a real thumbnail when given a screenshot', async () => {
    const shot = readFileSync(png('shot.png', 300, 'red-blue')); // small: would normally get no thumbnail
    const res = await env.importer.importBookmark(
      'https://example.com/page',
      'Example Page',
      { thumbnailPng: shot, tags: ['b'] },
      ctx,
    );
    expect(res.failed).toEqual([]);
    const id = res.added[0];
    const rec = env.recordOf(id);
    expect(rec).toMatchObject({
      name: 'Example Page',
      ext: 'url',
      url: 'https://example.com/page',
      tags: ['b'],
      width: 300,
      height: 150,
    });
    expect(rec.palettes).toBeDefined();
    // Byte for byte what Eagle writes (LF, then five spaces).
    expect(readFileSync(itemFile(id, 'Example Page.url'), 'utf8')).toBe(
      '[InternetShortcut]\nURL=https://example.com/page\n     ',
    );
    expect(
      readFileSync(itemFile(id, 'Example Page_thumbnail.png')).subarray(8, 12).toString(),
    ).toBe('WEBP');
    expect(rec.noThumbnail).toBeUndefined();
    expect(tmpLeftovers()).toEqual([]);

    // Without a screenshot Eagle takes its own (1440x900); Boogie draws a plain card that size.
    const plain = await env.importer.importBookmark('https://example.org/', '', {}, ctx);
    const card = env.recordOf(plain.added[0]);
    expect(card).toMatchObject({ name: 'example.org', ext: 'url', width: 1440, height: 900 });
    expect(card.noPreview).toBeUndefined();
    expect(env.media.thumbCalls.at(-1)?.probe).toMatchObject({ ext: 'svg', width: 1440 });
    expect(tmpLeftovers()).toEqual([]);
  });
});

describe('the temp folder', () => {
  it('is refused when it sits inside the library', () => {
    const deps = {
      lib: env.lib,
      index: env.index,
      media: env.media,
      nameMaxChars: 150,
    } as unknown as ImportDeps;
    expect(() => importers.create({ ...deps, tmpDir: join(env.lib.root, 'tmp') })).toThrow(
      /outside the library/,
    );
  });
});
