// Subprocess pool. Everything that decodes pixels (vips, ffmpeg, ffprobe, pdfinfo) runs here:
// at most `concurrency` at once, each with a timeout that kills the whole process group, and
// stdout collected as bytes. No decoding ever happens inside our own process.

import { spawn, type ChildProcess } from 'node:child_process';

export type RunFailure = 'timeout' | 'exit' | 'spawn' | 'too-big' | 'closed';

export class MediaError extends Error {
  constructor(
    message: string,
    readonly reason: RunFailure,
  ) {
    super(message);
    this.name = 'MediaError';
  }
}

export interface RunOptions {
  timeoutMs: number;
  /** Kill the process if it writes more than this to stdout (default 512 MiB). */
  maxStdout?: number;
}

export interface RunResult {
  stdout: Buffer;
  stderr: string;
}

/** libvips prints a harmless "unable to load vips-openslide.so" warning on every start. */
function cleanStderr(text: string): string {
  return text
    .split('\n')
    .filter((line) => line.trim() && !/openslide/i.test(line))
    .join('\n')
    .trim();
}

export class Runner {
  private running = 0;
  private waiting: (() => void)[] = [];
  private children = new Set<ChildProcess>();
  private closed = false;

  constructor(readonly concurrency: number) {}

  /** Run `cmd`; resolves with stdout on exit code 0, rejects with a MediaError otherwise. */
  async run(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
    await this.acquire();
    try {
      return await this.spawnOne(cmd, args, opts);
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.closed) return Promise.reject(new MediaError('media service is closed', 'closed'));
    if (this.running < this.concurrency) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.waiting.push(() => {
        if (this.closed) reject(new MediaError('media service is closed', 'closed'));
        else resolve();
      });
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next)
      next(); // hands the slot over
    else this.running--;
  }

  private spawnOne(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
    const maxStdout = opts.maxStdout ?? 512 * 1024 * 1024;
    return new Promise((resolve, reject) => {
      // A new process group, so a timeout also kills helpers the tool started (magick's
      // delegates, ffmpeg children).
      const child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        env: { ...process.env, VIPS_WARNING: '0' },
      });
      this.children.add(child);
      const out: Buffer[] = [];
      let outBytes = 0;
      let err = '';
      let failure: MediaError | null = null;

      const kill = (why: MediaError) => {
        failure ??= why;
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      const timer = setTimeout(
        () => kill(new MediaError(`${cmd} timed out after ${opts.timeoutMs} ms`, 'timeout')),
        opts.timeoutMs,
      );

      child.stdout!.on('data', (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > maxStdout) kill(new MediaError(`${cmd} output too big`, 'too-big'));
        else out.push(chunk);
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        if (err.length < 64 * 1024) err += chunk.toString('utf8');
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        this.children.delete(child);
        reject(new MediaError(`could not start ${cmd}: ${e.message}`, 'spawn'));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        this.children.delete(child);
        if (failure) return reject(failure);
        if (code !== 0) {
          const detail = cleanStderr(err);
          return reject(
            new MediaError(`${cmd} failed (exit ${code})${detail ? ': ' + detail : ''}`, 'exit'),
          );
        }
        resolve({ stdout: Buffer.concat(out), stderr: cleanStderr(err) });
      });
    });
  }

  /** Kill everything running and refuse new work. */
  async close(): Promise<void> {
    this.closed = true;
    for (const child of this.children) {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
    for (const w of this.waiting.splice(0)) w();
  }
}
