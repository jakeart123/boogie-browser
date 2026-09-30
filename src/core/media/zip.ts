// A tiny read-only zip reader. Used for Krita files (.kra is a zip whose `mergedimage.png` is
// the flattened picture): to read their size and render a preview. No zip64, no encryption;
// anything odd returns null and the caller falls back.

import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { constants as zc, createInflateRaw, inflateRawSync } from 'node:zlib';

type FileHandle = Awaited<ReturnType<typeof open>>;

interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  offset: number;
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MAX_CENTRAL_DIR = 16 * 1024 * 1024;

async function centralDirectory(fh: FileHandle, size: number): Promise<ZipEntry[] | null> {
  // The end-of-central-directory record is in the last 22 bytes + comment (at most 64 KiB).
  const tailLen = Math.min(size, 22 + 0xffff);
  const tail = Buffer.alloc(tailLen);
  await fh.read(tail, 0, tailLen, size - tailLen);
  let e = tailLen - 22;
  while (e >= 0 && tail.readUInt32LE(e) !== EOCD_SIG) e--;
  if (e < 0) return null;
  const cdSize = tail.readUInt32LE(e + 12);
  const cdOffset = tail.readUInt32LE(e + 16);
  if (
    cdOffset === 0xffffffff ||
    cdSize === 0xffffffff ||
    cdSize > MAX_CENTRAL_DIR ||
    cdOffset + cdSize > size
  )
    return null;

  const cd = Buffer.alloc(cdSize);
  await fh.read(cd, 0, cdSize, cdOffset);
  const entries: ZipEntry[] = [];
  let p = 0;
  while (p + 46 <= cdSize && cd.readUInt32LE(p) === CD_SIG) {
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    entries.push({
      name: cd.toString('utf8', p + 46, p + 46 + nameLen),
      method: cd.readUInt16LE(p + 10),
      compSize: cd.readUInt32LE(p + 20),
      offset: cd.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function findEntry(
  fh: FileHandle,
  name: string,
): Promise<{ entry: ZipEntry; dataStart: number } | null> {
  const entry = (await centralDirectory(fh, (await fh.stat()).size))?.find((x) => x.name === name);
  if (!entry || (entry.method !== 0 && entry.method !== 8)) return null; // stored or deflated only
  const local = Buffer.alloc(30);
  await fh.read(local, 0, 30, entry.offset);
  if (local.readUInt32LE(0) !== LOCAL_SIG) return null;
  return { entry, dataStart: entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28) };
}

/**
 * The start of one entry, uncompressed, from at most `maxCompressed` bytes of its data. Enough
 * to read a PNG's size from its header without inflating a huge picture.
 */
export async function readZipEntry(
  path: string,
  name: string,
  maxCompressed = 64 * 1024,
): Promise<Buffer | null> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(path, 'r');
    const found = await findEntry(fh, name);
    if (!found) return null;
    const data = Buffer.alloc(Math.min(found.entry.compSize, maxCompressed));
    const { bytesRead } = await fh.read(data, 0, data.length, found.dataStart);
    const raw = data.subarray(0, bytesRead);
    if (found.entry.method === 0) return raw;
    // A cut-off deflate stream is fine here: we only want what it has produced so far.
    return inflateRawSync(raw, { finishFlush: zc.Z_SYNC_FLUSH, maxOutputLength: 8 * 1024 * 1024 });
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/** Unpack one entry to `dest`, streaming (a Krita picture can be tens of megabytes). */
export async function extractZipEntry(path: string, name: string, dest: string): Promise<boolean> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(path, 'r');
    const found = await findEntry(fh, name);
    if (!found) return false;
    const { entry, dataStart } = found;
    const source = createReadStream(path, {
      start: dataStart,
      end: dataStart + entry.compSize - 1,
    });
    if (entry.method === 8) await pipeline(source, createInflateRaw(), createWriteStream(dest));
    else await pipeline(source, createWriteStream(dest));
    return true;
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}
