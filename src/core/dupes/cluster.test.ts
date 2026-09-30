import { describe, expect, it } from 'vitest';
import { clusterHashes, clusterHashesInSlices, hamming, MAX_THRESHOLD } from './cluster';

// Deterministic pseudo-random so a failure reproduces.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const hex = (bits: bigint) => bits.toString(16).padStart(16, '0');

function bruteForce(hashes: string[], t: number): number[][] {
  const parent = hashes.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let i = 0; i < hashes.length; i++)
    for (let j = i + 1; j < hashes.length; j++)
      if (hamming(hashes[i], hashes[j]) <= t) parent[find(i)] = find(j);
  const groups = new Map<number, number[]>();
  hashes.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));
  return [...groups.values()].filter((g) => g.length > 1);
}

const normalize = (groups: number[][]) =>
  groups.map((g) => [...g].sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);

describe('clusterHashes', () => {
  it('measures hamming distance', () => {
    expect(hamming('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hamming('00000000000000ff', '0000000000000000')).toBe(8);
    expect(hamming('8000000000000001', '0000000000000000')).toBe(2);
  });

  it('gives the same clusters as comparing every pair, including planted near-duplicates', async () => {
    const rand = rng(42);
    const random64 = () =>
      (BigInt(Math.floor(rand() * 2 ** 32)) << 32n) | BigInt(Math.floor(rand() * 2 ** 32));
    const hashes: string[] = [];
    for (let i = 0; i < 300; i++) {
      const base = random64();
      hashes.push(hex(base));
      // Some get siblings 1..9 bits away (past 7 must stay separate), some get an exact copy.
      const flips = Math.floor(rand() * 10);
      if (rand() < 0.5) {
        let v = base;
        const used = new Set<number>();
        while (used.size < flips) used.add(Math.floor(rand() * 64));
        for (const b of used) v ^= 1n << BigInt(b);
        hashes.push(hex(v));
      }
      if (rand() < 0.1) hashes.push(hex(base));
    }
    // Worst case for the byte buckets: 7 flips, one in each of 7 bytes, so exactly one byte matches.
    for (let i = 0; i < 100; i++) {
      const base = random64();
      const keep = Math.floor(rand() * 8);
      let v = base;
      for (let byte = 0; byte < 8; byte++)
        if (byte !== keep) v ^= 1n << BigInt(byte * 8 + Math.floor(rand() * 8));
      hashes.push(hex(base), hex(v));
    }
    for (const t of [0, 3, 6, 7]) {
      expect(normalize(clusterHashes(hashes, t)), `threshold ${t}`).toEqual(
        normalize(bruteForce(hashes, t)),
      );
    }
    // The sliced version (tiny slices, so it really yields) gives the same answer.
    expect(normalize(await clusterHashesInSlices(hashes, 6, undefined, 0))).toEqual(
      normalize(clusterHashes(hashes, 6)),
    );
  });

  it('caps the threshold at 7 and folds identical hashes into one cluster', () => {
    const a = '00000000000000ff'; // 8 bits from zero: out of reach even when asked for more
    expect(clusterHashes(['0000000000000000', a], 20)).toEqual([]);
    expect(MAX_THRESHOLD).toBe(7);
    expect(clusterHashes([a, a, a], 0)).toEqual([[0, 1, 2]]);
    expect(clusterHashes(['0123456789abcdef', '0123456789ABCDEF'], 0)).toEqual([[0, 1]]);
  });
});
