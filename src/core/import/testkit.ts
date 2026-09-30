// Test setup for the import tests. The Eagle adapter and the index are the real ones (on a copy of
// the sample library under .tmp/import); only media is a stand-in, because it shells out to
// vips/ffmpeg and these tests care about what import does with the answers, not the pixels.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EagleItemRecord, EagleRootRecord, Palette } from '../../shared/types';
import type {
  ChangeContext,
  EagleLibrary,
  EagleThumbResult,
  Importer,
  JournalSink,
  LibraryIndex,
  MediaService,
  NewItemInit,
  ProbeResult,
} from '../contracts';
import { eagleLibraries } from '../eagle';
import { indexes } from '../index';
import { createMediaService, type BoogieMediaService } from '../media';
import { setWritableRoots } from '../safety/writeGuard';
import { importers } from './importer';

const PROJECT = fileURLToPath(new URL('../../../', import.meta.url));
// The real library copy when it is here, else the generated one committed with the tests.
const REAL = join(PROJECT, 'research/sandbox/templates/sample.library');
export const TEMPLATE =
  !process.env.BOOGIE_TEST_FIXTURES && existsSync(REAL)
    ? REAL
    : join(PROJECT, 'test/fixtures/libraries/sample.library');

export const ctx: ChangeContext = {
  actor: { kind: 'user', name: 'You' },
  group: {
    id: 'g1',
    libraryId: 'lib',
    actor: { kind: 'user', name: 'You' },
    label: 'Imported',
    kind: 'import',
  },
};

// ───────────────────────── Stand-in media ─────────────────────────

/** Width and height read from a PNG, JPEG or GIF header. */
function imageSize(b: Buffer): { width: number; height: number } | null {
  if (b.subarray(0, 4).toString('hex') === '89504e47')
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.subarray(0, 3).toString() === 'GIF')
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xc0 || marker === 0xc2)
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

export class FakeMedia {
  paletteCalls: { path: string; head: string }[] = [];
  thumbCalls: { src: string; probe: ProbeResult }[] = [];
  /** Paths whose probe should blow up, to play "a bad file". */
  broken = new Set<string>();
  /** Slows thumbnails down so several files are in flight at once (to test races). */
  thumbDelayMs = 0;

  async probe(path: string): Promise<ProbeResult> {
    if (this.broken.has(path)) throw new Error('could not read this file');
    const buf = readFileSync(path);
    const size = imageSize(buf);
    const sniffed =
      buf[0] === 0x89
        ? 'png'
        : buf[0] === 0xff
          ? 'jpg'
          : buf.subarray(0, 3).toString() === 'GIF'
            ? 'gif'
            : null;
    const fromName = path.split('.').pop()!.toLowerCase();
    const ext = sniffed ?? (fromName === 'jpeg' ? 'jpg' : fromName);
    if (ext === 'mp4')
      return { ext, width: 640, height: 360, duration: 2.5, animated: false, kind: 'video' };
    const image = ['png', 'jpg', 'gif'].includes(ext);
    return {
      ext,
      width: size?.width ?? null,
      height: size?.height ?? null,
      duration: null,
      animated: false,
      kind: image ? 'image' : 'other',
    };
  }

  /** Eagle's small-image rule, roughly: small jpg/png need no thumbnail file; others get WebP bytes. */
  async eagleThumbnail(
    src: string,
    probe: ProbeResult,
    _size?: number,
    opts?: { force?: boolean },
  ): Promise<EagleThumbResult> {
    this.thumbCalls.push({ src, probe });
    if (this.thumbDelayMs) await new Promise((r) => setTimeout(r, this.thumbDelayMs));
    const small = (probe.width ?? 0) <= 960 && (probe.height ?? 0) <= 960;
    if ((probe.ext === 'jpg' || probe.ext === 'png') && small && !opts?.force)
      return { noThumbnail: true, bytes: null, width: null, height: null };
    if (probe.kind === 'other')
      return { noThumbnail: false, bytes: null, width: null, height: null };
    const bytes = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPfake')]);
    return { noThumbnail: false, bytes, width: 320, height: 240 };
  }

  async palette(path: string): Promise<Palette[] | null> {
    this.paletteCalls.push({ path, head: readFileSync(path).subarray(0, 12).toString('latin1') });
    return [{ color: [10, 20, 30], ratio: 100 }];
  }

  /** Every file md5 was asked to read, in order. */
  md5Calls: string[] = [];
  /** md5 never finishes until it is aborted (a huge file), to test cancelling. */
  md5Hangs = false;
  async md5(path: string, signal?: AbortSignal) {
    this.md5Calls.push(path);
    if (this.md5Hangs)
      await new Promise((_, reject) => {
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    return createHash('md5').update(readFileSync(path)).digest('hex');
  }

  async close() {}
}

// ───────────────────────── One test environment ─────────────────────────

/** What import asked the adapter to do, in order. */
export interface Spy {
  rootWrites: number;
  created: NewItemInit[];
  /** 'root' or 'item', in the order the writes happened. */
  events: string[];
}

export interface Env {
  dir: string;
  src: string; // where test source files live
  lib: EagleLibrary; // the real adapter, seen through a spy (reads pass straight through)
  spy: Spy;
  media: FakeMedia;
  index: LibraryIndex;
  tmpDir: string;
  importer: Importer;
  /** An importer for the same library opened read-only. */
  readOnlyImporter(): Promise<Importer>;
  /** Folder ids in the test library's root: Refs (auto-tag refs-auto) > Sub (auto-tag sub-auto). */
  folders: { refs: string; sub: string };
  recordOf(id: string): EagleItemRecord;
  /** mtime.json as it is on disk once the adapter's queued raises are flushed. */
  mtimeIndex(): Promise<Record<string, number>>;
  cleanup(): Promise<void>;
}

const journal = (dir: string): JournalSink => ({
  recordFile() {},
  recordMoveOut() {},
  storeDirFor: (libraryId) => join(dir, 'store', libraryId),
});

function spied(real: EagleLibrary, spy: Spy): EagleLibrary {
  return new Proxy(real, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (prop === 'updateRoot') {
        return async (...args: Parameters<EagleLibrary['updateRoot']>) => {
          const written = await target.updateRoot(...args);
          if (written) {
            spy.events.push('root'); // only real writes count
            spy.rootWrites++;
          }
          return written;
        };
      }
      if (prop === 'createItem') {
        return (init: NewItemInit, c: ChangeContext) => {
          spy.events.push('item');
          spy.created.push(init);
          return target.createItem(init, c);
        };
      }
      return value.bind(target);
    },
  });
}

/** A fresh copy of the sample library under .tmp/import, with two nested folders that carry auto-tags. */
export async function makeEnv(label: string): Promise<Env> {
  return build(label, () => new FakeMedia()) as Promise<Env>;
}

/** Same, but with the real media service (vips and ffmpeg subprocesses) instead of the stand-in. */
export async function makeRealEnv(
  label: string,
): Promise<Omit<Env, 'media'> & { media: BoogieMediaService }> {
  return build(label, (dir) => createMediaService({ cacheDir: join(dir, 'media') })) as never;
}

async function build(
  label: string,
  mediaFor: (dir: string) => FakeMedia | MediaService,
): Promise<Env> {
  const dir = join(PROJECT, '.tmp/import', `${label}-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const libPath = join(dir, 'lib.library');
  cpSync(TEMPLATE, libPath, { recursive: true, mode: constants.COPYFILE_FICLONE });
  setWritableRoots([dir]);

  const rootFile = join(libPath, 'metadata.json');
  const root = JSON.parse(readFileSync(rootFile, 'utf8')) as EagleRootRecord;
  const folder = (
    id: string,
    name: string,
    tags: string[],
    children: EagleRootRecord['folders'] = [],
  ) => ({
    id,
    name,
    description: '',
    children,
    modificationTime: 1,
    tags,
    password: '',
    passwordTips: '',
  });
  root.folders = [
    folder('REFS000000001', 'Refs', ['refs-auto'], [folder('SUB0000000002', 'Sub', ['sub-auto'])]),
  ];
  writeFileSync(rootFile, JSON.stringify(root));

  const src = join(dir, 'src');
  mkdirSync(src, { recursive: true });
  const open = (readOnly: boolean) =>
    eagleLibraries.open(libPath, { readOnly, journal: journal(dir), nameMaxChars: 150 });
  const real = await open(false);
  const index = indexes.open(
    { id: 'importtest', path: libPath, name: 'lib' },
    { dir: join(dir, 'index') },
  );
  await index.sync(real);

  const spy: Spy = { rootWrites: 0, created: [], events: [] };
  const media = mediaFor(dir) as FakeMedia & MediaService; // the two kinds share what import calls
  const tmpDir = join(dir, 'tmp');
  const make = (lib: EagleLibrary) =>
    importers.create({
      lib,
      index,
      media: media as unknown as MediaService,
      tmpDir,
      nameMaxChars: 150,
    });
  const lib = spied(real, spy);

  return {
    dir,
    src,
    lib,
    spy,
    media,
    index,
    tmpDir,
    importer: make(lib),
    readOnlyImporter: async () => make(await open(true)),
    folders: { refs: 'REFS000000001', sub: 'SUB0000000002' },
    recordOf: (id) =>
      JSON.parse(readFileSync(join(libPath, 'images', `${id}.info`, 'metadata.json'), 'utf8')),
    mtimeIndex: async () => {
      await real.flushMtime();
      return JSON.parse(readFileSync(join(libPath, 'mtime.json'), 'utf8'));
    },
    cleanup: async () => {
      await real.close();
      await media.close();
      index.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ───────────────────────── Test files ─────────────────────────

/** Small images made with ImageMagick (installed on this machine, per CLAUDE.md). */
export function makeImage(path: string, spec: string, format?: 'png' | 'jpg' | 'gif'): void {
  execFileSync('magick', [...spec.split(' '), format ? `${format}:${path}` : path]);
}
