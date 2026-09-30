import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMediaService } from '../index';
import { CACHE_DIR } from '../testFixtures';
import { mmcqPalette } from './mmcq';

/** w x h RGBA filled by `pixel(x, y)`. */
function image(
  w: number,
  h: number,
  pixel: (x: number, y: number) => [number, number, number, number],
): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(pixel(x, y), (y * w + x) * 4);
  return out;
}

describe('mmcq palette (synthetic)', () => {
  it('two flat colors 70/30 give two entries with whole-number ratios, biggest first', () => {
    const rgba = image(100, 10, (x) => (x < 70 ? [200, 40, 40, 255] : [30, 60, 220, 255]));
    const p = mmcqPalette(rgba, 100, 10);
    expect(p.map((e) => e.ratio)).toEqual([70, 30]);
    // bin centers of the 5-bit quantization, truncated (200>>3=25 -> 204, 40>>3=5 -> 44)
    expect(p[0].color).toEqual([204, 44, 44]);
    expect(Object.keys(p[0])).toEqual(['color', 'ratio']);
  });

  it('skips pixels with alpha below 170 and returns [] when nothing is left', () => {
    const half = image(20, 10, (x) => (x < 10 ? [255, 0, 0, 255] : [0, 0, 255, 169]));
    expect(mmcqPalette(half, 20, 10)).toEqual([{ color: [252, 4, 4], ratio: 100 }]);
    expect(
      mmcqPalette(
        image(4, 4, () => [1, 2, 3, 0]),
        4,
        4,
      ),
    ).toEqual([]);
  });

  it('a gradient obeys the output invariants: sorted, at most 11, ratios >= 0.25, whole from 5 up', () => {
    const rgba = image(320, 200, (x, y) => [
      (x * 255) / 319,
      (y * 255) / 199,
      ((x + y) * 255) / 519,
      255,
    ]);
    const p = mmcqPalette(rgba, 320, 200);
    expect(p.length).toBeGreaterThan(4);
    expect(p.length).toBeLessThanOrEqual(11);
    for (let i = 1; i < p.length; i++) expect(p[i].ratio).toBeLessThanOrEqual(p[i - 1].ratio);
    for (const e of p) {
      expect(e.ratio).toBeGreaterThanOrEqual(0.25);
      if (e.ratio >= 5) expect(Number.isInteger(e.ratio)).toBe(true);
      expect(e.color.every((c) => Number.isInteger(c) && c >= 0 && c <= 255)).toBe(true);
    }
  });
});

// Eagle's own palettes are the ground truth. Portrait thumbnails are 320 px wide, so they are
// analysed unscaled and the palette must match exactly (the research got 79 of 79).
const ART = resolve('research/sandbox/templates/art-archive.library/images');
const TEST_LIB = resolve('research/sandbox/templates/sample.library/images');

function portraitSamples(
  images: string,
  limit: number,
  since = 0,
): { thumb: string; palettes: { color: number[]; ratio: number }[] }[] {
  const found: { thumb: string; palettes: { color: number[]; ratio: number }[] }[] = [];
  for (const dir of readdirSync(images)) {
    if (found.length >= limit) break;
    // The first 8 characters of an id are the import time in base36. Older items came from Eagle 3.
    if (parseInt(dir.slice(0, 8), 36) < since) continue;
    let rec: {
      name: string;
      noThumbnail?: boolean;
      palettes?: { color: number[]; ratio: number }[];
    };
    try {
      rec = JSON.parse(readFileSync(join(images, dir, 'metadata.json'), 'utf8'));
    } catch {
      continue;
    }
    if (!rec.palettes?.length || rec.noThumbnail) continue;
    const thumb = join(images, dir, `${rec.name}_thumbnail.png`);
    if (!existsSync(thumb)) continue;
    // Only Eagle 4 thumbnails (short edge 320) come from the pipeline we reproduce.
    const [w, h] = execFileSync('vipsheader', ['-f', 'width', '-f', 'height', thumb], {
      env: { ...process.env, VIPS_WARNING: '0' },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
      .split('\n')
      .map(Number);
    if (w === 320 && h >= 320) found.push({ thumb, palettes: rec.palettes });
  }
  return found;
}

describe.skipIf(!existsSync(ART) || !existsSync(TEST_LIB))(
  'palette against real Eagle palettes',
  () => {
    it('reproduces stored palettes exactly for portrait thumbnails', async () => {
      const media = createMediaService({ cacheDir: CACHE_DIR });
      const samples = [
        ...portraitSamples(TEST_LIB, 3),
        ...portraitSamples(ART, 25, Date.parse('2025-06-01')),
      ];
      expect(samples.length).toBeGreaterThanOrEqual(10);
      let exact = 0;
      for (const s of samples) {
        const got = await media.palette(s.thumb);
        const want = s.palettes.map((p) => ({ color: p.color, ratio: p.ratio })); // drops Eagle's $$hashKey
        if (JSON.stringify(got) === JSON.stringify(want)) exact++;
      }
      await media.close();
      console.log(`palette exact matches: ${exact}/${samples.length}`);
      expect(exact).toBe(samples.length);
    });
  },
);
