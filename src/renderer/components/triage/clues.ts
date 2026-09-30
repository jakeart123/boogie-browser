// Clues for sorting an item, read from its note and source link: "Student of: Delaunay",
// museum-style "Title" / "Flagellants" line pairs, the site it came from. Triage shows them next to
// the picture and suggests tags and folders whose names they mention.

export interface Clue {
  label: string;
  value: string;
}

/** Labels that museum and auction pages put on a line of their own, with the value below. */
const BLOCK_LABELS = new Set([
  'artist',
  'title',
  'date',
  'year',
  'medium',
  'technique',
  'support',
  'dimensions',
  'credit line',
  'teacher',
  'student of',
  'source',
  'location',
  'museum',
  'collection',
  'culture',
  'period',
  'subject',
  'school',
  'provenance',
]);

const MAX_CLUES = 8;

/** Plain text from a note that may hold HTML (Eagle's note editor saves some as <div>/<br>). */
export function noteText(note: string): string {
  return note
    .replace(/<br\s*\/?>|<\/(div|p|li)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// "Student of: Delaunay": a short label of words (no digits, not a web address), a colon, a value.
const LABELLED = /^([A-Za-zÀ-ɏ][A-Za-zÀ-ɏ .'-]{0,23}?)\s*:\s+(\S.*)$/;

/** The labelled facts in a note, in order, without repeats. */
export function parseNote(note: string): Clue[] {
  const lines = noteText(note)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const out: Clue[] = [];
  const add = (label: string, value: string) => {
    const v = value.trim().replace(/\s+/g, ' ');
    if (!v || out.some((c) => c.label.toLowerCase() === label.toLowerCase() && c.value === v))
      return;
    out.push({ label, value: v });
  };
  for (let i = 0; i < lines.length && out.length < MAX_CLUES; i++) {
    const m = LABELLED.exec(lines[i]);
    if (m && m[1].trim().split(/\s+/).length <= 4) {
      add(m[1].trim(), m[2]);
      continue;
    }
    if (BLOCK_LABELS.has(lines[i].toLowerCase()) && i + 1 < lines.length) {
      const next = lines[i + 1];
      if (!BLOCK_LABELS.has(next.toLowerCase())) add(lines[i], next);
      i++;
    }
  }
  return out;
}

/**
 * Does this note state the same fact ("Student of: Gerome", any case)? The whole value on its own
 * labelled line, never a piece of a longer word or sentence ("The Geromeo family", "a dealer who
 * hated Gerome" don't count). "Tag all" tags only the notes that pass this.
 */
export function sameClue(note: string, clue: Clue): boolean {
  const label = clue.label.toLowerCase();
  const value = clue.value.toLowerCase();
  return parseNote(note).some(
    (c) => c.label.toLowerCase() === label && c.value.toLowerCase() === value,
  );
}

/** "catzarts.beauxartsparis.fr" from a source link; '' when there is none. */
export function sourceSite(url: string): string {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, '') : '';
  } catch {
    return '';
  }
}

/** One short line for the queue list: the facts, or else the note's first line. */
export function clueLine(note: string): string {
  const clues = parseNote(note);
  const text = clues.length
    ? clues
        .slice(0, 3)
        .map((c) => c.value)
        .join(' · ')
    : (noteText(note)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean) ?? '');
  return text.length > 90 ? `${text.slice(0, 88)}…` : text;
}

export interface Suggestion {
  kind: 'tag' | 'folder';
  /** Tag name, or folder name. */
  name: string;
  /** Folder id (folders only). */
  id?: string;
  /** The fact that points at it. */
  clue: Clue;
}

// Lowercase words without accents. Every tag and folder name is split once per session, not once
// per item (a big library has thousands of each).
const split = new Map<string, string[]>();
function words(s: string): string[] {
  let w = split.get(s);
  if (!w) {
    w = s
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
    if (split.size > 50_000) split.clear();
    split.set(s, w);
  }
  return w;
}

/** Does `hay` contain the word sequence `needle` (at word boundaries)? */
function hasWords(hay: string[], needle: string[]): boolean {
  if (!needle.length || needle.length > hay.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * Tags and folders the clues mention: a name that contains a clue's value ("Atelier Delaunay" for
 * "Student of: Delaunay"), or a value that contains the name ("Morisset" in "Morisset, François").
 * Things already on the item are left out. Best first: exact names, then shorter names.
 */
export function suggest(
  clues: Clue[],
  tags: readonly string[],
  folders: readonly { id: string; name: string }[],
  have: { tags: readonly string[]; folders: readonly string[] },
  limit = 4,
): Suggestion[] {
  const hits: (Suggestion & { rank: number })[] = [];
  const seen = new Set<string>();
  const consider = (kind: 'tag' | 'folder', name: string, id: string | undefined) => {
    const key = `${kind}:${id ?? name}`;
    if (seen.has(key)) return;
    const n = words(name);
    if (n.join(' ').length < 3) return;
    for (const clue of clues) {
      const v = words(clue.value);
      if (v.join(' ').length < 3) continue;
      const exact = n.join(' ') === v.join(' ');
      if (exact || hasWords(n, v) || (n.join('').length >= 4 && hasWords(v, n))) {
        seen.add(key);
        hits.push({ kind, name, id, clue, rank: (exact ? 0 : 1000) + name.length });
        return;
      }
    }
  };
  for (const t of tags) if (!have.tags.includes(t)) consider('tag', t, undefined);
  for (const f of folders) if (!have.folders.includes(f.id)) consider('folder', f.name, f.id);
  return hits
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map(({ rank: _rank, ...s }) => s);
}
