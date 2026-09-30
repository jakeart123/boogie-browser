// Pure layout math for the thumbnail grid. No DOM, no Svelte. Input: the aspect ratio of every
// item in display order. Output: typed arrays of tile boxes, so 85,000 items lay out in a few
// milliseconds and only the tiles in view ever become DOM.
//
// Every kind fills `y` in non-decreasing order (rows go down; masonry always places the next item
// in the currently shortest column, whose top is never above the previous placement). That one
// property lets a single binary search find the visible range for all four layouts.

export type LayoutKind = 'justified' | 'masonry' | 'grid' | 'list';

export interface LayoutOptions {
  kind: LayoutKind;
  /** Inner width of the scroll area in px (scrollbar excluded). */
  width: number;
  /** Row height (justified), column width (masonry), cell size (grid). Ignored by list. */
  thumbSize: number;
  gap?: number; // horizontal gap between tiles, whole px
  rowGap?: number; // vertical gap below each tile's caption
  padX?: number;
  padTop?: number;
  padBottom?: number;
  /** Px reserved under each thumbnail for the name and meta lines (0 when both are off). */
  captionH?: number;
  listRowH?: number;
}

export interface Layout {
  kind: LayoutKind;
  count: number;
  /** Thumbnail box of item i. The caption sits directly below it (captionH px). */
  x: Float64Array;
  y: Float64Array;
  w: Float64Array;
  h: Float64Array;
  captionH: number;
  /** Row index (justified, grid, list) or column index (masonry). */
  lane: Int32Array;
  /** Row r holds items rowStart[r] .. rowStart[r + 1] - 1. Empty for masonry. */
  rowStart: Int32Array;
  rows: number;
  cols: number;
  /** Tallest tile including its caption; the visible-range search needs it. */
  maxTileH: number;
  /** Full content height, padding included. */
  total: number;
}

/** Height reserved under a thumbnail for the name and meta lines. */
export function captionHeight(showNames: boolean, showMeta: boolean): number {
  return (showNames ? 24 : 0) + (showMeta ? (showNames ? 16 : 22) : 0);
}

export const MIN_ASPECT = 0.25;
export const MAX_ASPECT = 4;

/** Extreme aspects are clamped for layout only; the image itself is never distorted. */
export function clampAspect(a: number): number {
  if (!(a > 0)) return 1; // 0, negative, NaN, undefined
  return a < MIN_ASPECT ? MIN_ASPECT : a > MAX_ASPECT ? MAX_ASPECT : a;
}

export function computeLayout(aspects: ArrayLike<number>, o: LayoutOptions): Layout {
  const n = aspects.length;
  const gap = o.gap ?? 12;
  const rowGap = o.rowGap ?? 16;
  const padX = o.padX ?? 18;
  const padTop = o.padTop ?? 14;
  const padBottom = o.padBottom ?? 40;
  const captionH = o.kind === 'list' ? 0 : (o.captionH ?? 0);
  const availW = Math.max(1, Math.floor(o.width) - 2 * padX);
  const thumb = Math.max(20, o.thumbSize);

  const L: Layout = {
    kind: o.kind,
    count: n,
    x: new Float64Array(n),
    y: new Float64Array(n),
    w: new Float64Array(n),
    h: new Float64Array(n),
    captionH,
    lane: new Int32Array(n),
    rowStart: new Int32Array(0),
    rows: 0,
    cols: 1,
    maxTileH: 0,
    total: padTop + padBottom,
  };
  if (n === 0) return L;

  if (o.kind === 'masonry')
    masonry(L, aspects, availW, thumb, gap, rowGap, padX, padTop, padBottom);
  else if (o.kind === 'justified')
    justified(L, aspects, availW, thumb, gap, rowGap, padX, padTop, padBottom);
  else
    grid(
      L,
      availW,
      o.kind === 'list' ? 0 : thumb,
      gap,
      o.kind === 'list' ? 0 : rowGap,
      padX,
      padTop,
      padBottom,
      o.listRowH ?? 44,
    );
  return L;
}

function justified(
  L: Layout,
  aspects: ArrayLike<number>,
  availW: number,
  H: number,
  gap: number,
  rowGap: number,
  padX: number,
  padTop: number,
  padBottom: number,
): void {
  const n = L.count;
  const starts: number[] = [];
  let y0 = padTop;
  let i = 0;
  let maxTile = 0;
  while (i < n) {
    const row = starts.length;
    starts.push(i);
    // Grow the row until it is at least as wide as the container at the target height.
    let sumA = 0;
    let end = n;
    let fill = false;
    for (let j = i; j < n; j++) {
      const s = sumA + clampAspect(aspects[j]);
      const cnt = j - i + 1;
      if (s * H + gap * (cnt - 1) >= availW) {
        fill = true;
        end = j + 1;
        sumA = s;
        if (cnt > 1) {
          // Keep the overflowing item or push it to the next row: whichever leaves this row's
          // height closer to the target (compared as ratios, so 2x too tall = 2x too short).
          const hWith = (availW - gap * (cnt - 1)) / s;
          const hWithout = (availW - gap * (cnt - 2)) / (s - clampAspect(aspects[j]));
          if (Math.abs(Math.log(hWithout / H)) < Math.abs(Math.log(hWith / H))) {
            end = j;
            sumA = s - clampAspect(aspects[j]);
          }
        }
        break;
      }
      sumA = s;
    }
    const cnt = end - i;
    // The last row keeps the target height and is not stretched.
    const rowH = fill ? (availW - gap * (cnt - 1)) / sumA : H;
    const hPx = Math.max(1, Math.round(rowH));
    // Cumulative rounding: whole-pixel edges, every gap exactly `gap`, and the last tile of a
    // full row ends exactly at the right edge.
    let pos = 0;
    for (let k = i; k < end; k++) {
      const wExact = clampAspect(aspects[k]) * rowH;
      const left = Math.round(pos);
      const right = fill && k === end - 1 ? availW : Math.round(pos + wExact);
      L.x[k] = padX + left;
      L.w[k] = Math.max(1, right - left);
      L.y[k] = y0;
      L.h[k] = hPx;
      L.lane[k] = row;
      pos += wExact + gap;
    }
    if (hPx + L.captionH > maxTile) maxTile = hPx + L.captionH;
    y0 += hPx + L.captionH + rowGap;
    i = end;
  }
  starts.push(n);
  L.rowStart = Int32Array.from(starts);
  L.rows = starts.length - 1;
  L.maxTileH = maxTile;
  L.total = y0 - rowGap + padBottom;
}

function masonry(
  L: Layout,
  aspects: ArrayLike<number>,
  availW: number,
  colTarget: number,
  gap: number,
  rowGap: number,
  padX: number,
  padTop: number,
  padBottom: number,
): void {
  const n = L.count;
  const cols = Math.max(1, Math.floor(availW / colTarget));
  const colW = (availW - gap * (cols - 1)) / cols;
  const colX = new Float64Array(cols);
  const colWpx = new Float64Array(cols);
  for (let c = 0; c < cols; c++) {
    const left = Math.round(c * (colW + gap));
    colX[c] = padX + left;
    colWpx[c] = Math.max(1, Math.round((c + 1) * colW + c * gap) - left);
  }
  const colY = new Float64Array(cols).fill(padTop);
  let maxTile = 0;
  for (let i = 0; i < n; i++) {
    let c = 0;
    for (let k = 1; k < cols; k++) if (colY[k] < colY[c]) c = k;
    const hPx = Math.max(1, Math.round(colW / clampAspect(aspects[i])));
    L.x[i] = colX[c];
    L.w[i] = colWpx[c];
    L.y[i] = colY[c];
    L.h[i] = hPx;
    L.lane[i] = c;
    colY[c] += hPx + L.captionH + rowGap;
    if (hPx + L.captionH > maxTile) maxTile = hPx + L.captionH;
  }
  let bottom = 0;
  for (let c = 0; c < cols; c++) if (colY[c] > bottom) bottom = colY[c];
  L.cols = cols;
  L.maxTileH = maxTile;
  L.total = bottom - rowGap + padBottom;
}

/** Square cells (grid) or full-width fixed-height rows (list, `cell` = 0). */
function grid(
  L: Layout,
  availW: number,
  cell: number,
  gap: number,
  rowGap: number,
  padX: number,
  padTop: number,
  padBottom: number,
  listRowH: number,
): void {
  const n = L.count;
  const isList = cell === 0;
  const cols = isList ? 1 : Math.max(1, Math.floor((availW + gap) / (cell + gap)));
  // Stretch cells a little so the row fills the width; never smaller than the requested size.
  const size = isList ? listRowH : Math.floor((availW - gap * (cols - 1)) / cols);
  const w = isList ? availW : size;
  const pitch = size + L.captionH + rowGap;
  const rows = Math.ceil(n / cols);
  const starts = new Int32Array(rows + 1);
  for (let r = 0; r <= rows; r++) starts[r] = Math.min(n, r * cols);
  for (let i = 0; i < n; i++) {
    const r = (i / cols) | 0;
    const c = i - r * cols;
    L.x[i] = padX + c * (w + gap);
    L.y[i] = padTop + r * pitch;
    L.w[i] = w;
    L.h[i] = size;
    L.lane[i] = r;
  }
  L.rowStart = starts;
  L.rows = rows;
  L.cols = cols;
  L.maxTileH = size + L.captionH;
  L.total = padTop + rows * pitch - rowGap + padBottom;
}

// ───────────────────────── Queries on a layout ─────────────────────────

/** First index in y[0..n) with y >= v (y is non-decreasing). */
function lowerBound(y: Float64Array, n: number, v: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (y[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Items whose tile could touch the vertical band [top, bottom) (content coordinates), as the
 * index range [lo, hi). It may include a few items just above `top` (a tall tile that started
 * earlier), never misses one that is visible.
 */
export function visibleRange(L: Layout, top: number, bottom: number): { lo: number; hi: number } {
  if (L.count === 0) return { lo: 0, hi: 0 };
  return { lo: lowerBound(L.y, L.count, top - L.maxTileH), hi: lowerBound(L.y, L.count, bottom) };
}

/** Items whose tile overlaps the rectangle (content coordinates). */
export function itemsInRect(L: Layout, x0: number, y0: number, x1: number, y1: number): number[] {
  const out: number[] = [];
  const { lo, hi } = visibleRange(L, y0, y1);
  for (let i = lo; i < hi; i++) {
    if (L.x[i] < x1 && L.x[i] + L.w[i] > x0 && L.y[i] < y1 && L.y[i] + L.h[i] + L.captionH > y0)
      out.push(i);
  }
  return out;
}

// ───────────────────────── Very tall layouts ─────────────────────────

/**
 * Chromium can't make an element taller than 33,554,432 px (its layout unit limit), so a longer
 * grid (85k items in one column at the biggest zoom) would end early with its last items out of
 * reach. Above this height the spacer stops growing and the scroll position is scaled instead.
 */
export const MAX_SPACER_PX = 30_000_000;

/**
 * How the scroll position maps onto a layout. `above` px of other content (the subfolder strip,
 * the list header) scroll normally; below that, each scrolled px moves `k` layout px, so the
 * scroll range [0, above + spacerH - viewH] covers the layout's [0, above + total - viewH]
 * exactly and both ends stay reachable. `k` is 1 for any layout that fits.
 */
export interface TallScroll {
  spacerH: number;
  k: number;
  above: number;
}

export function tallScroll(
  total: number,
  above: number,
  viewH: number,
  cap = MAX_SPACER_PX,
): TallScroll {
  if (total <= cap || viewH >= cap) return { spacerH: total, k: 1, above };
  return { spacerH: cap, k: Math.max(1, (total - viewH) / (cap - viewH)), above };
}

/** The content position (layout px plus `above`) at the top of the view for a scrollTop. */
export function toContent(s: TallScroll, scrollTop: number): number {
  return scrollTop <= s.above ? scrollTop : s.above + (scrollTop - s.above) * s.k;
}

/** The scrollTop that puts content position `v` at the top of the view. */
export function toScrollTop(s: TallScroll, v: number): number {
  return v <= s.above ? v : s.above + (v - s.above) / s.k;
}

/** The tile visually one step up (dir -1) or down (dir 1) from item i; i itself at the edge. */
export function moveVertical(L: Layout, i: number, dir: 1 | -1): number {
  if (L.kind === 'masonry') {
    const lane = L.lane[i];
    for (let j = i + dir; j >= 0 && j < L.count; j += dir) if (L.lane[j] === lane) return j;
    return i;
  }
  const r = L.lane[i] + dir;
  if (r < 0 || r >= L.rows) return i;
  const cx = L.x[i] + L.w[i] / 2;
  let best = L.rowStart[r];
  let bestD = Infinity;
  for (let k = L.rowStart[r]; k < L.rowStart[r + 1]; k++) {
    const d = Math.abs(L.x[k] + L.w[k] / 2 - cx);
    if (d < bestD) ((best = k), (bestD = d));
  }
  return best;
}

/** Page up/down: step vertically as far as one viewport height allows (at least one step). */
export function movePage(L: Layout, i: number, dir: 1 | -1, viewH: number): number {
  let cur = i;
  for (let guard = 0; guard < 100000; guard++) {
    const next = moveVertical(L, cur, dir);
    if (next === cur) break;
    if (cur !== i && Math.abs(L.y[next] - L.y[i]) > viewH) break;
    cur = next;
  }
  return cur;
}

export interface DropTarget {
  /** Insert before the item at this index (count = at the end). */
  index: number;
  /** Where to draw the insertion bar (content coordinates). */
  bar: { x: number; y: number; w: number; h: number };
}

/** Where a dragged item would land if released at (px, py): nearest tile, before or after it. */
export function dropTarget(L: Layout, px: number, py: number, barSize = 3): DropTarget | null {
  if (L.count === 0) return null;
  const pad = L.maxTileH * 2;
  const { lo, hi } = visibleRange(L, py - pad, py + pad);
  // Pick the row by vertical distance first, then the closest tile along it. (Plain distance
  // would pick a tile in the row above when the pointer is far right of a short last row.)
  let best = -1;
  let bestDy = Infinity;
  let bestDx = Infinity;
  for (let i = lo; i < hi; i++) {
    const dx = px < L.x[i] ? L.x[i] - px : px > L.x[i] + L.w[i] ? px - L.x[i] - L.w[i] : 0;
    const bottom = L.y[i] + L.h[i] + L.captionH;
    const dy = py < L.y[i] ? L.y[i] - py : py > bottom ? py - bottom : 0;
    if (dy < bestDy || (dy === bestDy && dx < bestDx)) ((best = i), (bestDy = dy), (bestDx = dx));
  }
  if (best < 0) return null;
  if (L.kind === 'list') {
    const after = py > L.y[best] + L.h[best] / 2;
    return {
      index: best + (after ? 1 : 0),
      bar: {
        x: L.x[best],
        y: L.y[best] + (after ? L.h[best] : 0) - barSize / 2,
        w: L.w[best],
        h: barSize,
      },
    };
  }
  const after = px > L.x[best] + L.w[best] / 2;
  const edge = after ? L.x[best] + L.w[best] + 5 : L.x[best] - 5 - barSize;
  return {
    index: best + (after ? 1 : 0),
    bar: { x: edge, y: L.y[best], w: barSize, h: L.h[best] },
  };
}
