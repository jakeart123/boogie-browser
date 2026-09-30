// Picture bytes for get_thumbnail: Eagle's own thumbnail when it is small and in a format agents
// can read, otherwise a shrunk JPEG made with the system vipsthumbnail.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Item } from '../../shared/types';
import type { Call } from './kit';
import { UserError } from './errors';

const MAX_IMAGE_BYTES = 1_000_000;

function sniffImageMime(b: Uint8Array): string | null {
  const ascii = (from: number, to: number) => Buffer.from(b.subarray(from, to)).toString('latin1');
  if (b.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (b.length > 8 && b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.length > 6 && ascii(0, 3) === 'GIF') return 'image/gif';
  return null;
}

const SENDABLE = new Set(['image/webp', 'image/png', 'image/jpeg', 'image/gif']);

function vipsShrink(src: string, out: string, edge: number, quality: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // Absolute output path plus [Q=..] makes vipsthumbnail write exactly one JPEG there.
    execFile(
      'vipsthumbnail',
      [src, '--size', `${edge}x${edge}`, '-o', `${out}[Q=${quality}]`],
      { timeout: 30_000 },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });
}

export async function thumbnailBytes(
  call: Call,
  libraryId: string,
  item: Item,
): Promise<{ data: Buffer; mime: string }> {
  // Only paths the core located inside the item's folder. Never item.filePath: it is built from
  // the record's name and ext, which a library can craft to point anywhere.
  const resolved =
    (await call.host.resolveFile('thumb', libraryId, item.id)) ??
    (await call.host.resolveFile('file', libraryId, item.id));
  const path = resolved?.path;
  if (!path)
    throw new UserError(
      `Item ${item.id} has no thumbnail or original file on disk that I can send.`,
    );

  const size = (await stat(path).catch(() => null))?.size;
  if (size === undefined)
    throw new UserError(
      `The thumbnail file for item ${item.id} is missing on disk. It may still be syncing.`,
    );

  if (size <= MAX_IMAGE_BYTES) {
    const data = await readFile(path);
    const mime = sniffImageMime(data);
    if (mime && SENDABLE.has(mime)) return { data, mime };
  }

  // Too big, or a format like TIFF/AVIF/PSD: shrink to a JPEG.
  await mkdir(call.host.paths.tmp, { recursive: true });
  const out = join(call.host.paths.tmp, `mcp-thumb-${randomBytes(6).toString('hex')}.jpg`);
  try {
    for (const [edge, quality] of [
      [1024, 80],
      [640, 70],
      [384, 60],
    ] as const) {
      try {
        await vipsShrink(path, out, edge, quality);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT')
          throw new UserError(
            'The vipsthumbnail tool is not installed, so large pictures cannot be shrunk.',
          );
        throw new UserError(
          `No picture can be made for this ${item.ext || 'file'} item (${item.id}). Use get_item for its details instead.`,
        );
      }
      const data = await readFile(out);
      if (data.length <= MAX_IMAGE_BYTES) return { data, mime: 'image/jpeg' };
    }
    throw new UserError('The picture is still over 1 MB after shrinking it.');
  } finally {
    await unlink(out).catch(() => {});
  }
}
