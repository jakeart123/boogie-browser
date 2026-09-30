import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findMount, verifyPlan } from './storage';
import type { Session } from './types';

const scratch = resolve(import.meta.dirname, '../../../.tmp/service/storage');

function fakeSession(name: string, over: Partial<Session>): Session {
  const root = join(scratch, `${name}.library`);
  mkdirSync(join(root, 'images'), { recursive: true });
  writeFileSync(join(root, 'mtime.json'), '{}');
  const meta = new Map<string, string>();
  return {
    ref: { id: name, path: root, name },
    lib: { root },
    index: {
      getMeta: (key: string) => meta.get(key) ?? null,
      setMeta: (key: string, value: string | null) =>
        value === null ? meta.delete(key) : meta.set(key, value),
    },
    shared: false,
    readOnly: false,
    closed: false,
    ...over,
  } as unknown as Session;
}

const touch = (p: string, secondsAgo: number) => {
  const t = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(p, t, t);
};

describe('the pass after an open, by where the library lives', () => {
  it('a shared (Dropbox) library gets both passes on every open', async () => {
    const s = fakeSession('shared', { shared: true, readOnly: true });
    for (let i = 0; i < 2; i++) {
      const plan = await verifyPlan(s, {});
      expect(plan).toMatchObject({ statPass: true, conflictScan: true });
      plan.finished();
    }
  });

  it('a read-only library (Master on its drive) re-checks only after mtime.json or images/ changed', async () => {
    const s = fakeSession('protected', { readOnly: true });
    const root = s.lib.root;
    touch(join(root, 'images'), 600);
    touch(join(root, 'mtime.json'), 600);

    const first = await verifyPlan(s, {});
    expect(first).toMatchObject({ statPass: true, conflictScan: false });
    first.finished();
    expect((await verifyPlan(s, {})).statPass).toBe(false); // nothing changed since

    touch(join(root, 'images'), 60); // an item folder came or went
    const second = await verifyPlan(s, {});
    expect(second.statPass).toBe(true);
    second.finished();
    expect((await verifyPlan(s, {})).statPass).toBe(false);

    writeFileSync(join(root, 'mtime.json'), '{"X":1}'); // an Eagle wrote
    expect((await verifyPlan(s, {})).statPass).toBe(true);

    // A reload the user asked for always does everything.
    expect(await verifyPlan(s, { pauseMs: 0 })).toMatchObject({
      statPass: true,
      conflictScan: true,
    });
  });
});

describe('findMount', () => {
  it('picks the longest mount point holding the path, with escaped spaces', () => {
    const info = [
      '32 2 0:29 /@ / rw,relatime shared:1 - btrfs /dev/mapper/root rw',
      '508 29 8:2 / /run/media/user/My\\040Drive rw,nosuid shared:640 - exfat /dev/sda2 rw',
      '255 32 259:1 / /mnt/data rw,noatime shared:219 - ntfs3 /dev/nvme0n1p1 rw',
    ].join('\n');
    expect(findMount(info, '/run/media/user/My Drive/Art.library')).toMatchObject({
      point: '/run/media/user/My Drive',
      device: '8:2',
      fstype: 'exfat',
    });
    expect(findMount(info, '/home/user/Dropbox/x.library')?.fstype).toBe('btrfs');
    expect(findMount(info, '/mnt/dataX/a')?.fstype).toBe('btrfs'); // a prefix is not a parent
  });
});
