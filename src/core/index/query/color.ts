// Color search over the palette swatches (one per palette entry, with its CIELAB value). A swatch
// matches when it is big enough, inside a Lab ball around the target (CIE76 <= tolerance + 50,
// like Eagle's own color tests) and within CIEDE2000 tolerance. The color filter never changes
// the sort: it only removes items.
//
// Scanning the palette table in SQL cost 55-205 ms on 85k items (715k swatches), whatever the
// color. So the engine keeps the swatches in typed arrays sorted by L (PaletteMemory; after a
// palette change only the changed items' swatches are loaded, see caches.ts): CIEDE2000 can never be below |dL| / S_L, and S_L <= 1.75, so
// only an L band of +-1.75 x tolerance is looked at, and the CIEDE2000 math runs without
// allocating. An R-tree or a (l, a, b) box can't do better: CIEDE2000 shrinks chroma distances
// for saturated colors (a red at dE2000 20 can sit 70+ Lab units away), so a safe a/b box is the
// whole CIE76 ball, which covers most of the palette.
import type Database from 'better-sqlite3';
import { converter, differenceCiede2000 } from 'culori';

export type RGB = [number, number, number];

export interface Lab {
  l: number;
  a: number;
  b: number;
}

/** CIEDE2000 limits for `FilterSpec.color.tolerance`. */
export const COLOR_TOLERANCE = { similar: 20, close: 10 } as const;

const toLab = converter('lab65');
const de00 = differenceCiede2000();

const rgb01 = (v: number): number => Math.min(255, Math.max(0, v)) / 255;

export function rgbToLab(rgb: RGB): Lab {
  const lab = toLab({ mode: 'rgb', r: rgb01(rgb[0]), g: rgb01(rgb[1]), b: rgb01(rgb[2]) });
  return { l: lab.l, a: lab.a, b: lab.b };
}

/** CIEDE2000 between two sRGB colors (0-255 channels). 0 = identical, ~2 = barely different, 20+ = clearly different. */
export function colorDistance(a: RGB, b: RGB): number {
  return de00(
    { mode: 'rgb', r: rgb01(a[0]), g: rgb01(a[1]), b: rgb01(a[2]) },
    { mode: 'rgb', r: rgb01(b[0]), g: rgb01(b[1]), b: rgb01(b[2]) },
  );
}

/** CIE76: plain Euclidean distance in Lab. */
export const deltaE76 = (a: Lab, b: Lab): number => Math.hypot(a.l - b.l, a.a - b.a, a.b - b.b);

export interface ColorQuery {
  rgb: RGB;
  tolerance: 'similar' | 'close';
  /** Percent of the image (0-100) a matching swatch must cover. Default 0 = any palette entry. */
  minRatio?: number;
}

/**
 * CIEDE2000 from a fixed target: the same arithmetic, in the same order, as culori's
 * differenceCiede2000 (so a swatch on the tolerance boundary gets the same answer), without
 * allocating a color object per swatch.
 */
function ciede2000From(target: Lab): (l: number, a: number, b: number) => number {
  const lStd = target.l;
  const aStd = target.a;
  const bStd = target.b;
  const cStd = Math.sqrt(aStd * aStd + bStd * bStd);
  const p25 = Math.pow(25, 7);
  return (lSmp, aSmp, bSmp) => {
    const cSmp = Math.sqrt(aSmp * aSmp + bSmp * bSmp);
    const cAvg = (cStd + cSmp) / 2;
    const G = 0.5 * (1 - Math.sqrt(Math.pow(cAvg, 7) / (Math.pow(cAvg, 7) + p25)));
    const apStd = aStd * (1 + G);
    const apSmp = aSmp * (1 + G);
    const cpStd = Math.sqrt(apStd * apStd + bStd * bStd);
    const cpSmp = Math.sqrt(apSmp * apSmp + bSmp * bSmp);
    let hpStd = Math.abs(apStd) + Math.abs(bStd) === 0 ? 0 : Math.atan2(bStd, apStd);
    hpStd += Number(hpStd < 0) * 2 * Math.PI;
    let hpSmp = Math.abs(apSmp) + Math.abs(bSmp) === 0 ? 0 : Math.atan2(bSmp, apSmp);
    hpSmp += Number(hpSmp < 0) * 2 * Math.PI;
    const dL = lSmp - lStd;
    const dC = cpSmp - cpStd;
    let dhp = cpStd * cpSmp === 0 ? 0 : hpSmp - hpStd;
    dhp -= Number(dhp > Math.PI) * 2 * Math.PI;
    dhp += Number(dhp < -Math.PI) * 2 * Math.PI;
    const dH = 2 * Math.sqrt(cpStd * cpSmp) * Math.sin(dhp / 2);
    const Lp = (lStd + lSmp) / 2;
    const Cp = (cpStd + cpSmp) / 2;
    let hp: number;
    if (cpStd * cpSmp === 0) {
      hp = hpStd + hpSmp;
    } else {
      hp = (hpStd + hpSmp) / 2;
      hp -= Number(Math.abs(hpStd - hpSmp) > Math.PI) * Math.PI;
      hp += Number(hp < 0) * 2 * Math.PI;
    }
    const Lpm50 = Math.pow(Lp - 50, 2);
    const T =
      1 -
      0.17 * Math.cos(hp - Math.PI / 6) +
      0.24 * Math.cos(2 * hp) +
      0.32 * Math.cos(3 * hp + Math.PI / 30) -
      0.2 * Math.cos(4 * hp - (63 * Math.PI) / 180);
    const Sl = 1 + (0.015 * Lpm50) / Math.sqrt(20 + Lpm50);
    const Sc = 1 + 0.045 * Cp;
    const Sh = 1 + 0.015 * Cp * T;
    const deltaTheta =
      ((30 * Math.PI) / 180) * Math.exp(-1 * Math.pow(((180 / Math.PI) * hp - 275) / 25, 2));
    const Rc = 2 * Math.sqrt(Math.pow(Cp, 7) / (Math.pow(Cp, 7) + p25));
    const Rt = -1 * Math.sin(2 * deltaTheta) * Rc;
    return Math.sqrt(
      Math.pow(dL / (1 * Sl), 2) +
        Math.pow(dC / (1 * Sc), 2) +
        Math.pow(dH / (1 * Sh), 2) +
        (((Rt * dC) / (1 * Sc)) * dH) / (1 * Sh),
    );
  };
}

/** CIEDE2000's lightness weight: 1 at L 50, at most 1.7475 at L 0 or 100. */
const S_L_MAX = 1.75;

/**
 * Palette swatches in typed arrays sorted by L (rowid, l, a, b, ratio): ~36 bytes per swatch,
 * 26 MB for all 715k of Master. The engine loads them all once (query/caches PaletteCache).
 */
export class PaletteMemory {
  private constructor(
    private readonly rowid: Int32Array,
    private readonly l: Float64Array,
    private readonly a: Float64Array,
    private readonly b: Float64Array,
    private readonly ratio: Float64Array,
    private readonly maxRowid: number,
  ) {}

  static load(db: Database.Database, only?: readonly number[] | null): PaletteMemory {
    const rows = (
      only
        ? db
            .prepare(
              'SELECT item_rowid, l, a, bb, ratio FROM palette WHERE item_rowid IN (SELECT value FROM json_each(?)) ORDER BY l',
            )
            .raw(true)
            .all(JSON.stringify(only))
        : db.prepare('SELECT item_rowid, l, a, bb, ratio FROM palette ORDER BY l').raw(true).all()
    ) as [number, number, number, number, number][];
    const n = rows.length;
    const rowid = new Int32Array(n);
    const l = new Float64Array(n);
    const a = new Float64Array(n);
    const b = new Float64Array(n);
    const ratio = new Float64Array(n);
    let maxRowid = 0;
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      rowid[i] = r[0];
      l[i] = r[1];
      a[i] = r[2];
      b[i] = r[3];
      ratio[i] = r[4];
      if (r[0] > maxRowid) maxRowid = r[0];
    }
    return new PaletteMemory(rowid, l, a, b, ratio, maxRowid);
  }

  /** First index whose L is >= x (or > x with `after`). */
  private bound(x: number, after: boolean): number {
    let lo = 0;
    let hi = this.l.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.l[mid] < x || (after && this.l[mid] === x)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Rowids of the items that have a swatch covering at least `minRatio` percent whose color is
   * within tolerance of the target: CIEDE2000 <= 20 ('similar') or <= 10 ('close'), and, like
   * Eagle's own color tests, CIE76 <= tolerance + 50. Trashed items are included; the caller
   * intersects with its own candidates. `only` limits the answer to those rowids; the items in
   * `skip` are left out (their swatches here are out of date: see query/caches PaletteCache).
   */
  match(q: ColorQuery, only?: ReadonlySet<number> | null, skip?: ReadonlySet<number>): Set<number> {
    const tol = q.tolerance === 'close' ? COLOR_TOLERANCE.close : COLOR_TOLERANCE.similar;
    const minRatio = Number.isFinite(q.minRatio) ? (q.minRatio as number) : 0;
    const t = rgbToLab(q.rgb);
    const radius = tol + 50;
    const r2 = radius * radius * (1 + 1e-9); // the cheap test is never stricter than the real one
    const de = ciede2000From(t);
    const band = tol * S_L_MAX;
    const from = this.bound(t.l - band, false);
    const to = this.bound(t.l + band, true);
    const seen = new Uint8Array(this.maxRowid + 1);
    if (skip) for (const id of skip) if (id <= this.maxRowid) seen[id] = 1;
    const hits = new Set<number>();
    const { rowid, l, a, b, ratio } = this;
    for (let i = from; i < to; i++) {
      const id = rowid[i];
      if (seen[id] || ratio[i] < minRatio || (only && !only.has(id))) continue;
      const dl = l[i] - t.l;
      const da = a[i] - t.a;
      const db = b[i] - t.b;
      if (dl * dl + da * da + db * db > r2) continue;
      // CIEDE2000 >= |dL| / S_L (its chroma and hue terms can't go negative together), so a
      // lightness gap alone rules many swatches out before the full formula.
      const lpm50 = Math.pow((t.l + l[i]) / 2 - 50, 2);
      if (Math.abs(dl) > tol * (1 + (0.015 * lpm50) / Math.sqrt(20 + lpm50)) * (1 + 1e-9)) continue;
      if (de(l[i], a[i], b[i]) <= tol && deltaE76(t, { l: l[i], a: a[i], b: b[i] }) <= radius) {
        seen[id] = 1;
        hits.add(id);
      }
    }
    return hits;
  }
}

/**
 * The same answer straight from the database (tests, one-off callers): loads only the swatches of
 * `only`'s items when given, else all of them. The engine keeps a PaletteMemory instead.
 */
export function colorMatchRowids(
  db: Database.Database,
  q: ColorQuery,
  only?: readonly number[] | null,
): Set<number> {
  return PaletteMemory.load(db, only).match(q, only ? new Set(only) : null);
}
