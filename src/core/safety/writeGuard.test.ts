import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertWritable,
  isWritable,
  setAllowProtectedWrites,
  setWritableRoots,
} from './writeGuard';

const tmp = resolve('.tmp/writeguard-test');

describe('writeGuard', () => {
  afterEach(() => {
    setWritableRoots([]);
    setAllowProtectedWrites(false);
  });

  it('blocks everything when no roots are set', () => {
    setWritableRoots([]);
    expect(isWritable(join(tmp, 'x.json'))).toBe(false);
  });

  it('allows paths inside a root, including not-yet-existing ones', () => {
    setWritableRoots([tmp]);
    expect(isWritable(join(tmp, 'a.library/images/X.info/metadata.json'))).toBe(true);
    expect(isWritable(resolve(tmp, '..', 'elsewhere'))).toBe(false);
  });

  it('keeps Dropbox blocked even if a root covers it', () => {
    setWritableRoots([homedir()]);
    expect(() =>
      assertWritable(join(homedir(), 'Dropbox/Art Archive/Art Archive.library/mtime.json')),
    ).toThrow(/protected/);
  });

  it('keeps a Dropbox folder anywhere blocked (its .dropbox marker file), but not a .dropbox folder', () => {
    const box = join(tmp, 'Work Dropbox');
    mkdirSync(join(box, 'Libs'), { recursive: true });
    writeFileSync(join(box, '.dropbox'), '{}');
    const notBox = join(tmp, 'home-like');
    mkdirSync(join(notBox, '.dropbox'), { recursive: true });
    setWritableRoots([tmp]);
    expect(isWritable(join(box, 'Libs/A.library/mtime.json'))).toBe(false);
    expect(isWritable(join(notBox, 'B.library/mtime.json'))).toBe(true);
  });

  it('the protected-writes setting opens protected places inside a root, and only those', () => {
    const box = join(tmp, 'Team Dropbox');
    mkdirSync(box, { recursive: true });
    writeFileSync(join(box, '.dropbox'), '{}');
    const inHomeDropbox = join(homedir(), 'Dropbox/Shared/A.library/mtime.json');
    const inMarkedDropbox = join(box, 'B.library/mtime.json');
    const plain = join(tmp, 'plain/C.library/mtime.json');
    setWritableRoots([tmp, join(homedir(), 'Dropbox')]);

    expect([inHomeDropbox, inMarkedDropbox, plain].map(isWritable)).toEqual([false, false, true]);
    setAllowProtectedWrites(true);
    expect([inHomeDropbox, inMarkedDropbox, plain].map(isWritable)).toEqual([true, true, true]);
    // Still only inside the roots: a drive nobody allowed stays blocked.
    expect(isWritable('/run/media/someone/Drive/D.library/mtime.json')).toBe(false);
    setAllowProtectedWrites(false);
    expect(() => assertWritable(inMarkedDropbox)).toThrow(/protected/);
    expect(isWritable(plain)).toBe(true);
  });

  it('follows symlinks out of a root', () => {
    mkdirSync(tmp, { recursive: true });
    const link = join(tmp, 'sneaky');
    try {
      symlinkSync(join(homedir(), 'Dropbox'), link);
    } catch {
      /* exists from a previous run */
    }
    setWritableRoots([tmp, homedir()]);
    expect(isWritable(join(link, 'x'))).toBe(false);
  });
});
