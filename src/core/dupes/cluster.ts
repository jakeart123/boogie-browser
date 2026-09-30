// Near-duplicate clustering over 64-bit perceptual hashes (16 hex chars each).
//
// Comparing every pair is O(n^2). Pigeonhole avoids it: split each hash into 8 bytes. Two
// hashes within Hamming distance <= 7 differ in at most 7 bits, so at most 7 of the 8 bytes
// differ and at least one byte is identical at the same position. Bucket by (position, byte),
// verify the real distance only inside a bucket, and union what matches.

export const MAX_THRESHOLD = 7; // the largest distance pigeonhole over 8 bytes can guarantee

const HEX16 = /^[0-9a-f]{16}$/i;

export function isDhash(s: unknown): s is string {
  return typeof s === 'string' && HEX16.test(s);
}

function popcount32(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

/** Hamming distance between two 16-char hex hashes. */
export function hamming(a: string, b: string): number {
  const hi = (parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16)) >>> 0;
  const lo = (parseInt(a.slice(8), 16) ^ parseInt(b.slice(8), 16)) >>> 0;
  return popcount32(hi) + popcount32(lo);
}

/**
 * Cluster hashes whose distance is <= threshold (single linkage). Returns groups of indexes into
 * `hashes`; only groups of two or more are returned. Identical hashes always cluster (distance
 * 0). Every entry must be a valid 16-char hex string (see `isDhash`).
 */
export function clusterHashes(hashes: string[], threshold: number): number[][] {
  const run = clusterSteps(hashes, threshold);
  for (;;) {
    const step = run.next();
    if (step.done) return step.value;
  }
}

/**
 * clusterHashes for the main thread: the same answer, worked out in slices of about `sliceMs`
 * with the event loop running in between (85k hashes take ~0.7 s). Stops on `signal`.
 */
export async function clusterHashesInSlices(
  hashes: string[],
  threshold: number,
  signal?: AbortSignal,
  sliceMs = 12,
): Promise<number[][]> {
  const run = clusterSteps(hashes, threshold);
  let sliceStart = performance.now();
  for (;;) {
    const step = run.next();
    if (step.done) return step.value;
    if (performance.now() - sliceStart < sliceMs) continue;
    await new Promise<void>((resolve) => setImmediate(resolve));
    signal?.throwIfAborted();
    sliceStart = performance.now();
  }
}

/** The clustering, pausing (yield) after every bucket so a caller can slice the work. */
function* clusterSteps(hashes: string[], threshold: number): Generator<void, number[][]> {
  const t = Math.max(0, Math.min(MAX_THRESHOLD, Math.floor(threshold)));

  // Identical hashes collapse into one node so a pile of blank images doesn't make a huge bucket.
  const nodeOf = new Map<string, number>();
  const members: number[][] = [];
  hashes.forEach((h, i) => {
    const key = h.toLowerCase();
    let n = nodeOf.get(key);
    if (n === undefined) {
      n = members.length;
      nodeOf.set(key, n);
      members.push([]);
    }
    members[n].push(i);
  });

  const n = members.length;
  const keys = [...nodeOf.keys()];
  const hi = new Uint32Array(n);
  const lo = new Uint32Array(n);
  const bytes = new Uint8Array(n * 8);
  for (let i = 0; i < n; i++) {
    hi[i] = parseInt(keys[i].slice(0, 8), 16) >>> 0;
    lo[i] = parseInt(keys[i].slice(8), 16) >>> 0;
    for (let p = 0; p < 8; p++) bytes[i * 8 + p] = parseInt(keys[i].slice(p * 2, p * 2 + 2), 16);
  }

  const parent = new Int32Array(n).map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };

  for (let p = 0; p < 8; p++) {
    const buckets: number[][] = Array.from({ length: 256 }, () => []);
    for (let i = 0; i < n; i++) buckets[bytes[i * 8 + p]].push(i);
    for (const list of buckets) {
      for (let a = 0; a < list.length; a++) {
        const i = list[a];
        const hiI = hi[i];
        const loI = lo[i];
        const ri = find(i);
        for (let b = a + 1; b < list.length; b++) {
          const j = list[b];
          if (popcount32((hiI ^ hi[j]) >>> 0) + popcount32((loI ^ lo[j]) >>> 0) > t) continue;
          const rj = find(j);
          if (rj !== ri) parent[rj] = ri; // ri stays a root: only other roots are attached to it
        }
        if ((a & 255) === 255) yield; // one crowded bucket can hold thousands of hashes
      }
      yield;
    }
  }

  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const list = byRoot.get(r);
    if (list) list.push(...members[i]);
    else byRoot.set(r, [...members[i]]);
  }
  return [...byRoot.values()].filter((g) => g.length >= 2).map((g) => g.sort((x, y) => x - y));
}
