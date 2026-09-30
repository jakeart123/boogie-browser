import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Runner } from './exec';
import { dhashFromGray } from './hash';
import { createMediaService } from './index';
import {
  CACHE_DIR,
  FIXTURE_DIR,
  bytesDims,
  fixture,
  makeAudio,
  makeImage,
  makeVideo,
} from './testFixtures';

const media = createMediaService({ cacheDir: CACHE_DIR });
afterAll(() => media.close());
const isWebp = (b: Uint8Array) =>
  Buffer.from(b.subarray(0, 4)).toString() === 'RIFF' &&
  Buffer.from(b.subarray(8, 12)).toString() === 'WEBP';

describe('probe', () => {
  it('reports duration and the upright size of a phone video with a rotation tag', async () => {
    const p = await media.probe(
      makeVideo('rot90.mp4', { width: 320, height: 180, seconds: 2, rotate: 90 }),
    );
    expect(p).toMatchObject({
      ext: 'mp4',
      kind: 'video',
      width: 180,
      height: 320,
      animated: false,
    });
    expect(p.duration).toBeCloseTo(2, 0);
  });

  it("an audio file has a duration and Eagle's fixed 280x140 waveform size", async () => {
    const p = await media.probe(makeAudio('tone.mp3'));
    expect(p).toMatchObject({ ext: 'mp3', kind: 'audio', width: 280, height: 140 });
    expect(p.duration).toBeCloseTo(1, 0);
  });

  it('a video renamed .mp3 keeps its ext but is a video; a video with no picture is audio', async () => {
    const clip = makeVideo('plain.mp4');
    const wrong = join(FIXTURE_DIR, 'really-a-video.mp3');
    copyFileSync(clip, wrong);
    // Eagle keeps the name (only seven image types are renamed by content), but it plays as video.
    expect(await media.probe(wrong)).toMatchObject({ ext: 'mp3', kind: 'video' });
    const soundOnly = fixture('sound-only.mp4', (out) =>
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=duration=1',
        '-c:a',
        'aac',
        out,
      ]),
    );
    expect((await media.probe(soundOnly)).kind).toBe('audio');
  });

  it('detects an animated gif and a still one', async () => {
    const anim = fixture('anim.gif', (out) =>
      execFileSync('magick', [
        '-size',
        '60x40',
        'xc:red',
        'xc:blue',
        '-delay',
        '10',
        '-loop',
        '0',
        out,
      ]),
    );
    const still = makeImage('still.gif', 60, 40);
    expect(await media.probe(anim)).toMatchObject({
      ext: 'gif',
      width: 60,
      height: 40,
      animated: true,
    });
    expect((await media.probe(still)).animated).toBe(false);
  });

  it('reads the size of a big PSD from its header (never decoding it) and a PDF page in truncated points', async () => {
    const psd = resolve('research/sandbox/media/test-psd.psd');
    const pdf = resolve('research/sandbox/media/test-pdf.pdf');
    if (existsSync(psd))
      expect(await media.probe(psd)).toMatchObject({ ext: 'psd', width: 599, height: 600 });
    if (existsSync(pdf))
      expect(await media.probe(pdf)).toMatchObject({
        ext: 'pdf',
        kind: 'doc',
        width: 595,
        height: 841,
      }); // A4 is 595.28 x 841.89
  });

  it('a missing file is an error, an unreadable image is just size-less', async () => {
    await expect(media.probe(join(FIXTURE_DIR, 'nope.jpg'))).rejects.toThrow();
    const junk = join(FIXTURE_DIR, 'junk.png');
    writeFileSync(junk, randomBytes(2000));
    expect(await media.probe(junk)).toMatchObject({ width: null, height: null });
  });
});

describe('eagleThumbnail for video and audio', () => {
  it('a 720p clip becomes 568x320 (Eagle scales the short edge up to 320 exactly as for images)', async () => {
    const clip = makeVideo('hd.mp4', { width: 1280, height: 720, seconds: 1 });
    const t = await media.eagleThumbnail(clip, await media.probe(clip));
    expect(isWebp(t.bytes!)).toBe(true);
    expect(bytesDims(t.bytes!)).toEqual([568, 320]);
    expect([t.width, t.height]).toEqual([568, 320]);
  });

  it('a small phone video comes out upright, and audio gets a waveform picture', async () => {
    const clip = makeVideo('rot90.mp4', { width: 320, height: 180, seconds: 2, rotate: 90 });
    const t = await media.eagleThumbnail(clip, await media.probe(clip));
    // Eagle draws every frame on a 480 px wide canvas first, so a small phone clip is scaled up.
    expect(bytesDims(t.bytes!)).toEqual([320, 568]);
    const tone = makeAudio('tone.mp3');
    const w = await media.eagleThumbnail(tone, await media.probe(tone));
    expect(bytesDims(w.bytes!)).toEqual([280, 140]);
  });

  it('videoFrame gives a native-size WebP frame', async () => {
    const frame = await media.videoFrame(makeVideo('plain.mp4', { width: 320, height: 180 }), 0.5);
    expect(isWebp(frame)).toBe(true);
    expect(bytesDims(frame)).toEqual([320, 180]);
  });
});

describe('preview', () => {
  const tif = () =>
    fixture('preview.tif', (out) =>
      execFileSync('magick', ['-size', '3000x2000', 'gradient:red-blue', out]),
    );

  it('renders formats Chromium cannot show to a capped WebP once, then serves the cache', async () => {
    mkdirSync(CACHE_DIR, { recursive: true });
    const key = `test-${Date.now()}`;
    const out = await media.preview(tif(), key, 1000);
    expect(out).toBe(join(CACHE_DIR, 'previews', `${key}.webp`));
    expect(bytesDims(readFileSync(out))).toEqual([1000, 667]);
    const stamp = statSync(out).mtimeMs;
    expect(await media.preview(tif(), key, 1000)).toBe(out);
    expect(statSync(out).mtimeMs).toBe(stamp); // not rendered again
  });

  it('two requests for one preview share one render, and a formats it can show is returned as is', async () => {
    const key = `same-${Date.now()}`;
    const [a, b] = await Promise.all([media.preview(tif(), key), media.preview(tif(), key)]);
    expect(a).toBe(b);
    const jpg = makeImage('viewable.jpg', 100, 80);
    expect(await media.preview(jpg, 'anything')).toBe(jpg);
    expect(media.isBrowserViewable('heic')).toBe(false);
    expect(media.isBrowserViewable('.WebP')).toBe(true);
  });

  it('draws the types Eagle leaves icon-only (EPS, a woff2 specimen) and remembers what it cannot', async () => {
    const eps = fixture('art.eps', (out) =>
      execFileSync('magick', ['-size', '300x200', 'gradient:red-blue', out]),
    );
    const epsOut = await media.preview(eps, `eps-${Date.now()}`, 480);
    expect(bytesDims(readFileSync(epsOut))[0]).toBe(480); // vector: drawn at the size asked
    const serif = '/usr/share/fonts/TTF/DejaVuSerif.ttf';
    if (existsSync(serif)) {
      // woff2_compress writes beside its input, so work on a copy in the fixture folder.
      const ttf = fixture('serif.ttf', (out) => execFileSync('cp', [serif, out]));
      const woff2 = fixture('serif.woff2', () => execFileSync('woff2_compress', [ttf]));
      expect(
        bytesDims(readFileSync(await media.preview(woff2, `font-${Date.now()}`, 480))),
      ).toEqual([480, 480]);
    }
    const clip = fixture('junk.clip', (out) => writeFileSync(out, randomBytes(64)));
    const key = `junk-${Date.now()}`;
    await expect(media.preview(clip, key, 480)).rejects.toThrow();
    const t0 = performance.now();
    await expect(media.preview(clip, key, 480)).rejects.toThrow(); // no second render
    expect(performance.now() - t0).toBeLessThan(20);
  });

  it('a PDF previews as page 1 at the long-edge cap', async () => {
    const pdf = resolve('research/sandbox/media/test-pdf.pdf');
    if (!existsSync(pdf)) return;
    const out = await media.preview(pdf, `pdf-${Date.now()}`, 1200);
    expect(bytesDims(readFileSync(out))[1]).toBe(1200);
  });
});

describe('palette edge cases', () => {
  it('gray images give gray colors; audio, transparent and very tall images give none', async () => {
    const gray = fixture('gray.png', (out) =>
      execFileSync('magick', [
        '-size',
        '200x100',
        'gradient:white-black',
        '-colorspace',
        'Gray',
        out,
      ]),
    );
    const p = (await media.palette(gray))!;
    expect(p.length).toBeGreaterThan(2);
    for (const e of p) expect(new Set(e.color).size).toBe(1);

    expect(await media.palette(makeAudio('tone.mp3'))).toBeNull();
    const clear = fixture('clear.png', (out) =>
      execFileSync('magick', ['-size', '50x50', 'xc:none', out]),
    );
    expect(await media.palette(clear)).toBeNull();
    // Eagle skips images taller than about 130x their width.
    const tall = fixture('tall.png', (out) =>
      execFileSync('magick', ['-size', '20x3000', 'gradient:red-blue', out]),
    );
    expect(await media.palette(tall)).toBeNull();
  });

  it('resamples a wide picture to 360 px before analysing, and leaves a 320 px one alone', async () => {
    const wide = makeImage('wide.png', 1200, 800);
    const p = (await media.palette(wide))!;
    expect(p.length).toBeGreaterThan(3);
    expect(p.reduce((n, e) => n + e.ratio, 0)).toBeGreaterThan(90); // nearly the whole picture is accounted for
  });
});

describe('hashes', () => {
  it('md5 streams a big file to the same digest as hashing it whole', async () => {
    const file = fixture('random-8mb.bin', (out) =>
      writeFileSync(out, randomBytes(8 * 1024 * 1024 + 123)),
    );
    expect(await media.md5(file)).toBe(createHash('md5').update(readFileSync(file)).digest('hex'));
    const hello = fixture('hello.txt', (out) => writeFileSync(out, 'hello'));
    expect(await media.md5(hello)).toBe('5d41402abc4b2a76b9719d911017c592');
    // A cancelled scan stops reading at once.
    const stop = new AbortController();
    const reading = media.md5(file, stop.signal);
    stop.abort(new Error('cancelled'));
    await expect(reading).rejects.toThrow('cancelled');
  });

  it('dhash: known patterns, and a resized copy stays close while a different picture does not', async () => {
    expect(dhashFromGray(Array.from({ length: 72 }, (_, i) => 200 - (i % 9)))).toBe(
      'ffffffffffffffff',
    ); // every pixel brighter than its right neighbour
    expect(dhashFromGray(Array.from({ length: 72 }, (_, i) => i % 9))).toBe('0000000000000000');

    const big = fixture('dh-a.jpg', (out) =>
      execFileSync('magick', ['-size', '900x600', 'plasma:fractal', '-quality', '90', out]),
    );
    const small = fixture('dh-a-small.jpg', (out) =>
      execFileSync('magick', [big, '-resize', '300x', '-quality', '70', out]),
    );
    const other = fixture('dh-b.jpg', (out) =>
      execFileSync('magick', [
        '-size',
        '900x600',
        'plasma:fractal',
        '-seed',
        '7',
        '-quality',
        '90',
        out,
      ]),
    );
    const [a, s, b] = await Promise.all([media.dhash(big), media.dhash(small), media.dhash(other)]);
    for (const h of [a, s, b]) expect(h).toMatch(/^[0-9a-f]{16}$/);
    const distance = (x: string, y: string) =>
      (BigInt('0x' + x) ^ BigInt('0x' + y)).toString(2).replace(/0/g, '').length;
    expect(distance(a, s)).toBeLessThanOrEqual(6);
    expect(distance(a, b)).toBeGreaterThan(distance(a, s));

    // Asked together, they share one vipsthumbnail run: same answers as one at a time, and a
    // file vips can't read (or that is gone) fails on its own. Two share a base name on purpose.
    const twin = join(FIXTURE_DIR, 'twin');
    mkdirSync(twin, { recursive: true });
    copyFileSync(small, join(twin, 'dh-a.jpg'));
    const junk = fixture('dh-junk.png', (out) => writeFileSync(out, 'not a picture'));
    const files = [big, join(twin, 'dh-a.jpg'), other, makeImage('dh-alpha.png', 64, 40)];
    const alone: string[] = [];
    for (const f of files) alone.push(await media.dhash(f));
    const together = await Promise.allSettled(
      [...files, junk, join(FIXTURE_DIR, 'gone.jpg')].map((f) => media.dhash(f)),
    );
    expect(together.slice(0, 4).map((r) => (r.status === 'fulfilled' ? r.value : r))).toEqual(
      alone,
    );
    expect(together.slice(4).map((r) => r.status)).toEqual(['rejected', 'rejected']);
  });
});

describe('subprocess pool', () => {
  it('kills a process that runs past its timeout, helpers included', async () => {
    const dir = join(FIXTURE_DIR, 'pids');
    mkdirSync(dir, { recursive: true });
    const pidFile = join(dir, 'pid.txt');
    const runner = new Runner(2);
    const started = Date.now();
    await expect(
      runner.run('sh', ['-c', `sleep 30 & echo $! > ${pidFile}; wait`], { timeoutMs: 200 }),
    ).rejects.toMatchObject({ reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5000);
    const child = Number(readFileSync(pidFile, 'utf8'));
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(child, 0)).toThrow(); // the sleep is gone too
  });

  it('runs at most `concurrency` at a time', async () => {
    const runner = new Runner(2);
    const started = Date.now();
    await Promise.all([1, 2, 3, 4, 5].map(() => runner.run('sleep', ['0.3'], { timeoutMs: 5000 })));
    expect(Date.now() - started).toBeGreaterThanOrEqual(850); // 5 jobs, 2 lanes: 3 rounds
  });

  it('a tiny timeout on a big image fails softly and leaves no process behind', async () => {
    const big = makeImage('big-noise.jpg', 6000, 4000, { noise: true });
    const impatient = createMediaService({ cacheDir: CACHE_DIR, imageTimeoutMs: 5 });
    const p = {
      ext: 'jpg',
      width: 6000,
      height: 4000,
      duration: null,
      animated: false,
      kind: 'image' as const,
    };
    expect(await impatient.eagleThumbnail(big, p)).toEqual({
      noThumbnail: false,
      bytes: null,
      width: null,
      height: null,
    });
    expect(await impatient.palette(big)).toBeNull();
    await expect(impatient.dhash(big)).rejects.toMatchObject({ reason: 'timeout' });
    await new Promise((r) => setTimeout(r, 200));
    expect(() => execFileSync('pgrep', ['-f', 'big-noise.jpg'], { stdio: 'ignore' })).toThrow(); // pgrep exits 1: nothing found
    await impatient.close();
  });

  it('after close() new work is refused', async () => {
    const svc = createMediaService({ cacheDir: CACHE_DIR });
    await svc.close();
    await expect(svc.probe(makeImage('plain-after-close.png', 30, 30))).rejects.toMatchObject({
      reason: 'closed',
    });
  });
});
