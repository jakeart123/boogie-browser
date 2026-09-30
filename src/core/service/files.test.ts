import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MediaService, UrlBuilder } from '../contracts';
import { isBrowserViewable } from '../media/formats';
import { isHugeImage, resolveItemFile, type FileSource } from './files';

describe('isHugeImage', () => {
  it('goes by pixels only: a big but modest PNG is left to the browser', () => {
    const layeredPng = { ext: 'png', width: 5000, height: 4000, size: 90e6 };
    const scan = { ext: 'jpg', width: 12000, height: 10000, size: 30e6 };
    expect(isHugeImage(layeredPng)).toBe(false);
    expect(isHugeImage(scan)).toBe(true);
    expect(isHugeImage({ ext: 'gif', width: 12000, height: 10000 })).toBe(false);
  });
});

describe('resolveItemFile', () => {
  it('never serves a huge original as a thumbnail when the item has no thumbnail file', async () => {
    const dir = join(import.meta.dirname, '../../../.tmp/core-final/files-test');
    mkdirSync(dir, { recursive: true });
    const original = join(dir, 'big.jpg');
    writeFileSync(original, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    const rendition = join(dir, 'big-t480.jpg');
    writeFileSync(rendition, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

    const rec = { id: 'KAAAAAAAAAAAA', ext: 'jpg', width: 20000, height: 10000, noThumbnail: true };
    const asked: [string, string, number | undefined][] = [];
    const src = {
      ref: { id: 'lib' },
      lib: { locateOriginal: async () => original, locateThumbnail: async () => null },
      index: { getRecord: () => rec },
      urls: {} as UrlBuilder,
    } as unknown as FileSource;
    const media = {
      isBrowserViewable,
      preview: async (p: string, key: string, edge?: number) => {
        asked.push([p, key, edge]);
        return rendition;
      },
    } as unknown as MediaService;

    const thumb = await resolveItemFile(src, media, 'thumb', rec.id);
    expect(thumb?.path).toBe(rendition);
    expect(asked).toEqual([[original, expect.stringMatching(/-t480$/), 480]]);

    // An ordinary picture without a thumbnail file still shows its original.
    rec.width = 2000;
    rec.height = 1000;
    expect((await resolveItemFile(src, media, 'thumb', rec.id))?.path).toBe(original);
  });
});
