// The record math behind undoing a stale-overwrite entry (test/eagle-proof FINDINGS 1-3): put back
// only the parts of our change that the outside write reverted to the old copy, and keep whatever
// else the partner changed. Whether a write WAS an old copy is decided in service/partner/judge.ts.
import { asArray, asObject, same, setOrDelete, type Rec } from './util';

/** Never compared: every write bumps lastModified. deletedTime goes with isDeleted (below). */
const SKIP = new Set(['id', 'lastModified', 'deletedTime']);

const keysOf = (...recs: Rec[]) => [...new Set(recs.flatMap((r) => Object.keys(r)))];

/**
 * `base`: the item as the partner's Eagle last had it (before our pending changes). `ours`: the
 * file before the outside write (our version). `theirs`: what the outside write left.
 *
 * Returns `ours` with only the parts of our change that `theirs` put back to `base` restored the
 * old way, or null when it reverted none of them (the writer had our version). Undoing
 * "ours -> result" then restores exactly those parts, field by field.
 */
export function staleRevert(base: Rec, ours: Rec, theirs: Rec): Rec | null {
  const out = structuredClone(ours);
  let reverted = false;

  // The trash state is one unit (Eagle re-adds deletedTime from memory, so it is not compared alone).
  if (!!ours.isDeleted !== !!base.isDeleted && !!theirs.isDeleted === !!base.isDeleted) {
    setOrDelete(out, 'isDeleted', theirs.isDeleted);
    setOrDelete(out, 'deletedTime', theirs.deletedTime);
    reverted = true;
  }

  for (const key of keysOf(base, ours, theirs)) {
    if (SKIP.has(key) || key === 'isDeleted') continue;
    if (key === 'tags' || key === 'folders') {
      const b = asArray(base[key]);
      const o = asArray(ours[key]);
      const t = asArray(theirs[key]);
      const lost = o.filter((x) => !b.includes(x) && !t.includes(x)); // we added, the write lacks
      const back = b.filter((x) => !o.includes(x) && t.includes(x)); // we removed, the write has
      if (!lost.length && !back.length) continue;
      out[key] = [...o.filter((x) => !lost.includes(x)), ...back];
      reverted = true;
    } else if (key === 'order') {
      // One entry per folder, each its own field.
      const b = asObject(base.order);
      const o = asObject(ours.order);
      const t = asObject(theirs.order);
      const next = { ...asObject(out.order) };
      let any = false;
      for (const f of keysOf(b, o)) {
        if (b[f] === o[f] || t[f] !== b[f]) continue;
        setOrDelete(next, f, t[f]);
        any = true;
      }
      if (any) {
        out.order = next;
        reverted = true;
      }
    } else if (!same(base[key], ours[key], key) && same(theirs[key], base[key], key)) {
      setOrDelete(out, key, theirs[key]); // we changed it, the write has the old value
      reverted = true;
    }
  }
  return reverted ? out : null;
}
