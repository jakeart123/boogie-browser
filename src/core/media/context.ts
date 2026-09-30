// What every media job needs: the subprocess pool, the cache dir and the timeouts.

import type { Runner } from './exec';

export interface MediaContext {
  runner: Runner;
  /** Where previews and scratch files go (never inside a library). */
  cacheDir: string;
  imageTimeoutMs: number;
  videoTimeoutMs: number;
  /** Previews being rendered right now, by output path. */
  previewJobs: Map<string, Promise<string>>;
  /** Previews that failed to render (output path -> why), so a grid of them doesn't keep retrying. */
  previewFailures: Map<string, string>;
}
