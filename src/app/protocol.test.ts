import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProtocolHandler, parseBoogieUrl, parseRange } from './protocol';

describe('parseBoogieUrl', () => {
  it('reads kind, library, item and version', () => {
    expect(parseBoogieUrl('boogie://thumb/0123456789abcdef/LT24XY3DPJFLK?v=1700000000000')).toEqual(
      {
        kind: 'thumb',
        libraryId: '0123456789abcdef',
        itemId: 'LT24XY3DPJFLK',
        version: '1700000000000',
      },
    );
    expect(parseBoogieUrl('boogie://preview/abc/DEF')?.version).toBeNull();
  });

  it('rejects anything that is not exactly kind/library/item', () => {
    for (const bad of [
      'https://thumb/abc/DEF',
      'boogie://thumbs/abc/DEF', // unknown kind
      'boogie://thumb/abc', // missing item
      'boogie://thumb/abc/DEF/extra',
      'boogie://thumb/abc/..%2F..%2Fetc%2Fpasswd', // encoded traversal
      'boogie://thumb/abc/%00',
      'boogie://thumb/abc/%E0%A4%A', // broken escape
      'not a url',
    ]) {
      expect(parseBoogieUrl(bad), bad).toBeNull();
    }
  });
});

describe('parseRange', () => {
  it('handles open-ended, closed and suffix ranges', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 }); // longer than the file
    expect(parseRange('bytes=990-5000', 1000)).toEqual({ start: 990, end: 999 }); // end is clamped
  });

  it('says unsatisfiable when the start is past the end', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-10', 0)).toBe('unsatisfiable');
  });

  it('ignores headers it cannot use, so the whole file is served', () => {
    for (const h of [
      null,
      '',
      'items=0-5',
      'bytes=0-5,10-15',
      'bytes=9-3',
      'bytes=-',
      'bytes=abc',
    ]) {
      expect(parseRange(h, 1000), String(h)).toBeNull();
    }
  });
});

describe('protocol handler', () => {
  let dir: string;
  const body = 'abcdefghijklmnopqrstuvwxyz';
  const calls: string[] = [];
  const handler = createProtocolHandler({
    async resolveFile(kind, libraryId, itemId) {
      calls.push(`${kind}/${libraryId}/${itemId}`);
      if (itemId === 'GOOD') return { path: join(dir, 'file.bin'), mime: 'application/x-test' };
      if (itemId === 'WEBP') return { path: join(dir, 'thumb.png'), mime: 'image/png' };
      if (itemId === 'BIG') return { path: join(dir, 'big.bin'), mime: 'video/mp4' };
      if (itemId === 'FOLDER') return { path: dir, mime: 'image/png' }; // a directory is never served
      if (itemId === 'BROKEN') throw new Error('vips exploded');
      return null;
    },
  });
  const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    handler(new Request(`boogie://file/lib/${path}`, { headers, method }));

  beforeAll(async () => {
    const scratch = resolve(import.meta.dirname, '../../.tmp/app');
    await mkdir(scratch, { recursive: true });
    dir = await mkdtemp(join(scratch, 'proto-'));
    await writeFile(join(dir, 'file.bin'), body);
    // An Eagle thumbnail: WebP bytes in a .png file.
    await writeFile(join(dir, 'thumb.png'), Buffer.from('RIFF\0\0\0\0WEBPVP8 rest', 'latin1'));
    await writeFile(join(dir, 'big.bin'), Buffer.alloc(9 * 1024 * 1024, 7)); // streamed, not read whole
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('streams the whole file with cache headers', async () => {
    const res = await get('GOOD?v=7');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
    expect(res.headers.get('content-type')).toBe('application/x-test');
    expect(res.headers.get('content-length')).toBe(String(body.length));
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('cache-control')).toContain('immutable');
    // without the version param we cannot promise the file never changes
    expect((await get('GOOD')).headers.get('cache-control')).toBe('no-cache');
  });

  it('answers a Range with 206 and the right bytes (video seeking)', async () => {
    const res = await get('GOOD?v=1', { range: 'bytes=5-9' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 5-9/${body.length}`);
    expect(await res.text()).toBe('fghij');
    expect(await (await get('GOOD?v=1', { range: 'bytes=-3' })).text()).toBe('xyz');
    const bad = await get('GOOD?v=1', { range: 'bytes=100-' });
    expect(bad.status).toBe(416);
    expect(bad.headers.get('content-range')).toBe(`bytes */${body.length}`);
  });

  it('HEAD has headers but no body', async () => {
    const res = await get('GOOD?v=1', {}, 'HEAD');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(body.length));
    expect(await res.text()).toBe('');
  });

  it('types small files by their bytes, and streams big ones with ranges', async () => {
    expect((await get('WEBP?v=1')).headers.get('content-type')).toBe('image/webp');
    const big = await get('BIG?v=1');
    expect(big.headers.get('content-length')).toBe(String(9 * 1024 * 1024));
    expect((await big.arrayBuffer()).byteLength).toBe(9 * 1024 * 1024);
    const part = await get('BIG?v=1', { range: 'bytes=100-199' });
    expect(part.status).toBe(206);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(new Uint8Array(100).fill(7));
  });

  it('drops a request the page already cancelled, before any file work', async () => {
    const before = calls.length;
    const ctl = new AbortController();
    ctl.abort();
    const res = await handler(new Request('boogie://thumb/lib/GOOD?v=1', { signal: ctl.signal }));
    expect(res.status).toBe(499);
    expect(calls.length).toBe(before); // never resolved, never read
  });

  it('only serves what the host resolved: unknown, directory, bad url and bad method are refused', async () => {
    expect((await get('NOPE?v=1')).status).toBe(404);
    expect((await get('FOLDER?v=1')).status).toBe(404);
    expect((await get('BROKEN?v=1')).status).toBe(500);
    expect((await handler(new Request('boogie://file/lib/..%2Fsecret'))).status).toBe(404);
    expect((await get('GOOD?v=1', {}, 'POST')).status).toBe(405);
    // the malformed url never reached the host
    expect(calls.some((c) => c.includes('..'))).toBe(false);
  });
});
