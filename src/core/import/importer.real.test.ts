// End to end with the real adapter, index AND media (vips/ffmpeg subprocesses): what actually lands
// in the library for a small jpg, a big png, a mislabeled png, a video and a bookmark screenshot.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ctx, makeImage, makeRealEnv } from './testkit';

let env: Awaited<ReturnType<typeof makeRealEnv>>;
beforeEach(async () => {
  env = await makeRealEnv('real');
});
afterEach(async () => env.cleanup());

const itemFiles = (id: string) => readdirSync(env.lib.itemDir(id)).sort();
const size = (path: string) => {
  const header = (field: string) =>
    execFileSync('vipsheader', ['-f', field, path], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  return `${header('width')}x${header('height')}`;
};

it('imports real images, a video and a bookmark the way Eagle would', async () => {
  const small = join(env.src, 'small.jpg');
  const big = join(env.src, 'big.png');
  const fake = join(env.src, 'fake.jpg');
  const clip = join(env.src, 'clip.mp4');
  makeImage(small, '-size 100x80 gradient:red-blue');
  makeImage(big, '-size 1400x1000 gradient:red-blue -depth 8');
  makeImage(fake, '-size 200x150 gradient:green-yellow', 'png');
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=320x240:rate=10:duration=2',
    '-pix_fmt',
    'yuv420p',
    clip,
  ]);

  const res = await env.importer.importPaths(
    [small, big, fake, clip],
    { folderId: env.folders.sub },
    ctx,
  );
  expect(res.failed).toEqual([]);
  const [a, b, c, v] = res.added.map((id) => env.recordOf(id));

  // Small jpg: shown as is (no thumbnail file), but it has real dimensions and a real palette.
  expect(a).toMatchObject({ name: 'small', ext: 'jpg', width: 100, height: 80, noThumbnail: true });
  expect(itemFiles(res.added[0])).toEqual(['metadata.json', 'small.jpg']);
  expect(a.palettes?.length).toBeGreaterThan(0);
  expect(a.processingPalette).toBeUndefined();

  // Big png: a real WebP thumbnail with the short edge at 320.
  expect(b).toMatchObject({ name: 'big', ext: 'png', width: 1400, height: 1000 });
  const bThumb = join(env.lib.itemDir(res.added[1]), 'big_thumbnail.png');
  expect(readFileSync(bThumb).subarray(8, 12).toString()).toBe('WEBP');
  expect(size(bThumb)).toBe('448x320');
  expect(b.palettes?.length).toBeGreaterThan(0);

  // A PNG named .jpg is stored as png.
  expect(c).toMatchObject({ name: 'fake', ext: 'png' });

  // Video: dimensions, duration, a frame thumbnail, Eagle's key order.
  expect(v).toMatchObject({
    name: 'clip',
    ext: 'mp4',
    width: 320,
    height: 240,
    resolutionWidth: 320,
    resolutionHeight: 240,
  });
  expect(v.duration).toBeCloseTo(2, 0);
  expect(itemFiles(res.added[3])).toContain('clip_thumbnail.png');
  expect(Object.keys(v).slice(-7, -2)).toEqual([
    'width',
    'height',
    'resolutionWidth',
    'resolutionHeight',
    'duration',
  ]);

  // Everything is filed, tagged, whole-second and raised in mtime.json for the partner's Eagle.
  const mtimes = await env.mtimeIndex();
  for (const [i, r] of [a, b, c, v].entries()) {
    expect(r.folders).toEqual([env.folders.sub]);
    expect(r.tags).toEqual(['refs-auto', 'sub-auto']);
    expect(r.mtime % 1000).toBe(0);
    expect(mtimes[res.added[i]]).toBe(r.lastModified);
  }

  // A bookmark: the small screenshot still gets a real thumbnail file, because a .url can't be shown.
  const shot = join(env.src, 'shot.png');
  makeImage(shot, '-size 300x150 gradient:red-blue', 'png');
  const mark = await env.importer.importBookmark(
    'https://example.com/page',
    'Example Page',
    { thumbnailPng: readFileSync(shot) },
    ctx,
  );
  expect(mark.failed).toEqual([]);
  const m = env.recordOf(mark.added[0]);
  expect(m).toMatchObject({
    ext: 'url',
    name: 'Example Page',
    url: 'https://example.com/page',
    width: 300,
    height: 150,
  });
  expect(m.noThumbnail).toBeUndefined();
  expect(m.noPreview).toBeUndefined();
  const mThumb = join(env.lib.itemDir(mark.added[0]), 'Example Page_thumbnail.png');
  expect(readFileSync(mThumb).subarray(8, 12).toString()).toBe('WEBP');
  expect(m.palettes?.length).toBeGreaterThan(0);

  // A file type nothing can preview becomes an icon-only item, not a failure.
  const odd = join(env.src, 'notes.xyz');
  writeFileSync(odd, 'just some text');
  const other = await env.importer.importPaths([odd], {}, ctx);
  expect(other.failed).toEqual([]);
  expect(env.recordOf(other.added[0])).toMatchObject({ ext: 'xyz', noPreview: true });
  expect(other.warnings).toBeUndefined();

  // So does a "picture" that isn't one (Eagle does the same), but the import says so.
  const textJpg = join(env.src, 'broken.jpg');
  writeFileSync(textJpg, 'just some text, not a picture');
  const junkPng = join(env.src, 'junk.png');
  writeFileSync(junkPng, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
  const bad = await env.importer.importPaths([textJpg, junkPng], {}, ctx);
  expect(bad.failed).toEqual([]);
  expect(bad.added.map((id) => env.recordOf(id).noPreview)).toEqual([true, true]);
  expect(bad.warnings?.map((w) => w.source).sort()).toEqual([textJpg, junkPng].sort());
  expect(bad.warnings?.[0].reason).toBe(
    "Couldn't read it as a picture, so it was added as an icon only.",
  );
});

it('finds a duplicate saved under another spelling of its type (jfif/jpg, tif/tiff)', async () => {
  const jpg = join(env.src, 'photo.jpg');
  makeImage(jpg, '-size 120x90 gradient:red-blue');
  const jfif = join(env.src, 'same photo.jfif');
  writeFileSync(jfif, readFileSync(jpg));
  const tif = join(env.src, 'scan.tif');
  makeImage(tif, '-size 64x64 gradient:blue-green');
  const tiff = join(env.src, 'same scan.tiff');
  writeFileSync(tiff, readFileSync(tif));

  const first = await env.importer.importPaths([jpg, tif], {}, ctx);
  expect(first.added).toHaveLength(2);
  const again = await env.importer.importPaths([jfif, tiff], { onDuplicate: 'skip' }, ctx);
  expect(again.added).toEqual([]);
  expect(again.duplicates.map((d) => d.existingId).sort()).toEqual([...first.added].sort());
});
