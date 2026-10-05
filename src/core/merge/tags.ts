// tags.json against a conflicted copy of it: starred tags and recent tags, one tag at a time. Pure.
import { judge } from './judge';
import { NONE, quoted, type Diff, type Rec } from './types';

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * Recent tags are Eagle's history list, rewritten from memory all the time and worth little: a
 * difference that isn't certain keeps the library's list quietly instead of asking about each tag.
 */
export function mergeTags(
  live: Rec,
  copy: Rec,
  bases: readonly Rec[],
  opts: { auto: boolean },
): Diff<Rec>[] {
  const out: Diff<Rec>[] = [];
  for (const [key, noun, topic] of [
    ['starredTags', 'Starred tag', 'starred'],
    ['historyTags', 'Recent tag', 'recent'],
  ] as const) {
    // A copy without this list says nothing about it (it is damaged, or not a tags.json at all):
    // never read that as "every tag was taken off".
    if (!Array.isArray(copy[key])) continue;
    const L = strings(live[key]);
    const C = strings(copy[key]);
    for (const tag of new Set([...L, ...C])) {
      const has = (r: Rec) => strings(r[key]).includes(tag);
      let verdict = judge(has(live), has(copy), bases.map(has));
      if (verdict === 'same') continue;
      if (key === 'historyTags' && !(verdict === 'copy' && opts.auto)) verdict = 'live';
      out.push({
        id: `${key === 'starredTags' ? 'starred' : 'recent'}:${tag}`,
        label: `${noun} ${quoted(tag)}`,
        live: L.includes(tag) ? tag : NONE,
        copy: C.includes(tag) ? tag : NONE,
        topic,
        verdict: verdict === 'copy' && !opts.auto ? 'ask' : verdict,
        apply: (target) => {
          const list = strings(target[key]);
          if (list.includes(tag) === C.includes(tag)) return false;
          // Newly starred (or used) tags go to the front, like Eagle does.
          target[key] = C.includes(tag) ? [tag, ...list] : list.filter((t) => t !== tag);
          return true;
        },
      });
    }
  }
  return out;
}
