// Test helpers: small pictures and clips made with the system tools into .tmp/media/. Only
// tests import this.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

export const FIXTURE_DIR = resolve('.tmp/media/test');
export const CACHE_DIR = resolve('.tmp/media/test-cache');

const env = { ...process.env, VIPS_WARNING: '0' };

/** Make `name` in the fixture dir once (later runs reuse it) and return its path. */
export function fixture(name: string, make: (out: string) => void): string {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const out = join(FIXTURE_DIR, name);
  if (!existsSync(out)) make(out);
  return out;
}

/** A gradient (or, with `noise`, random pixels that don't compress) in any format ImageMagick writes. */
export function makeImage(
  name: string,
  width: number,
  height: number,
  opts: { noise?: boolean } = {},
): string {
  return fixture(name, (out) => {
    const src = opts.noise ? ['xc:', '+noise', 'Random'] : ['gradient:red-blue'];
    execFileSync(
      'magick',
      [
        '-size',
        `${width}x${height}`,
        ...src,
        ...(name.endsWith('.jpg') ? ['-quality', '90'] : []),
        out,
      ],
      { env },
    );
  });
}

/** A gradient JPEG with an EXIF orientation tag (1-8) spliced in after the JPEG start marker. */
export function makeJpegWithOrientation(
  name: string,
  width: number,
  height: number,
  orientation: number,
): string {
  return fixture(name, (out) => {
    const plain = makeImage(`plain-${name}`, width, height);
    const tiff = Buffer.concat([
      Buffer.from('MM\0*\0\0\0\b\0\x01', 'latin1'),
      Buffer.from([0x01, 0x12, 0x00, 0x03, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]),
    ]);
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    const segment = Buffer.concat([
      Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]),
      payload,
    ]);
    const jpeg = readFileSync(plain);
    writeFileSync(out, Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]));
  });
}

/** A short test clip with sound. `rotate` adds a display-rotation tag, like a phone video. */
export function makeVideo(
  name: string,
  opts: { width?: number; height?: number; seconds?: number; rotate?: number } = {},
): string {
  const { width = 320, height = 180, seconds = 2, rotate } = opts;
  return fixture(name, (out) => {
    const src = rotate ? `${out}.src.mp4` : out;
    execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc=size=${width}x${height}:rate=25:duration=${seconds}`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:duration=${seconds}`,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        src,
      ],
      { env },
    );
    if (rotate)
      execFileSync(
        'ffmpeg',
        ['-v', 'error', '-y', '-display_rotation', String(rotate), '-i', src, '-c', 'copy', out],
        { env },
      );
  });
}

export function makeAudio(name: string, seconds = 1): string {
  return fixture(name, (out) => {
    execFileSync(
      'ffmpeg',
      ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds}`, out],
      { env },
    );
  });
}

export const hasTool = (tool: string): boolean => {
  try {
    execFileSync('which', [tool], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/** Write a plain zip (no zip64). Entries are stored, or deflated when `deflate` is set. */
export function writeZip(
  out: string,
  entries: { name: string; data: Buffer; deflate?: boolean }[],
): string {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const body = e.deflate ? deflateRawSync(e.data) : e.data;
    const method = e.deflate ? 8 : 0;
    const name = Buffer.from(e.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(e.data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(method, 10);
    head.writeUInt32LE(crc32(e.data), 16);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(e.data.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(head, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(out, Buffer.concat([...parts, cd, end]));
  return out;
}

/** Width and height of image bytes (any format vips reads), via a scratch file. */
export function bytesDims(bytes: Uint8Array, ext = 'webp'): [number, number] {
  mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = join(CACHE_DIR, `dims-${process.pid}-${Math.random().toString(36).slice(2)}.${ext}`);
  writeFileSync(tmp, bytes);
  try {
    const out = execFileSync('vipsheader', ['-f', 'width', '-f', 'height', tmp], {
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.toString().trim().split('\n').map(Number) as [number, number];
  } finally {
    rmSync(tmp, { force: true });
  }
}
