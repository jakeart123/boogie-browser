import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sniffExt, sniffHeader } from './sniff';
import { FIXTURE_DIR, makeImage, writeZip } from './testFixtures';

const ascii = (s: string) => Buffer.from(s, 'latin1');
const ext = (bytes: Buffer) => sniffHeader(bytes);

describe('sniffHeader', () => {
  it('recognises the common signatures by content', () => {
    expect(ext(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toBe('jpg');
    expect(
      ext(
        Buffer.concat([
          Buffer.from([0x89]),
          ascii('PNG\r\n'),
          Buffer.from([0x1a, 0x0a, 0, 0, 0, 13]),
        ]),
      ),
    ).toBe('png');
    expect(ext(Buffer.concat([ascii('RIFF'), Buffer.alloc(4), ascii('WEBPVP8 ')]))).toBe('webp');
    expect(ext(Buffer.concat([ascii('8BPS'), Buffer.from([0, 1])]))).toBe('psd');
    expect(ext(Buffer.concat([ascii('8BPS'), Buffer.from([0, 2])]))).toBe('psb');
    expect(ext(ascii('%PDF-1.7\n'))).toBe('pdf');
    expect(ext(ascii('II*\0\x08\0\0\0'))).toBe('tif');
  });

  it('tells ISO media brands apart', () => {
    const ftyp = (major: string, ...compat: string[]) =>
      Buffer.concat([
        Buffer.from([0, 0, 0, 16 + compat.length * 4]),
        ascii('ftyp' + major),
        Buffer.alloc(4),
        ...compat.map(ascii),
      ]);
    expect(ext(ftyp('heic', 'mif1'))).toBe('heic');
    expect(ext(ftyp('mif1', 'avif'))).toBe('avif');
    expect(ext(ftyp('qt  '))).toBe('mov');
    expect(ext(ftyp('M4A '))).toBe('m4a');
    expect(ext(ftyp('isom', 'mp42'))).toBe('mp4');
  });

  it('finds svg after an xml prolog, but not inside an html page', () => {
    expect(
      ext(ascii('<?xml version="1.0"?>\n<!-- x -->\n<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBe('svg');
    expect(ext(ascii('<svg width="1"/>'))).toBe('svg');
    expect(ext(ascii('<!DOCTYPE html><html><body><svg/></body></html>'))).toBeNull();
  });

  it('does not take a random two-byte match for a format', () => {
    expect(ext(Buffer.from('BM is not a bitmap here, just text'))).toBeNull();
    expect(ext(Buffer.alloc(64))).toBeNull();
  });
});

describe('sniffExt (files)', () => {
  const dir = join(FIXTURE_DIR, 'sniff');
  mkdirSync(dir, { recursive: true });

  it('only the seven image types Eagle sniffs override the name; the rest keep their ext', async () => {
    const png = makeImage('sniff-real.png', 40, 30);
    const jpg = makeImage('sniff-real.jpg', 40, 30);
    const copy = (from: string, name: string) => {
      copyFileSync(from, join(dir, name));
      return join(dir, name);
    };
    expect(await sniffExt(copy(png, 'really-a-png.jpg'))).toBe('png');
    expect(await sniffExt(copy(jpg, 'photo.JPEG'))).toBe('jpg');
    expect(await sniffExt(copy(jpg, 'photo.jfif'))).toBe('jfif'); // Eagle keeps jfif
    expect(await sniffExt(copy(png, 'no-extension'))).toBe('png'); // temp downloads: content decides

    // Unknown content keeps the declared name as it is (Eagle stores .jpeg and .tiff as such).
    writeFileSync(join(dir, 'x.jpeg'), 'not an image');
    expect(await sniffExt(join(dir, 'x.jpeg'))).toBe('jpeg');
    expect(await sniffExt(copy(makeImage('sniff-real.tif', 40, 30), 'scan.TIFF'))).toBe('tiff');

    // Containers never become their container type: Procreate, Office and USDZ files are zips,
    // a .dng is a TIFF, a .psdt is a PSD, a .ps is PostScript.
    const zip = writeZip(join(dir, 'z.zip'), [{ name: 'a.xml', data: Buffer.from('<a/>') }]);
    for (const name of ['art.procreate', 'deck.potx', 'model.usdz', 'macro.xlsm', 'paint.kra'])
      expect(await sniffExt(copy(zip, name))).toBe(name.split('.')[1]);
    expect(await sniffExt(copy(join(dir, 'scan.TIFF'), 'raw.dng'))).toBe('dng');
    writeFileSync(join(dir, 'x.psdt'), Buffer.concat([ascii('8BPS'), Buffer.from([0, 1])]));
    expect(await sniffExt(join(dir, 'x.psdt'))).toBe('psdt');
    writeFileSync(join(dir, 'x.ps'), '%!PS-Adobe-3.0\n');
    expect(await sniffExt(join(dir, 'x.ps'))).toBe('ps');
  });

  // Research/library-survey: one Art Archive .tif is really a WebP. Read-only.
  const AA_TIF = resolve(
    'research/sandbox/templates/art-archive.library/images/LPCWF9IUL3E30.info',
  );
  it.skipIf(!existsSync(AA_TIF))(
    'the Art Archive .tif that is really WebP comes back as webp',
    async () => {
      const file = readdirSync(AA_TIF).find((f) => f.endsWith('.tif'))!;
      expect(await sniffExt(join(AA_TIF, file))).toBe('webp');
    },
  );
});
