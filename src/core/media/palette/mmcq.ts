// Eagle's color palette, reproduced from research/format-notes/thumbs-palette-import.md
// section 2. It is the public MMCQ (modified median cut) quantizer with Eagle's changes:
// 12 colors requested, 5 cuts per phase, alpha below 170 skipped, a sampling stride that
// depends on buffer size, and the original MMCQ "else if" bounds quirk. The quirks change the
// output, so they stay.
//
// Pure: takes decoded RGBA pixels, needs no vips, so it is unit-testable on its own.

import type { Palette } from '../../../shared/types';

const SIGBITS = 5;
const RSHIFT = 8 - SIGBITS;
const MAX_ITERATIONS = 5;
const FRACT_BY_POPULATION = 0.75;
const REQUESTED_COLORS = 12;
const ALPHA_THRESHOLD = 170;
/** Index into the 32768-bin histogram: r<<10 | g<<5 | b. */
const STRIDE = [1 << (2 * SIGBITS), 1 << SIGBITS, 1];

class VBox {
  count_ = -1;
  constructor(
    readonly lo: number[],
    readonly hi: number[],
    readonly histo: Int32Array,
  ) {}

  copy(): VBox {
    return new VBox([...this.lo], [...this.hi], this.histo);
  }

  volume(): number {
    return (
      (this.hi[0] - this.lo[0] + 1) * (this.hi[1] - this.lo[1] + 1) * (this.hi[2] - this.lo[2] + 1)
    );
  }

  count(): number {
    if (this.count_ < 0) {
      let n = 0;
      for (let r = this.lo[0]; r <= this.hi[0]; r++)
        for (let g = this.lo[1]; g <= this.hi[1]; g++)
          for (let b = this.lo[2]; b <= this.hi[2]; b++) n += this.histo[(r << 10) + (g << 5) + b];
      this.count_ = n;
    }
    return this.count_;
  }

  /** Weighted mean of the bin centers, truncated; an empty box uses its geometric center. */
  avg(): [number, number, number] {
    const mult = 1 << RSHIFT;
    let total = 0;
    let rs = 0;
    let gs = 0;
    let bs = 0;
    for (let r = this.lo[0]; r <= this.hi[0]; r++)
      for (let g = this.lo[1]; g <= this.hi[1]; g++)
        for (let b = this.lo[2]; b <= this.hi[2]; b++) {
          const h = this.histo[(r << 10) + (g << 5) + b];
          total += h;
          rs += h * (r + 0.5) * mult;
          gs += h * (g + 0.5) * mult;
          bs += h * (b + 0.5) * mult;
        }
    if (total) return [Math.trunc(rs / total), Math.trunc(gs / total), Math.trunc(bs / total)];
    return [
      Math.trunc((mult * (this.lo[0] + this.hi[0] + 1)) / 2),
      Math.trunc((mult * (this.lo[1] + this.hi[1] + 1)) / 2),
      Math.trunc((mult * (this.lo[2] + this.hi[2] + 1)) / 2),
    ];
  }
}

/**
 * The original's queue: an array that is re-sorted (stable, ascending) only when something was
 * pushed since the last sort, and pops from the end. Tie order depends on this, so it is kept.
 */
class Queue {
  private items: VBox[] = [];
  private sorted = false;
  constructor(private readonly key: (b: VBox) => number) {}
  push(b: VBox): void {
    this.items.push(b);
    this.sorted = false;
  }
  pop(): VBox {
    if (!this.sorted) {
      this.items.sort((a, b) => cmp(this.key(a), this.key(b)));
      this.sorted = true;
    }
    return this.items.pop()!;
  }
  size(): number {
    return this.items.length;
  }
}

function cmp(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Split a box along its widest axis at the population median. */
function medianCut(histo: Int32Array, box: VBox): VBox[] | undefined {
  if (!box.count()) return undefined;
  if (box.count() === 1) return [box.copy()];

  const width = [0, 1, 2].map((a) => box.hi[a] - box.lo[a] + 1);
  const maxw = Math.max(...width);
  const axis = maxw === width[0] ? 0 : maxw === width[1] ? 1 : 2;
  const [a1, a2] = [0, 1, 2].filter((a) => a !== axis);

  // Cumulative pixel count per slice along the axis. Outside [lo, hi] a sum reads as 0, which
  // is what the original's sparse array gave (undefined, tested for falsiness).
  const start = box.lo[axis];
  const end = box.hi[axis];
  const partial = new Array<number>(end - start + 1).fill(0);
  let total = 0;
  for (let i = start; i <= end; i++) {
    let sum = 0;
    for (let x = box.lo[a1]; x <= box.hi[a1]; x++)
      for (let y = box.lo[a2]; y <= box.hi[a2]; y++)
        sum += histo[i * STRIDE[axis] + x * STRIDE[a1] + y * STRIDE[a2]];
    total += sum;
    partial[i - start] = total;
  }
  const ps = (i: number) => (i >= start && i <= end ? partial[i - start] : 0);
  const ahead = (i: number) => total - ps(i);

  for (let i = start; i <= end; i++) {
    if (ps(i) <= total / 2) continue;
    const left = i - start;
    const right = end - i;
    let d2 =
      left <= right
        ? Math.min(end - 1, Math.trunc(i + right / 2))
        : Math.max(start, Math.trunc(i - 1 - left / 2));
    // Avoid empty boxes.
    while (!ps(d2)) d2++;
    let count2 = ahead(d2);
    while (!count2 && ps(d2 - 1)) count2 = ahead(--d2);
    const box1 = box.copy();
    const box2 = box.copy();
    box1.hi[axis] = d2;
    box2.lo[axis] = d2 + 1;
    return [box1, box2];
  }
  return undefined;
}

/** Cut boxes off `queue` until `target` colors or MAX_ITERATIONS iterations. */
function iterate(queue: Queue, histo: Int32Array, target: number): void {
  let colors = 1;
  let iterations = 0;
  while (iterations < MAX_ITERATIONS) {
    const box = queue.pop();
    if (!box.count()) {
      queue.push(box);
      iterations++;
      continue;
    }
    const parts = medianCut(histo, box);
    if (!parts || !parts[0]) return;
    queue.push(parts[0]);
    if (parts[1]) {
      queue.push(parts[1]);
      colors++;
    }
    if (colors >= target) return;
    iterations++;
  }
}

interface Quantized {
  colors: { color: [number, number, number]; count: number }[];
  pixelCount: number;
}

function quantize(
  rgba: Uint8Array,
  length: number,
  skip: number,
  maxColors: number,
): Quantized | null {
  const histo = new Int32Array(1 << (3 * SIGBITS));
  // min starts at 31 and max at 0; each value is tested against min first and only then, in an
  // "else if", against max. Faithful to the original, including the case where a sample that
  // lowers min never raises max.
  const lo = [31, 31, 31];
  const hi = [0, 0, 0];
  let pixelCount = 0;
  for (let p = 0; p < length; p += 4 * skip) {
    if (rgba[p + 3] < ALPHA_THRESHOLD) continue;
    const r = rgba[p] >> RSHIFT;
    const g = rgba[p + 1] >> RSHIFT;
    const b = rgba[p + 2] >> RSHIFT;
    histo[(r << 10) + (g << 5) + b]++;
    pixelCount++;
    const v = [r, g, b];
    for (let a = 0; a < 3; a++) {
      if (v[a] < lo[a]) lo[a] = v[a];
      else if (v[a] > hi[a]) hi[a] = v[a];
    }
  }
  if (pixelCount === 0) return null;

  // Phase 1: split by population.
  const byCount = new Queue((b) => b.count());
  byCount.push(new VBox(lo, hi, histo));
  iterate(byCount, histo, FRACT_BY_POPULATION * maxColors);

  // Phase 2: re-queue by population times volume, split some more.
  const byVolume = new Queue((b) => b.count() * b.volume());
  while (byCount.size()) byVolume.push(byCount.pop());
  iterate(byVolume, histo, maxColors - byVolume.size());

  // Emit in pop order (largest first).
  const colors: Quantized['colors'] = [];
  while (byVolume.size()) {
    const box = byVolume.pop();
    colors.push({ color: box.avg(), count: box.count() });
  }
  return { colors, pixelCount };
}

/**
 * Eagle's palette for decoded RGBA pixels (8 bits per channel, not premultiplied).
 * `rgba` is the image at its analysis size: width min(w, 360) (see palette.ts). May return [];
 * callers write no `palettes` key for an empty result.
 */
export function mmcqPalette(rgba: Uint8Array, width: number, height: number): Palette[] {
  const length = Math.min(rgba.length, width * height * 4);
  // Sample every Nth pixel, N chosen by buffer size.
  const skip =
    length < 1e5 ? 1 : length < 1e6 ? 10 : length < 1e7 ? 100 : length < 1e8 ? 1000 : 10000;
  const q = quantize(rgba, length, skip, REQUESTED_COLORS);
  if (!q) return [];

  let colors = q.colors.map((c) => {
    // Rounded half up to 2 decimals; from 5 up it is truncated to a whole number (71.8 -> 71).
    let ratio = Math.round((c.count / q.pixelCount) * 100 * 100) / 100;
    if (ratio >= 5) ratio = Math.trunc(ratio);
    return { color: c.color, ratio };
  });
  colors = colors.filter((c) => c.ratio >= 0.25);
  colors.sort((a, b) => b.ratio - a.ratio); // stable
  if (colors.length > 4) {
    // Keep 5; a 6th needs more than 0.1, the 7th on need more than 0.3.
    colors = colors.filter((c, i) => i < 5 || (i < 6 ? c.ratio > 0.1 : c.ratio > 0.3));
  }
  return colors.slice(0, 12).map((c) => ({ color: c.color, ratio: c.ratio }));
}
