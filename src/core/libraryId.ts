import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { LibraryRef } from '../shared/types';

/** Our cache key for a library: first 16 hex of sha256 of its real path. */
export function libraryRef(path: string): LibraryRef {
  let real = resolve(path);
  try {
    real = realpathSync(real);
  } catch {
    /* not created yet */
  }
  const id = createHash('sha256').update(real).digest('hex').slice(0, 16);
  return { id, path: real, name: basename(real).replace(/\.library$/i, '') };
}
