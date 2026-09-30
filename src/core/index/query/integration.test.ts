// The engine against the REAL index module (openIndex + sync) on a real library: a read-only
// reflinked copy of the Art Archive in research/sandbox/templates (5.4k items). Nothing is written
// to the library; the sqlite index goes to .tmp/query/. Every answer is checked against a plain JS
// brute force over the parsed records, so a mismatch between the index's rows and what the engine
// assumes shows up here.
import { converter, differenceCiede2000 } from 'culori';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  EagleFolderRecord,
  EagleItemRecord,
  EagleRootRecord,
  Scope,
} from '../../../shared/types';
import type { EagleLibrary } from '../../contracts';
import { openIndex } from '../open';
import type { SqliteLibraryIndex } from '../libraryIndex';
import { queryEngines } from './index';
import { naturalKey } from './sorts';
import { urls } from './testUtil';

const TEMPLATE = resolve(
  import.meta.dirname,
  '../../../../research/sandbox/templates/art-archive.library',
);
const SCRATCH = resolve(import.meta.dirname, '../../../../.tmp/query/integration');

/** The five read methods sync() uses, straight from disk, read-only. */
function readOnlyLibrary(root: string): EagleLibrary {
  const lib = {
    root,
    readOnly: true,
    async readRoot() {
      const text = readFileSync(join(root, 'metadata.json'), 'utf8');
      return { value: JSON.parse(text), text };
    },
    async listItemIds() {
      return readdirSync(join(root, 'images'))
        .filter((n) => n.endsWith('.info'))
        .map((n) => n.slice(0, -5))
        .filter((id) => id.length === 13 || id.length === 36);
    },
    async readItem(id: string) {
      try {
        const text = readFileSync(join(root, 'images', `${id}.info`, 'metadata.json'), 'utf8');
        return { value: JSON.parse(text), text };
      } catch {
        return null;
      }
    },
    async readMtimeIndex() {
      try {
        return JSON.parse(readFileSync(join(root, 'mtime.json'), 'utf8'));
      } catch {
        return {};
      }
    },
    itemDir: (id: string) => join(root, 'images', `${id}.info`),
    async close() {},
  };
  return lib as unknown as EagleLibrary;
}

const haveTemplate = existsSync(TEMPLATE);
const de00 = differenceCiede2000();
const toLab = converter('lab65');
const round2 = (n: number) => Math.round(n * 100) / 100;

describe.skipIf(!haveTemplate)('engine on the real index, Art Archive template', () => {
  let ix: SqliteLibraryIndex;
  let eng: ReturnType<typeof queryEngines.create>;
  let root: EagleRootRecord;
  let recs: EagleItemRecord[] = [];
  const folderName = new Map<string, string>();
  const parent = new Map<string, string | null>();

  beforeAll(async () => {
    rmSync(SCRATCH, { recursive: true, force: true });
    mkdirSync(SCRATCH, { recursive: true });
    const lib = readOnlyLibrary(TEMPLATE);
    root = (await lib.readRoot()).value;
    for (const id of await lib.listItemIds()) {
      const d = await lib.readItem(id);
      if (d) recs.push(d.value);
    }
    const walk = (nodes: EagleFolderRecord[], p: string | null) =>
      nodes.forEach((n) => {
        folderName.set(n.id, n.name);
        parent.set(n.id, p);
        walk(n.children ?? [], n.id);
      });
    walk(root.folders, null);
    ix = openIndex({ id: 'query-it', path: TEMPLATE, name: 'Art Archive' }, { dir: SCRATCH });
    await ix.sync(lib);
    eng = queryEngines.create(ix, urls, (id) => `/x/${id}`);
  }, 180_000);

  afterAll(() => {
    ix?.close();
  });

  const live = () => recs.filter((r) => !r.isDeleted);
  const idsOf = (scope: Scope, filter = {}) =>
    new Set(eng.query({ scope, filter, sort: null }).ids);
  const same = (got: Set<string>, want: EagleItemRecord[], label: string) =>
    expect([...got].sort(), label).toEqual(want.map((r) => r.id).sort());
  const known = (r: EagleItemRecord) => (r.folders ?? []).filter((f) => folderName.has(f));
  const ancestorsOf = (id: string) => {
    const out = [id];
    for (let p = parent.get(id); p; p = parent.get(p)) out.push(p);
    return out;
  };

  it('scopes agree with a brute force over the records', () => {
    expect(recs.length).toBeGreaterThan(1000);
    same(idsOf({ kind: 'all' }), live(), 'all');
    same(
      idsOf({ kind: 'trash' }),
      recs.filter((r) => r.isDeleted),
      'trash',
    );
    same(
      idsOf({ kind: 'uncategorized' }),
      live().filter((r) => known(r).length === 0),
      'uncategorized',
    );
    same(
      idsOf({ kind: 'untagged' }),
      live().filter((r) => (r.tags ?? []).length === 0),
      'untagged',
    );
    same(idsOf({ kind: 'random', seed: 5 }), live(), 'random');
    // the index's own counts() must say the same
    const c = ix.counts();
    expect([c.all, c.uncategorized, c.untagged, c.trash]).toEqual([
      live().length,
      live().filter((r) => known(r).length === 0).length,
      live().filter((r) => (r.tags ?? []).length === 0).length,
      recs.length - live().length,
    ]);
  });

  it('folder scopes: own and with subfolders, for every folder, equal counts()', () => {
    const counts = ix.counts().folders;
    let checked = 0;
    for (const id of folderName.keys()) {
      const own = live().filter((r) => (r.folders ?? []).includes(id));
      const deep = live().filter((r) =>
        (r.folders ?? []).some((f) => folderName.has(f) && ancestorsOf(f).includes(id)),
      );
      expect(
        eng.query({
          scope: { kind: 'folder', id, includeSubfolders: false },
          filter: {},
          sort: null,
        }).total,
        `own ${id}`,
      ).toBe(own.length);
      expect(
        eng.query({
          scope: { kind: 'folder', id, includeSubfolders: true },
          filter: {},
          sort: null,
        }).total,
        `deep ${id}`,
      ).toBe(deep.length);
      expect([counts[id].own, counts[id].deep]).toEqual([own.length, deep.length]);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('tag scopes and tag filters', () => {
    const freq = new Map<string, number>();
    for (const r of live())
      for (const t of new Set(r.tags ?? [])) freq.set(t, (freq.get(t) ?? 0) + 1);
    const top = [...freq].sort((a, b) => b[1] - a[1]).slice(0, 8);
    expect(top.length).toBeGreaterThan(2);
    for (const [tag] of top)
      same(
        idsOf({ kind: 'tag', name: tag }),
        live().filter((r) => (r.tags ?? []).includes(tag)),
        `tag ${tag}`,
      );
    const [a, b] = [top[0][0], top[1][0]];
    const f = (mode: 'any' | 'all' | 'exact', include: string[], exclude: string[] = []) =>
      idsOf({ kind: 'all' }, { tags: { mode, include, exclude } });
    same(
      f('any', [a, b]),
      live().filter((r) => (r.tags ?? []).some((t) => t === a || t === b)),
      'any',
    );
    same(
      f('all', [a, b]),
      live().filter((r) => (r.tags ?? []).includes(a) && (r.tags ?? []).includes(b)),
      'all',
    );
    same(
      f('any', [a], [b]),
      live().filter((r) => (r.tags ?? []).includes(a) && !(r.tags ?? []).includes(b)),
      'any minus',
    );
    same(
      f('exact', [a]),
      live().filter((r) => new Set(r.tags ?? []).size === 1 && (r.tags ?? []).includes(a)),
      'exact',
    );
  });

  it('keyword search matches what a plain substring scan over each field finds', () => {
    // fields the grammar searches, each matched on its own (like FTS columns), both Unicode forms tried
    const fields = (r: EagleItemRecord) =>
      [
        r.name,
        ...(r.tags ?? []),
        r.annotation,
        r.url,
        r.ext,
        ...known(r).map((f) => folderName.get(f)!),
      ].filter((s) => typeof s === 'string');
    const hits = (term: string) => (r: EagleItemRecord) => {
      const forms = [...new Set([term.normalize('NFC'), term.normalize('NFD')])].map((t) =>
        t.toLowerCase(),
      );
      return fields(r).some((f) => forms.some((t) => f.toLowerCase().includes(t)));
    };
    const words = new Map<string, number>();
    for (const r of live())
      for (const w of `${r.name} ${(r.tags ?? []).join(' ')} ${r.annotation}`
        .toLowerCase()
        .split(/[^a-z]+/))
        if (w.length >= 3) words.set(w, (words.get(w) ?? 0) + 1);
    const common = [...words].sort((x, y) => y[1] - x[1]).map(([w]) => w);
    const [w1, w2, w3] = [common[0], common[5], common[20]];
    const short = w1.slice(0, 2); // 2 letters: the LIKE path
    const kw = (keywords: string) => idsOf({ kind: 'all' }, { keywords });

    same(kw(w1), live().filter(hits(w1)), w1);
    same(kw(w1.toUpperCase()), live().filter(hits(w1)), 'upper ' + w1);
    same(kw(short), live().filter(hits(short)), 'short ' + short);
    same(kw('jpg'), live().filter(hits('jpg')), 'jpg');
    same(
      kw(`${w1} ${w2}`),
      live().filter((r) => hits(w1)(r) && hits(w2)(r)),
      'AND',
    );
    same(
      kw(`${w1} -${w2}`),
      live().filter((r) => hits(w1)(r) && !hits(w2)(r)),
      'exclude',
    );
    same(
      kw(`${w1} OR ${w3}`),
      live().filter((r) => hits(w1)(r) || hits(w3)(r)),
      'OR',
    );
    same(
      kw(`(${w1} || ${w2}) -${w3}`),
      live().filter((r) => (hits(w1)(r) || hits(w2)(r)) && !hits(w3)(r)),
      'parens',
    );
    // names with accents, in whichever Unicode form the library stored them
    const accented = live().find((r) => /[À-ſ]/.test(r.name.normalize('NFC')));
    if (accented) {
      const bit = accented.name
        .normalize('NFC')
        .match(/\S*[À-ſ]\S*/)![0]
        .slice(0, 6);
      expect(kw(bit).has(accented.id), `accented ${bit}`).toBe(true);
      expect(kw(bit.normalize('NFD')).has(accented.id), `accented NFD ${bit}`).toBe(true);
    }
  });

  it('filters: rating, type, size, dimensions, dates, shape, url, note', () => {
    const f = (filter: object) => idsOf({ kind: 'all' }, filter);
    same(
      f({ rating: [4, 5] }),
      live().filter((r) => (r.star ?? 0) >= 4),
      'rating',
    );
    same(
      f({ rating: [0] }),
      live().filter((r) => !r.star),
      'unrated',
    );
    same(
      f({ types: { include: ['jpg', 'png'], exclude: [] } }),
      live().filter((r) => ['jpg', 'jpeg', 'png'].includes(r.ext)),
      'types',
    );
    same(
      f({ types: { include: ['image'], exclude: ['png'] } }),
      live().filter(
        (r) =>
          !['png'].includes(r.ext) &&
          [
            'jpg',
            'jpeg',
            'jfif',
            'gif',
            'webp',
            'psd',
            'tif',
            'tiff',
            'bmp',
            'svg',
            'heic',
            'avif',
          ].includes(r.ext),
      ),
      'image minus png (the image types this library has)',
    );
    same(
      f({ fileSize: { min: 500_000, max: 3_000_000 } }),
      live().filter((r) => r.size >= 500_000 && r.size <= 3_000_000),
      'size',
    );
    same(
      f({ width: { min: 1000 }, height: { max: 2000 } }),
      live().filter(
        (r) => (r.width ?? -1) >= 1000 && (r.height ?? Infinity) <= 2000 && r.height !== undefined,
      ),
      'dimensions',
    );
    const times = live()
      .map((r) => Number(r.modificationTime))
      .sort((a, b) => a - b);
    const [lo, hi] = [times[Math.floor(times.length * 0.3)], times[Math.floor(times.length * 0.6)]];
    same(
      f({ importedAt: { min: lo, max: hi } }),
      live().filter((r) => Number(r.modificationTime) >= lo && Number(r.modificationTime) <= hi),
      'importedAt',
    );
    same(
      f({ hasUrl: true }),
      live().filter((r) => r.url),
      'hasUrl',
    );
    same(
      f({ hasNote: false }),
      live().filter((r) => !r.annotation),
      'no note',
    );
    // Eagle's filter bar: landscape is any picture wider than tall; panoramic from 2.5:1.
    const landscape = live().filter((r) => r.width && r.height && r.width > r.height);
    same(f({ shapes: ['landscape'] }), landscape, 'landscape (wider than tall)');
    same(
      f({ shapes: ['panoramic-portrait', 'square'] }),
      live().filter(
        (r) => r.width && r.height && (r.width === r.height || r.height >= 2.5 * r.width),
      ),
      'square or panoramic portrait',
    );
    // aspect ratio 4:3 within 5%
    same(
      f({ aspect: { w: 4, h: 3 } }),
      live().filter(
        (r) =>
          r.width && r.height && Math.abs(r.width / r.height - 4 / 3) <= 0.05 * (4 / 3) + 1e-12,
      ),
      'aspect 4:3',
    );
  });

  it('sorts give a valid ordering of the same ids', () => {
    const all = live();
    const q = (
      by: 'IMPORT' | 'FILESIZE' | 'RESOLUTION' | 'RATING' | 'NAME' | 'EXT' | 'BTIME' | 'MTIME',
      ascending: boolean,
    ) => eng.query({ scope: { kind: 'all' }, filter: {}, sort: { by, ascending } }).ids;
    const byId = new Map(all.map((r) => [r.id, r]));
    const isSorted = (
      ids: string[],
      key: (r: EagleItemRecord) => number | string,
      asc: boolean,
    ) => {
      for (let i = 1; i < ids.length; i++) {
        const a = key(byId.get(ids[i - 1])!);
        const b = key(byId.get(ids[i])!);
        if (asc ? a > b : a < b) return false;
      }
      return true;
    };
    for (const [by, key] of [
      ['FILESIZE', (r: EagleItemRecord) => r.size],
      ['IMPORT', (r: EagleItemRecord) => Number(r.modificationTime)],
      ['RATING', (r: EagleItemRecord) => r.star ?? 0],
      ['RESOLUTION', (r: EagleItemRecord) => (r.width ?? 0) * (r.height ?? 0)],
      ['NAME', (r: EagleItemRecord) => naturalKey(r.name)],
      ['EXT', (r: EagleItemRecord) => r.ext],
      ['BTIME', (r: EagleItemRecord) => r.btime || Number(r.modificationTime)],
      ['MTIME', (r: EagleItemRecord) => r.mtime || Number(r.modificationTime)],
    ] as const) {
      for (const asc of [true, false]) {
        const ids = q(by, asc);
        expect(ids.length).toBe(all.length);
        expect(new Set(ids).size).toBe(all.length);
        expect(isSorted(ids, key, asc), `${by} ${asc ? 'asc' : 'desc'}`).toBe(true);
      }
    }
    // no sort given: IMPORT, newest first
    const def = eng.query({ scope: { kind: 'all' }, filter: {}, sort: null });
    expect(def.sort).toEqual({ by: 'IMPORT', ascending: false });
    expect(isSorted(def.ids, (r) => Number(r.modificationTime), false)).toBe(true);
  });

  it('manual order in a real folder that has order keys compares the keys as strings', () => {
    const withOrder = new Map<string, EagleItemRecord[]>();
    for (const r of live())
      for (const [fid, key] of Object.entries(r.order ?? {}))
        if (key && (r.folders ?? []).includes(fid) && folderName.has(fid))
          withOrder.set(fid, [...(withOrder.get(fid) ?? []), r]);
    const [fid] = [...withOrder].sort((a, b) => b[1].length - a[1].length)[0] ?? [];
    if (!fid) return; // this library has no manual order (fine)
    const got = eng.query({
      scope: { kind: 'folder', id: fid, includeSubfolders: false },
      filter: {},
      sort: { by: 'MANUAL', ascending: false },
    }).ids;
    const key = (r: EagleItemRecord) => (r.order?.[fid] as string) || String(r.modificationTime);
    const want = live()
      .filter((r) => (r.folders ?? []).includes(fid))
      .sort((a, b) => (key(a) > key(b) ? -1 : key(a) < key(b) ? 1 : a.id < b.id ? -1 : 1))
      .map((r) => r.id);
    expect(got).toEqual(want);
  });

  it('color search equals a brute force over the records', () => {
    const withPal = live().filter((r) => r.palettes?.length);
    expect(withPal.length).toBeGreaterThan(500);
    const target = withPal[7].palettes![0].color as [number, number, number];
    const t = toLab({ mode: 'rgb', r: target[0] / 255, g: target[1] / 255, b: target[2] / 255 });
    for (const tolerance of ['similar', 'close'] as const) {
      for (const minRatio of [0, 25]) {
        const T = tolerance === 'close' ? 10 : 20;
        const want = live().filter((r) =>
          (r.palettes ?? []).slice(0, 16).some((p) => {
            if (!(p.ratio >= minRatio)) return false;
            const l = toLab({
              mode: 'rgb',
              r: p.color[0] / 255,
              g: p.color[1] / 255,
              b: p.color[2] / 255,
            });
            const c = { mode: 'lab65' as const, l: round2(l.l), a: round2(l.a), b: round2(l.b) };
            return (
              de00({ mode: 'lab65', l: t.l, a: t.a, b: t.b }, c) <= T &&
              Math.hypot(t.l - c.l, t.a - c.a, t.b - c.b) <= T + 50
            );
          }),
        );
        same(
          idsOf({ kind: 'all' }, { color: { rgb: target, tolerance, minRatio } }),
          want,
          `${tolerance} min ${minRatio}`,
        );
      }
    }
  });

  it('briefs and items describe the records', () => {
    const sample = live()
      .filter((r) => (r.tags ?? []).length > 0 && r.palettes?.length)
      .slice(0, 25);
    const briefs = eng.briefs(sample.map((r) => r.id));
    expect(briefs.map((b) => b.id)).toEqual(sample.map((r) => r.id));
    sample.forEach((r, i) => {
      expect(briefs[i]).toMatchObject({
        name: r.name,
        ext: r.ext,
        star: r.star ?? 0,
        tagCount: new Set(r.tags).size,
        size: r.size,
      });
      const item = eng.item(r.id)!;
      expect(item).toMatchObject({
        tags: r.tags,
        folders: r.folders,
        url: r.url ?? '',
        annotation: r.annotation ?? '',
        importedAt: Number(r.modificationTime),
        filePath: `/x/${r.id}`,
      });
      expect(item.palettes.length).toBe(r.palettes!.length);
    });
  });

  it('suggest lists the most used tag first for empty text, and finds folders by letters', () => {
    const freq = new Map<string, number>();
    for (const r of live())
      for (const t of new Set(r.tags ?? [])) freq.set(t, (freq.get(t) ?? 0) + 1);
    const max = Math.max(...freq.values());
    const first = eng.suggest('', ['tag'], 3)[0];
    expect(first.count).toBe(max);
    const someFolder = [...folderName.values()].find((n) => n.length >= 5)!;
    const letters = [...someFolder.toLowerCase()]
      .filter((c) => /[a-z]/.test(c))
      .slice(0, 4)
      .join('');
    expect(eng.suggest(letters, ['folder'], 50).some((s) => s.label === someFolder)).toBe(true);
  });
});
