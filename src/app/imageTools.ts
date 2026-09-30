// Turning odd image formats into PNG for the clipboard and the drag icon, using the system
// `vips` (the same tool the core uses; never sharp in this process). Plain Node (no electron import).
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Shrinks (never enlarges) an image to fit `maxEdge` and writes it as PNG. Throws if vips can't read it. */
export async function vipsToPng(src: string, out: string, maxEdge: number): Promise<void> {
  const edge = String(maxEdge);
  await run('vips', ['thumbnail', src, out, edge, '--height', edge, '--size', 'down'], {
    timeout: 60_000,
    env: { ...process.env, VIPS_WARNING: '0' }, // silences a harmless "openslide" plugin warning
  });
}

const MAX_CLIPBOARD_BYTES = 150_000_000;

/** Extensions that will never make a picture; skip the conversion attempt. */
const NOT_PICTURES = new Set([
  'mp4',
  'mov',
  'm4v',
  'webm',
  'mkv',
  'avi',
  'mp3',
  'wav',
  'flac',
  'ogg',
  'm4a',
  'ttf',
  'otf',
  'woff',
  'woff2',
  'zip',
  'txt',
]);

/**
 * PNG bytes for an original file, or null when it is not a picture. PNGs are used as they are;
 * everything else goes through vips, shrunk to 8192 px so a huge scan can't stall the copy.
 */
export async function pngBytesForFile(
  path: string,
  ext: string,
  tmpDir: string,
): Promise<Buffer<ArrayBuffer> | null> {
  const e = (ext || extname(path).slice(1)).toLowerCase();
  if (NOT_PICTURES.has(e)) return null;
  // A 900 MB PSD or a huge scan would stall Ctrl+C for a minute. The file still copies as a file.
  if ((await stat(path)).size > MAX_CLIPBOARD_BYTES) return null;
  if (e === 'png') return readFile(path);
  await mkdir(tmpDir, { recursive: true });
  const dir = await mkdtemp(join(tmpDir, 'png-'));
  try {
    const out = join(dir, 'out.png');
    await vipsToPng(path, out, 8192);
    return await readFile(out);
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Any image bytes (from the clipboard) to PNG bytes. */
export async function pngBytesFromBytes(
  bytes: Uint8Array,
  tmpDir: string,
): Promise<Buffer<ArrayBuffer> | null> {
  await mkdir(tmpDir, { recursive: true });
  const dir = await mkdtemp(join(tmpDir, 'clip-'));
  try {
    const src = join(dir, 'in');
    const out = join(dir, 'out.png');
    await writeFile(src, bytes);
    await vipsToPng(src, out, 16384);
    return await readFile(out);
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
