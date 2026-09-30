import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ProbeResult } from '../contracts';
import { createMediaService } from './index';
import { CACHE_DIR, bytesDims, fixture, makeImage, makeJpegWithOrientation } from './testFixtures';
import { decideNoThumbnail, thumbnailDims } from './thumbnail';

const probe = (over: Partial<ProbeResult>): ProbeResult => ({
  ext: 'jpg',
  width: 500,
  height: 500,
  duration: null,
  animated: false,
  kind: 'image',
  ...over,
});
const media = createMediaService({ cacheDir: CACHE_DIR });
afterAll(() => media.close());

/** WebP: "RIFF" size "WEBP". */
const isWebp = (b: Uint8Array | null) =>
  !!b &&
  Buffer.from(b.subarray(0, 4)).toString() === 'RIFF' &&
  Buffer.from(b.subarray(8, 12)).toString() === 'WEBP';
const dims = (path: string) =>
  execFileSync('vipsheader', ['-f', 'width', '-f', 'height', path], {
    env: { ...process.env, VIPS_WARNING: '0' },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .toString()
    .trim()
    .split('\n')
    .map(Number);

describe('when Eagle writes no thumbnail', () => {
  it('follows the decision table', () => {
    const no = (p: Partial<ProbeResult>, bytes: number) =>
      decideNoThumbnail(probe(p), bytes).noThumbnail;
    expect(no({ ext: 'jpg', width: 960, height: 960 }, 15_000_000)).toBe(true);
    expect(no({ ext: 'jpg', width: 961, height: 500 }, 1000)).toBe(false);
    expect(no({ ext: 'jpg', width: 500, height: 500 }, 15_000_001)).toBe(false);
    expect(no({ ext: 'bmp' }, 1000)).toBe(true);
    expect(no({ ext: 'png' }, 1_048_576)).toBe(true);
    expect(no({ ext: 'png' }, 1_048_577)).toBe(false); // small PNGs over 1 MiB always get one
    expect(no({ ext: 'webp' }, 50_000_000)).toBe(true); // no size test for webp
    expect(no({ ext: 'webp', animated: true }, 1000)).toBe(false);
    expect(no({ ext: 'avif', animated: true }, 1000)).toBe(false);
    expect(no({ ext: 'gif', width: 10, height: 10 }, 100)).toBe(false); // gif never
    expect(no({ ext: 'pdf', width: 10, height: 10, kind: 'doc' }, 100)).toBe(false);
  });

  it('marks svg under 100 KB as removeThumbnail and bigger ones as forceThumbnail', () => {
    expect(decideNoThumbnail(probe({ ext: 'svg' }), 99_999)).toEqual({
      noThumbnail: true,
      removeThumbnail: true,
    });
    expect(decideNoThumbnail(probe({ ext: 'svg' }), 100_000)).toEqual({
      noThumbnail: false,
      forceThumbnail: true,
    });
  });
});

describe('thumbnail size', () => {
  it('keeps small pictures, else the short edge becomes S (even when that scales up)', () => {
    expect(thumbnailDims(300, 200, 320)).toEqual([300, 200]);
    expect(thumbnailDims(1177, 1452, 320)).toEqual([320, 394]);
    expect(thumbnailDims(1200, 797, 320)).toEqual([481, 320]);
    expect(thumbnailDims(300, 1000, 320)).toEqual([320, 1066]); // short edge 300 -> 320
    expect(thumbnailDims(1000, 1000, 320)).toEqual([320, 320]);
    expect(thumbnailDims(595, 841, 480)).toEqual([480, 678]);
  });
});

describe('eagleThumbnail', () => {
  it('a small jpg gets no thumbnail, and reports its own size', async () => {
    const file = makeImage('t-small.jpg', 400, 300);
    const p = await media.probe(file);
    expect(await media.eagleThumbnail(file, p)).toEqual({
      noThumbnail: true,
      bytes: null,
      width: 400,
      height: 300,
    });
  });

  it("skips types Windows Eagle can't draw, and `force` always draws", async () => {
    const small = makeImage('t-force.png', 300, 150);
    const p = await media.probe(small);
    expect((await media.eagleThumbnail(small, p)).noThumbnail).toBe(true);
    const forced = await media.eagleThumbnail(small, p, undefined, { force: true });
    expect(isWebp(forced.bytes)).toBe(true);
    expect([forced.width, forced.height]).toEqual([300, 150]);
    // The partner's Eagle shows a .kra as an icon and would strip a thumbnail we drew on regenerate.
    expect(await media.eagleThumbnail(small, { ...p, ext: 'kra' })).toEqual({
      noThumbnail: false,
      bytes: null,
      width: null,
      height: null,
    });
  });

  it('a 2000 px png gets WebP bytes at short edge 320', async () => {
    const file = makeImage('t-big.png', 2000, 1500);
    const t = await media.eagleThumbnail(file, await media.probe(file));
    expect(t.noThumbnail).toBe(false);
    expect(isWebp(t.bytes)).toBe(true);
    expect([t.width, t.height]).toEqual([426, 320]);
  });

  it('writes the size the rule says, into the file: a thin tall image is scaled up on its short edge', async () => {
    const file = makeImage('t-thin.png', 300, 1000);
    const t = await media.eagleThumbnail(file, await media.probe(file));
    expect([t.width, t.height]).toEqual([320, 1066]);
    mkdirSync(CACHE_DIR, { recursive: true });
    const out = join(CACHE_DIR, 'thin.webp');
    writeFileSync(out, t.bytes!);
    expect(dims(out)).toEqual([320, 1066]);
  });

  it('EXIF-rotated photos come out upright (dimensions swapped)', async () => {
    const file = makeJpegWithOrientation('t-exif6.jpg', 2000, 1000, 6);
    const p = await media.probe(file);
    expect([p.width, p.height]).toEqual([1000, 2000]);
    const t = await media.eagleThumbnail(file, p);
    expect([t.width, t.height]).toEqual([320, 640]);
  });

  it('a rotated HEIC (an irot box, the way phones store it) comes out upright', async () => {
    const heic = fixture('t-rot.heic', (out) =>
      execFileSync('magick', ['-size', '400x200', 'gradient:red-blue', '-orient', 'RightTop', out]),
    );
    const p = await media.probe(heic);
    expect([p.ext, p.width, p.height]).toEqual(['heic', 200, 400]);
    const t = await media.eagleThumbnail(heic, p);
    expect([t.width, t.height]).toEqual([320, 640]);
    expect(bytesDims(t.bytes!)).toEqual([320, 640]);
  });

  // A wide-gamut source must be converted to sRGB like a browser does, not passed through.
  const CLAY = '/usr/share/color/icc/krita/ClayRGB-elle-V2-g22.icc';
  it.skipIf(!existsSync(CLAY))('converts an embedded wide-gamut profile to sRGB', async () => {
    const tagged = fixture('t-clay.jpg', (out) =>
      execFileSync('magick', [
        '-size',
        '1200x900',
        'xc:rgb(200,60,40)',
        '-profile',
        CLAY,
        '-quality',
        '95',
        out,
      ]),
    );
    const plain = fixture('t-plain.jpg', (out) =>
      execFileSync('magick', ['-size', '1200x900', 'xc:rgb(200,60,40)', '-quality', '95', out]),
    );
    const red = async (file: string) => {
      const t = await media.eagleThumbnail(file, await media.probe(file));
      mkdirSync(CACHE_DIR, { recursive: true });
      const out = join(CACHE_DIR, `red-${Math.random().toString(36).slice(2)}.webp`);
      writeFileSync(out, t.bytes!);
      return Number(
        /srgb\((\d+)/.exec(
          execFileSync('magick', [out, '-format', '%[pixel:p{10,10}]', 'info:']).toString(),
        )![1],
      );
    };
    expect(await red(plain)).toBeLessThan(205); // untagged: left as is (about 200)
    expect(await red(tagged)).toBeGreaterThan(220); // ClayRGB 200 is much redder in sRGB (about 233)
  });

  it('an undecodable image fails softly: no bytes, not noThumbnail', async () => {
    const file = makeImage('t-corrupt.png', 1500, 1500, { noise: true });
    const p = await media.probe(file);
    // Same probe, but the file is now all zeros (like the zero-filled files in the survey).
    mkdirSync(CACHE_DIR, { recursive: true });
    const broken = join(CACHE_DIR, 'broken.png');
    writeFileSync(broken, Buffer.alloc(200_000));
    const t = await media.eagleThumbnail(broken, p);
    expect(t).toEqual({ noThumbnail: false, bytes: null, width: null, height: null });
  });
});

// Ground truth: what real Eagle 4 wrote for the same originals (read-only).
const LIBS = ['sample.library', 'art-archive.library']
  .map((n) => resolve('research/sandbox/templates', n, 'images'))
  .filter(existsSync);

describe.skipIf(LIBS.length === 0)('against thumbnails Eagle 4 made', () => {
  it('agrees on noThumbnail, dimensions and thumbnail size for real items', async () => {
    let checked = 0;
    const perExt: Record<string, number> = {};
    for (const images of LIBS) {
      for (const dir of readdirSync(images)) {
        if (checked >= 60) break;
        // 2025+ items only (first 8 id characters are the import time, base36): older ones used size 400.
        const isTest = images.includes('sample.library');
        if (!isTest && parseInt(dir.slice(0, 8), 36) < Date.parse('2025-06-01')) continue;
        let rec: {
          name: string;
          ext: string;
          width?: number;
          height?: number;
          noThumbnail?: boolean;
        };
        try {
          rec = JSON.parse(readFileSync(join(images, dir, 'metadata.json'), 'utf8'));
        } catch {
          continue;
        }
        if ((perExt[rec.ext] ?? 0) >= 12) continue;
        const original = join(images, dir, `${rec.name}.${rec.ext}`);
        const thumb = join(images, dir, `${rec.name}_thumbnail.png`);
        if (!existsSync(original) || (!rec.noThumbnail && !existsSync(thumb))) continue;
        perExt[rec.ext] = (perExt[rec.ext] ?? 0) + 1;
        checked++;

        const p = await media.probe(original);
        expect([p.ext, p.width, p.height], dir).toEqual([rec.ext, rec.width, rec.height]);
        const t = await media.eagleThumbnail(original, p);
        expect(t.noThumbnail, dir).toBe(!!rec.noThumbnail);
        if (!rec.noThumbnail) expect([t.width, t.height], dir).toEqual(dims(thumb));
      }
    }
    expect(checked).toBeGreaterThan(5);
    console.log('checked against real Eagle output:', JSON.stringify(perExt));
  });

  it("a 1177x1452 jpg (sample) gets Eagle's 320x394 thumbnail", async () => {
    const dir = resolve('research/sandbox/templates/sample.library/images/LT24XY3DPJFLK.info');
    if (!existsSync(dir)) return;
    const original = join(dir, '0051.jpg');
    const t = await media.eagleThumbnail(original, await media.probe(original));
    expect([t.noThumbnail, t.width, t.height]).toEqual([false, 320, 394]);
  });
});
