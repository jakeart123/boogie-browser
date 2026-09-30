// Tiny helpers shared by the service files.

export const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function unique<T>(list: readonly T[]): T[] {
  return [...new Set(list)];
}

/** "1 item", "3 items". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Run `fn` over `items` with at most `limit` in flight. Results keep the input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Runs one async function at a time, in the order they were asked for. A long run can step aside
 * between chunks (the `step` it is handed) so queued work isn't frozen behind it for a minute.
 * `exclusive` runs only when no run is part-way through: undo and close must never land in the
 * middle of another action.
 */
export class Mutex {
  private held = false;
  private queue: (() => void)[] = [];
  /** Runs that stepped aside and haven't finished yet. */
  private partway = 0;
  private settledWaiters: (() => void)[] = [];

  private acquire(): Promise<void> {
    if (!this.held) {
      this.held = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.held = false;
  }

  async run<T>(fn: (step: () => Promise<void>) => Promise<T>): Promise<T> {
    await this.acquire();
    let steppedAside = false;
    const step = async () => {
      if (!this.queue.length) return; // nobody is waiting
      if (!steppedAside) {
        steppedAside = true;
        this.partway++;
      }
      const turn = new Promise<void>((resolve) => this.queue.push(resolve));
      this.release(); // the first waiter goes; we are back at the end of the line
      await turn;
    };
    try {
      return await fn(step);
    } finally {
      if (steppedAside && --this.partway === 0)
        for (const wake of this.settledWaiters.splice(0)) wake();
      this.release();
    }
  }

  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    for (;;) {
      if (this.partway) await new Promise<void>((resolve) => this.settledWaiters.push(resolve));
      let ran = false;
      let out: T | undefined;
      await this.run(async () => {
        if (this.partway) return; // someone stepped aside to let us in: let them finish first
        ran = true;
        out = await fn();
      });
      if (ran) return out as T;
    }
  }

  /** Resolves once everything queued so far has finished. */
  idle(): Promise<void> {
    return this.exclusive(async () => undefined);
  }
}

export interface Throttled<A extends unknown[]> {
  (...args: A): void;
  /** Run a pending call now. */
  flush(): void;
  cancel(): void;
}

/** At most one call per `ms`; the latest arguments are never dropped (trailing call). */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number): Throttled<A> {
  let last = 0;
  let timer: NodeJS.Timeout | undefined;
  let pending: A | null = null;
  const fire = (args: A) => {
    last = Date.now();
    pending = null;
    fn(...args);
  };
  const throttled = ((...args: A) => {
    const wait = last + ms - Date.now();
    if (wait <= 0) {
      clearTimeout(timer);
      timer = undefined;
      fire(args);
      return;
    }
    pending = args;
    timer ??= setTimeout(() => {
      timer = undefined;
      if (pending) fire(pending);
    }, wait).unref();
  }) as Throttled<A>;
  throttled.flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (pending) fire(pending);
  };
  throttled.cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    pending = null;
  };
  return throttled;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
