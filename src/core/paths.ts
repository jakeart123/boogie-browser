// Where Boogie keeps its own files. Never inside a library.
// BOOGIE_HOME puts everything under one folder (tests and parallel agents use this so they
// don't share caches); otherwise XDG locations.
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AppPaths } from './contracts';

export function appPaths(env: NodeJS.ProcessEnv = process.env): AppPaths {
  const base = env.BOOGIE_HOME;
  if (base) {
    return {
      config: join(base, 'config'),
      cache: join(base, 'cache'),
      data: join(base, 'data'),
      tmp: join(base, 'cache', 'tmp'),
    };
  }
  const home = homedir();
  const config = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'boogie-browser');
  const cache = join(env.XDG_CACHE_HOME || join(home, '.cache'), 'boogie-browser');
  const data = join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'boogie-browser');
  return { config, cache, data, tmp: join(cache, 'tmp') };
}
