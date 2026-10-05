// An item's metadata.json against a conflicted copy of it, field by field. Pure.
//
// Fields that are the picture's own (size, width, height, ext, noThumbnail) always keep the
// library's value. Everything else is compared one by one: name, notes, link, rating, trash (with
// its time), each tag, each folder, each manual position, and any other key as a whole value.
import { isNoise, same, strip } from './normalize';
import { judge } from './judge';
import { NONE, quoted, shown, type Diff, type Rec } from './types';

export interface ItemContext {
  /** A folder's name, or undefined when the library no longer has it. */
  folderName(id: string): string | undefined;
  /** false: nothing is certain enough to apply (every difference that isn't the library's is a question). */
  auto: boolean;
}

const DERIVED = new Set(['id', 'size', 'width', 'height', 'ext', 'noThumbnail']);
const HANDLED = new Set([
  'name',
  'annotation',
  'url',
  'star',
  'isDeleted',
  'deletedTime',
  'tags',
  'folders',
  'order',
]);

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const orderOf = (r: Rec): Rec =>
  r.order && typeof r.order === 'object' && !Array.isArray(r.order) ? (r.order as Rec) : {};
const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];

export function mergeItem(
  live: Rec,
  copy: Rec,
  bases: readonly Rec[],
  ctx: ItemContext,
): Diff<Rec>[] {
  const out: Diff<Rec>[] = [];

  /** One comparable slot. `get` reads it from a record; `put` takes the copy's value onto one. */
  function slot(
    id: string,
    label: string,
    topic: string,
    get: (r: Rec) => unknown,
    show: (v: unknown) => string,
    put: (target: Rec) => boolean,
  ): void {
    const l = get(live);
    const c = get(copy);
    const verdict = judge(l, c, bases.map(get));
    if (verdict === 'same') return;
    out.push({
      id,
      label,
      live: show(l),
      copy: show(c),
      topic,
      verdict: verdict === 'copy' && !ctx.auto ? 'ask' : verdict,
      apply: put,
    });
  }

  /** Set or delete a plain key to the copy's value. */
  const putKey = (key: string) => (target: Rec) => {
    if (same(target[key], copy[key])) return false;
    if (copy[key] === undefined) {
      if (!(key in target)) return false;
      delete target[key];
    } else target[key] = structuredClone(copy[key]);
    return true;
  };

  // A copy without a usable name is damaged: its name is never taken.
  if (typeof copy.name === 'string' && copy.name.trim())
    slot('name', 'Name', 'name', (r) => r.name, shown, putKey('name'));
  slot('annotation', 'Notes', 'notes', (r) => r.annotation, shown, putKey('annotation'));
  slot('url', 'Source link', 'link', (r) => r.url, shown, putKey('url'));
  slot(
    'star',
    'Rating',
    'rating',
    (r) => Number(r.star) || 0,
    (v) => (v ? `${v} ${v === 1 ? 'star' : 'stars'}` : NONE),
    putKey('star'),
  );
  // In the trash or not, with the time it went there: one unit. Two trash times alone don't differ.
  slot(
    'trash',
    'Trash',
    'trash',
    (r) => r.isDeleted === true,
    (v) => (v ? 'In the trash' : 'Not in the trash'),
    (target) => {
      const was = target.isDeleted === true;
      if (copy.isDeleted === true) {
        target.isDeleted = true;
        if (typeof copy.deletedTime === 'number') target.deletedTime = copy.deletedTime;
        else if (typeof target.deletedTime !== 'number') target.deletedTime = Date.now();
      } else {
        target.isDeleted = false;
        delete target.deletedTime;
      }
      return was !== (target.isDeleted === true);
    },
  );

  for (const tag of union(strings(live.tags), strings(copy.tags))) {
    slot(
      `tag:${tag}`,
      `Tag ${quoted(tag)}`,
      'tag',
      (r) => strings(r.tags).includes(tag),
      (v) => (v ? tag : NONE),
      (target) => {
        const have = strings(target.tags);
        const want = strings(copy.tags).includes(tag);
        if (have.includes(tag) === want) return false;
        target.tags = want ? [...have, tag] : have.filter((t) => t !== tag);
        return true;
      },
    );
  }

  // A folder the library no longer has is never put back on an item: nothing for a person to decide.
  const folderLabel = (id: string) => {
    const name = ctx.folderName(id);
    return name === undefined ? 'A folder that no longer exists' : `Folder ${quoted(name)}`;
  };
  const folderText = (id: string) => (v: unknown) =>
    v ? (ctx.folderName(id) ?? 'A folder that no longer exists') : NONE;
  for (const id of union(strings(live.folders), strings(copy.folders))) {
    const inLive = strings(live.folders).includes(id);
    if (!inLive && ctx.folderName(id) === undefined) continue;
    slot(
      `folder:${id}`,
      folderLabel(id),
      'folder',
      (r) => strings(r.folders).includes(id),
      folderText(id),
      (target) => {
        const have = strings(target.folders);
        const want = strings(copy.folders).includes(id);
        if (have.includes(id) === want) return false;
        target.folders = want ? [...have, id] : have.filter((f) => f !== id);
        return true;
      },
    );
  }

  // Manual positions are strings and stay exactly as they are: never parsed as numbers.
  for (const id of union(Object.keys(orderOf(live)), Object.keys(orderOf(copy)))) {
    if (!(id in orderOf(live)) && ctx.folderName(id) === undefined) continue;
    slot(
      `order:${id}`,
      `Position in ${ctx.folderName(id) === undefined ? 'a folder that no longer exists' : quoted(ctx.folderName(id)!)}`,
      'position',
      (r) => orderOf(r)[id],
      shown,
      (target) => {
        const mine = { ...orderOf(target) };
        const theirs = orderOf(copy)[id];
        if (mine[id] === theirs) return false;
        if (theirs === undefined) delete mine[id];
        else mine[id] = theirs;
        target.order = mine;
        return true;
      },
    );
  }

  const keys = union(Object.keys(live), Object.keys(copy)).filter(
    (k) => !HANDLED.has(k) && !DERIVED.has(k) && !isNoise(k),
  );
  for (const key of keys)
    slot(
      `field:${key}`,
      `Setting ${quoted(key)}`,
      'other',
      (r) => strip(r[key]),
      shown,
      putKey(key),
    );

  return out;
}
