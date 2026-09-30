// Subsequence fuzzy matching in the spirit of Eagle's ("mki" finds "Mockup iPhone"): every query
// character must appear in order. Matches at the start of a word and in unbroken runs score higher,
// and a small DP picks the best alignment rather than the first one it finds.

export interface FuzzyHit {
  score: number;
  /** Indexes into the text (UTF-16 units) of the matched characters, ascending. */
  positions: number[];
}

const NEG = -1e9;
const RUN_BONUS = 8;
const GAP_PENALTY = 1;

function isWordChar(c: string): boolean {
  return /[\p{L}\p{N}]/u.test(c);
}

/** Lower-case per UTF-16 unit so indexes stay aligned with the original text. */
function lower(s: string): string[] {
  return s.split('').map((c) => c.toLowerCase());
}

export function fuzzy(query: string, text: string): FuzzyHit | null {
  const q = lower(query.replace(/\s+/g, ''));
  const m = q.length;
  if (m === 0) return { score: 0, positions: [] };
  const raw = text.split('');
  const t = lower(text);
  const n = t.length;
  if (m > n) return null;

  // Cheap rejection before the DP: is it a subsequence at all?
  for (let i = 0, j = 0; ; j++) {
    if (j === n) return null;
    if (t[j] === q[i] && ++i === m) break;
  }

  const wordBonus = (j: number): number => {
    if (j === 0) return 12;
    if (!isWordChar(raw[j - 1])) return 9;
    if (raw[j - 1] === raw[j - 1].toLowerCase() && raw[j] !== raw[j].toLowerCase()) return 7;
    return 0;
  };

  const score = new Float64Array(m * n).fill(NEG);
  const parent = new Int32Array(m * n).fill(-1);
  for (let i = 0; i < m; i++) {
    // best over k < j of (score[i-1][k] - (j-k-1)*GAP), kept as a running max
    let runBest = NEG;
    let runArg = -1;
    for (let j = 0; j < n; j++) {
      if (i > 0 && j > 0) {
        const prev = score[(i - 1) * n + (j - 1)];
        if (prev > NEG) {
          const candidate = prev + (j - 1) * GAP_PENALTY;
          if (candidate > runBest) {
            runBest = candidate;
            runArg = j - 1;
          }
        }
      }
      if (t[j] !== q[i]) continue;
      const base = 10 + wordBonus(j);
      if (i === 0) {
        score[j] = base - Math.min(j, 6) * 0.5;
        continue;
      }
      let best = NEG;
      let arg = -1;
      if (runArg >= 0) {
        best = runBest - (j - 1) * GAP_PENALTY;
        arg = runArg;
      }
      if (j > 0) {
        const prev = score[(i - 1) * n + (j - 1)];
        if (prev > NEG && prev + RUN_BONUS > best) {
          best = prev + RUN_BONUS;
          arg = j - 1;
        }
      }
      if (arg < 0) continue;
      score[i * n + j] = best + base;
      parent[i * n + j] = arg;
    }
  }

  let bestJ = -1;
  let bestScore = NEG;
  for (let j = 0; j < n; j++) {
    const s = score[(m - 1) * n + j];
    if (s > NEG) {
      const adjusted = s - (n - 1 - j) * 0.1;
      if (adjusted > bestScore) {
        bestScore = adjusted;
        bestJ = j;
      }
    }
  }
  if (bestJ < 0) return null;

  const positions = new Array<number>(m);
  for (let i = m - 1, j = bestJ; i >= 0; i--) {
    positions[i] = j;
    j = parent[i * n + j];
  }
  let total = bestScore - n * 0.05;
  if (n === m) total += 30; // the whole text was typed
  return { score: total, positions };
}

/**
 * For long titles (commands): the same match, but reject sprawling ones like "fle" inside
 * "Filter by tags". Accepted: one unbroken run, an acronym ("gtf" for "Go to folder"), or a longer
 * query in at most two runs. Spaces don't break a run, so a title typed out in full ("Add from
 * URL", "Save this filter") is one run.
 */
export function fuzzyTight(query: string, text: string): FuzzyHit | null {
  const hit = fuzzy(query, text);
  if (!hit) return null;
  const p = hit.positions;
  const joined = (a: number, b: number) => b === a + 1 || /^\s+$/.test(text.slice(a + 1, b));
  const runs = p.filter((pos, i) => i === 0 || !joined(p[i - 1], pos)).length;
  const atWordStart = (j: number) => j === 0 || !isWordChar(text[j - 1]);
  if (runs <= 1 || p.every(atWordStart) || (p.length >= 4 && runs <= 2)) return hit;
  return null;
}

export interface Segment {
  text: string;
  hit: boolean;
}

/** Split text into runs so matched characters can be wrapped in <mark>. */
export function segments(text: string, positions: number[] | undefined): Segment[] {
  if (!positions?.length) return [{ text, hit: false }];
  const hits = new Set(positions);
  const out: Segment[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i);
    const last = out[out.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else out.push({ text: text[i], hit });
  }
  return out;
}
