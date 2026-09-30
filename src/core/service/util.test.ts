import { describe, expect, it } from 'vitest';
import { Mutex } from './util';

const tick = () => new Promise((r) => setTimeout(r, 1));

describe('the session lock', () => {
  it('lets queued work through when a long run steps aside, and keeps undo out of the middle of it', async () => {
    const lock = new Mutex();
    const log: string[] = [];
    const long = lock.run(async (step) => {
      for (let i = 0; i < 3; i++) {
        log.push(`long ${i}`);
        await tick();
        await step();
      }
    });
    await tick();
    const edit = lock.run(async () => void log.push('edit'));
    const undo = lock.exclusive(async () => void log.push('undo'));
    await Promise.all([long, edit, undo]);
    // The edit got in between chunks; undo waited until the long run was completely done.
    expect(log.indexOf('edit')).toBeLessThan(log.indexOf('long 2'));
    expect(log.at(-1)).toBe('undo');
  });

  it('runs one at a time in order, and a failure does not jam it', async () => {
    const lock = new Mutex();
    const log: number[] = [];
    const a = lock.run(async () => {
      await tick();
      log.push(1);
      throw new Error('boom');
    });
    const b = lock.run(async () => void log.push(2));
    await expect(a).rejects.toThrow('boom');
    await b;
    await lock.idle();
    expect(log).toEqual([1, 2]);
  });
});
