// Where a library lives decides how much background checking it needs. One profile per library:
//   slow    a spinning disk, USB/removable drive or network share (listing 85k folders or
//           stat'ing 85k files takes minutes there, not seconds);
//   shared  synced with a partner through Dropbox: conflicted copies appear, and a partner's edit
//           can land without its mtime.json raise (Dropbox has no order);
//   readOnly  Boogie doesn't write it while open (a protected place like Master on its drive,
//           or opened read-only): only an outside program can change it.
// From it, the pass after every open (external.ts startVerify) runs:
//   conflicted-copy scan of every item folder: shared libraries only (nothing else makes them);
//   stat pass (re-read items whose metadata.json changed without mtime.json saying so): every
//     open for a shared library (the sync safety relies on it) or a writable one on a fast disk
//     (cheap there); otherwise only when mtime.json or images/ changed since the last full pass
//     (an Eagle writing always touches mtime.json), or once a day.
// A reload the user asks for (host.refresh full: startVerify with pauseMs 0) always runs both.
import { readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Session } from './types';

export interface StorageProfile {
  slow: boolean;
  shared: boolean;
  readOnly: boolean;
}

export interface VerifyPlan {
  statPass: boolean;
  conflictScan: boolean;
  /** Call when the stat pass finished (not stopped): the next opens can skip it while nothing changes. */
  finished(): void;
}

/** A skipped stat pass runs anyway once this long has passed since the last full one. */
const STAT_PASS_AT_LEAST_EVERY_MS = 24 * 3600_000;
const NETWORK_FS =
  /^(nfs4?|cifs|smb3?|smbfs|9p|afs|ceph|glusterfs|davfs|fuse\.(sshfs|rclone|s3fs|davfs2?))$/;

export async function storageProfile(s: Session): Promise<StorageProfile> {
  return {
    slow: await isSlowStorage(s.ref.path),
    shared: s.shared,
    readOnly: s.readOnly,
  };
}

/** What the pass after this open should do. `pauseMs: 0` is host.refresh's full reload: everything. */
export async function verifyPlan(s: Session, opts: { pauseMs?: number }): Promise<VerifyPlan> {
  const noop = () => undefined;
  if (opts.pauseMs === 0) return { statPass: true, conflictScan: true, finished: noop };
  const profile = await storageProfile(s);
  const conflictScan = profile.shared;
  if (profile.shared || (!profile.slow && !profile.readOnly))
    return { statPass: true, conflictScan, finished: noop };

  // Stamps taken before the pass: anything that changes during it makes the next open check again.
  const now = await verifyStamps(s);
  let last: { mtimeJson: string; images: string; at: number } | null = null;
  try {
    last = JSON.parse(s.index.getMeta?.('verify_stamp') ?? 'null');
  } catch {
    /* unreadable bookkeeping: check */
  }
  const startedAt = Date.now();
  const unchanged =
    !!now &&
    !!last &&
    last.mtimeJson === now.mtimeJson &&
    last.images === now.images &&
    startedAt - last.at < STAT_PASS_AT_LEAST_EVERY_MS;
  return {
    statPass: !unchanged,
    conflictScan,
    finished: () => {
      if (!now || s.closed) return;
      try {
        s.index.setMeta?.('verify_stamp', JSON.stringify({ ...now, at: startedAt }));
      } catch {
        /* the index was closed meanwhile */
      }
    },
  };
}

async function verifyStamps(s: Session): Promise<{ mtimeJson: string; images: string } | null> {
  const stampOf = async (p: string) => {
    const st = await stat(p);
    return `${Math.trunc(st.mtimeMs)}:${st.size}`;
  };
  try {
    return {
      mtimeJson: await stampOf(join(s.lib.root, 'mtime.json')),
      images: await stampOf(join(s.lib.root, 'images')),
    };
  } catch {
    return null; // can't tell: run the pass
  }
}

// ───────────────────────── slow storage ─────────────────────────

const slowByDevice = new Map<string, boolean>();

/**
 * Is `path` on a spinning disk, a USB or removable drive, or a network share? From the mount
 * table and /sys (Linux). Unknown means fast: that only costs time, never a missed check.
 */
export async function isSlowStorage(path: string): Promise<boolean> {
  try {
    const real = await realpath(path);
    const mount = findMount(await readFile('/proc/self/mountinfo', 'utf8'), real);
    if (!mount) return false;
    if (NETWORK_FS.test(mount.fstype)) return true;
    const key = `${mount.device}:${mount.source}`;
    let slow = slowByDevice.get(key);
    if (slow === undefined) {
      slow = await blockDeviceIsSlow(mount.device, mount.source);
      slowByDevice.set(key, slow);
    }
    return slow;
  } catch {
    return false;
  }
}

interface Mount {
  point: string;
  device: string; // "major:minor"
  fstype: string;
  source: string;
}

/** The mount holding `path`: the longest mount point that is a prefix of it. */
export function findMount(mountinfo: string, path: string): Mount | null {
  const unescape = (s: string) =>
    s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  let best: Mount | null = null;
  for (const line of mountinfo.split('\n')) {
    const f = line.split(' ');
    const dash = f.indexOf('-');
    if (dash < 6 || f.length < dash + 3) continue;
    const point = unescape(f[4]);
    const inside = point === '/' || path === point || path.startsWith(point + '/');
    if (!inside || (best && best.point.length >= point.length)) continue;
    best = { point, device: f[2], fstype: f[dash + 1], source: unescape(f[dash + 2]) };
  }
  return best;
}

async function blockDeviceIsSlow(device: string, source: string): Promise<boolean> {
  let dev = device;
  // btrfs and friends report an anonymous device (0:x): use the block device they were mounted from.
  if (dev.startsWith('0:')) {
    if (!source.startsWith('/dev/')) return false; // tmpfs, overlay, ...
    const rdev = (await stat(source)).rdev;
    dev = `${Math.floor(rdev / 256) & 0xfff}:${(rdev & 0xff) | ((rdev >> 12) & 0xfff00)}`;
  }
  let sys = await realpath(`/sys/dev/block/${dev}`);
  const isPartition = await stat(join(sys, 'partition')).then(
    () => true,
    () => false,
  );
  if (isPartition) sys = join(sys, '..');
  if (sys.includes('/usb')) return true;
  const flag = async (file: string) =>
    (await readFile(join(sys, file), 'utf8').catch(() => '0')).trim() === '1';
  return (await flag('queue/rotational')) || (await flag('removable'));
}
