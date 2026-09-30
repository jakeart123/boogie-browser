import { beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  EagleItemRecord,
  FilterSpec,
  QueryRequest,
  Scope,
  SortSpec,
} from '../../../shared/types';
import type { QueryEngine } from '../../contracts';
import { PaletteMemory } from './color';
import { queryEngines } from './index';
import { Fixture, folder, makeRoot, urls } from './testUtil';

const ART = 'FART000000001';
const PORT = 'FPORT00000001';
const FACES = 'FFACE00000001';
const LAND = 'FLAND00000001';
const REF = 'FREF000000001';

const all: Scope = { kind: 'all' };

function run(fx: Fixture, scope: Scope, filter: FilterSpec = {}, sort: SortSpec | null = null) {
  const engine = fx.engine();
  const res = engine.query({ scope, filter, sort } satisfies QueryRequest);
  return { res, names: engine.briefs(res.ids).map((b) => b.name) };
}
const sorted = (a: string[]) => [...a].sort();

// One shared library for the scope and filter tests. Items are added in the order listed, so
// "Mockup iPhone" is the oldest import and "Trashed thing" the newest.
let fx: Fixture;
let ids: Record<string, string>;
beforeAll(() => {
  fx = new Fixture(
    makeRoot([
      folder(ART, 'Art', [
        folder(PORT, 'Portraits', [folder(FACES, 'Faces')]),
        folder(LAND, 'Landscapes'),
      ]),
      folder(REF, 'References'),
    ]),
  );
  const add = (r: Partial<EagleItemRecord> & { name: string }) => fx.add(r).id;
  ids = {
    mockup: add({
      name: 'Mockup iPhone',
      tags: ['ui', 'phone'],
      folders: [PORT],
      width: 1000,
      height: 2000,
      star: 3,
      url: 'https://dribbble.com/shots/1',
      annotation: 'front view',
      size: 5000,
    }),
    oil2: add({
      name: 'oil sketch 2',
      ext: 'jpg',
      tags: ['sketch', 'oil'],
      folders: [FACES],
      width: 800,
      height: 600,
      star: 5,
      annotation: 'Student of Gérôme',
      size: 20000,
      mtime: 1_600_000_000_000,
    }),
    oil10: add({
      name: 'oil sketch 10',
      ext: 'jpg',
      tags: ['sketch'],
      folders: [ART, PORT, LAND],
      width: 900,
      height: 600,
      size: 30000,
    }),
    study: add({
      name: 'Drawing Study',
      tags: [],
      folders: [],
      width: 500,
      height: 500,
      star: 4,
      size: 1000,
    }),
    photo: add({
      name: 'Landscape Photo',
      ext: 'jpg',
      tags: ['photo', 'oil'],
      folders: [LAND],
      width: 3000,
      height: 1000,
      star: 1,
      url: 'https://example.com/p',
      size: 900_000,
    }),
    song: add({ name: 'Song', ext: 'mp3', tags: ['audio'], duration: 125.5, size: 4_000_000 }),
    clip: add({
      name: 'Clip',
      ext: 'mp4',
      tags: ['video', 'ui'],
      folders: [REF],
      width: 1920,
      height: 1080,
      duration: 30,
      star: 2,
      size: 90_000_000,
    }),
    trashed: add({
      name: 'Trashed thing',
      tags: ['ui'],
      folders: [ART],
      isDeleted: true,
      deletedTime: 1_700_000_100_000,
    }),
    eleve: add({
      name: 'Élève study',
      ext: 'jpg',
      tags: ['étude'],
      folders: [REF],
      width: 640,
      height: 480,
      size: 7000,
    }),
  };
});

describe('scopes', () => {
  it('all is live items only; trash is the trashed ones; uncategorized and untagged use the counters', () => {
    expect(run(fx, all).names).toHaveLength(8);
    expect(run(fx, { kind: 'trash' }).names).toEqual(['Trashed thing']);
    expect(sorted(run(fx, { kind: 'uncategorized' }).names)).toEqual(['Drawing Study', 'Song']);
    expect(run(fx, { kind: 'untagged' }).names).toEqual(['Drawing Study']);
  });

  it('folder: own items, or the whole subtree, each item once even if it sits in several folders', () => {
    expect(run(fx, { kind: 'folder', id: ART, includeSubfolders: false }).names).toEqual([
      'oil sketch 10',
    ]);
    expect(sorted(run(fx, { kind: 'folder', id: PORT, includeSubfolders: false }).names)).toEqual([
      'Mockup iPhone',
      'oil sketch 10',
    ]);
    const deep = run(fx, { kind: 'folder', id: ART, includeSubfolders: true });
    // oil sketch 10 is in Art, Portraits and Landscapes but appears once
    expect(sorted(deep.names)).toEqual([
      'Landscape Photo',
      'Mockup iPhone',
      'oil sketch 10',
      'oil sketch 2',
    ]);
    expect(deep.res.total).toBe(4);
  });

  it('tag, and explicit ids (which include trashed items)', () => {
    expect(sorted(run(fx, { kind: 'tag', name: 'oil' }).names)).toEqual([
      'Landscape Photo',
      'oil sketch 2',
    ]);
    expect(sorted(run(fx, { kind: 'ids', ids: [ids.trashed, ids.mockup, 'nope'] }).names)).toEqual([
      'Mockup iPhone',
      'Trashed thing',
    ]);
  });

  it('random: live items in an order fixed by the seed', () => {
    const a = run(fx, { kind: 'random', seed: 7 });
    const b = run(fx, { kind: 'random', seed: 7 });
    const c = run(fx, { kind: 'random', seed: 8 });
    expect(a.res.ids).toEqual(b.res.ids);
    expect(a.res.ids).not.toEqual(c.res.ids);
    expect(a.res.total).toBe(8);
    expect(a.res.sort.by).toBe('RANDOM');
  });
});

describe('keyword filter', () => {
  const kw = (keywords: string) => sorted(run(fx, all, { keywords }).names);

  it('matches name, tags, note, url, folder names and extension, case-insensitively', () => {
    expect(kw('phone')).toEqual(['Mockup iPhone']);
    expect(kw('MOCKUP')).toEqual(['Mockup iPhone']);
    expect(kw('dribbble')).toEqual(['Mockup iPhone']); // url
    expect(kw('front')).toEqual(['Mockup iPhone']); // note
    expect(kw('portraits')).toEqual(['Mockup iPhone', 'oil sketch 10']); // folder name
    expect(kw('jpg')).toEqual([
      'E\u0301le\u0300ve study',
      'Landscape Photo',
      'oil sketch 10',
      'oil sketch 2',
    ]); // ext
    expect(kw('.jpg')).toHaveLength(4);
  });

  it('terms under 3 characters are found too (LIKE path)', () => {
    expect(kw('ui')).toEqual(['Clip', 'Mockup iPhone']); // tags
    expect(kw('mp')).toEqual(['Clip', 'Landscape Photo', 'Song']); // ext mp3/mp4, and example.com in a url
    expect(kw('ui -clip')).toEqual(['Mockup iPhone']);
  });

  it('a short accented term finds either case (SQLite lower() only folds ASCII)', () => {
    expect(kw('é')).toEqual(['E\u0301le\u0300ve study', 'oil sketch 2']); // Élève (NFD name, étude tag) and Gérôme (note)
    expect(kw('É')).toEqual(kw('é'));
    expect(kw('ô')).toEqual(['oil sketch 2']);
    expect(kw('Ô')).toEqual(['oil sketch 2']);
    expect(kw('é -ô')).toEqual(['E\u0301le\u0300ve study']);
  });

  it('AND, -exclude, OR, phrases and parentheses', () => {
    expect(kw('oil sketch')).toEqual(['oil sketch 10', 'oil sketch 2']);
    expect(kw('"sketch 2"')).toEqual(['oil sketch 2']);
    expect(kw('oil -sketch')).toEqual(['Landscape Photo']);
    expect(kw('oil OR audio')).toEqual([
      'Landscape Photo',
      'Song',
      'oil sketch 10',
      'oil sketch 2',
    ]);
    expect(kw('(oil || audio) -sketch')).toEqual(['Landscape Photo', 'Song']);
  });

  it('unbalanced input still narrows instead of failing', () => {
    expect(kw('"oil sketch')).toEqual(['oil sketch 10', 'oil sketch 2']);
    expect(kw('audio OR')).toEqual(['Song']);
  });

  it('finds an NFD name from an NFC search (real libraries mix both)', () => {
    expect(kw('élève')).toHaveLength(1);
  });

  it('covers comments and folder descriptions; a phrase never runs from one tag into the next', () => {
    const c = new Fixture(
      makeRoot([folder('FSTUDIO000001', 'Studio', [], { description: 'plein air studies' })]),
    );
    c.add({
      name: 'one',
      tags: ['Color Poetry', 'Absolute Favorites'],
      comments: [{ id: 'C1', annotation: 'left hand', lastModified: 1, x: 0, y: 0 }],
    });
    c.add({ name: 'two', folders: ['FSTUDIO000001'] });
    const k = (keywords: string) => sorted(run(c, all, { keywords }).names);
    expect(k('hand')).toEqual(['one']); // a region comment
    expect(k('ha')).toEqual(['one']); // the short path reads comments too
    expect(k('plein')).toEqual(['two']); // the folder's description
    expect(k('"Color Poetry"')).toEqual(['one']);
    expect(k('"ry Ab"')).toEqual([]); // the end of one tag + the start of the next
    // A renamed folder is found by its new name on the short path too (item_search is rebuilt).
    c.setRoot(
      makeRoot([folder('FSTUDIO000001', 'Atelier', [], { description: '' })], [], {
        modificationTime: 2,
      }),
    );
    expect(k('at')).toEqual(['two']);
    expect(k('pl')).toEqual([]);
  });

  it('a NUL in the text (MCP and HTTP pass strings straight through) is ignored, not an error', () => {
    expect(kw('oil\u0000')).toEqual(['Landscape Photo', 'oil sketch 10', 'oil sketch 2']);
    expect(
      run(fx, all, { urlContains: 'dribbble\u0000', noteContains: '\u0000front' }).names,
    ).toEqual(['Mockup iPhone']);
  });

  it('is not an injection or FTS-syntax hole', () => {
    expect(kw('name:secret')).toEqual([]);
    expect(kw(`x'; DROP TABLE items; --`)).toEqual([]);
    expect(kw('NEAR(oil sketch)')).toEqual([]);
    expect(run(fx, all).names).toHaveLength(8);
  });
});

describe('other filters', () => {
  const f = (filter: FilterSpec) => sorted(run(fx, all, filter).names);

  it('tags: any, all, exact, exclude', () => {
    expect(f({ tags: { mode: 'any', include: ['oil', 'video'], exclude: [] } })).toEqual([
      'Clip',
      'Landscape Photo',
      'oil sketch 2',
    ]);
    expect(f({ tags: { mode: 'all', include: ['oil', 'sketch'], exclude: [] } })).toEqual([
      'oil sketch 2',
    ]);
    expect(f({ tags: { mode: 'exact', include: ['sketch'], exclude: [] } })).toEqual([
      'oil sketch 10',
    ]); // oil sketch 2 has one more
    expect(f({ tags: { mode: 'any', include: [], exclude: ['ui'] } })).toHaveLength(6);
    expect(f({ tags: { mode: 'any', include: ['oil'], exclude: ['photo'] } })).toEqual([
      'oil sketch 2',
    ]);
    expect(f({ tags: { mode: 'all', include: [], exclude: [] } })).toHaveLength(8); // empty = no constraint
  });

  it('folders: plain membership (no descendants); NoFolders means unfiled', () => {
    expect(f({ folders: { include: [PORT], exclude: [] } })).toEqual([
      'Mockup iPhone',
      'oil sketch 10',
    ]); // not oil sketch 2 in Faces
    expect(f({ folders: { include: [PORT, LAND], exclude: [] } })).toEqual([
      'Landscape Photo',
      'Mockup iPhone',
      'oil sketch 10',
    ]);
    expect(f({ folders: { include: [], exclude: [PORT] } })).toHaveLength(6);
    expect(f({ folders: { include: ['NoFolders'], exclude: [] } })).toEqual([
      'Drawing Study',
      'Song',
    ]);
  });

  it("shapes follow Eagle's filter bar; aspect ratio (tolerance is relative, default 5%)", () => {
    expect(f({ shapes: ['square'] })).toEqual(['Drawing Study']);
    expect(f({ shapes: ['panoramic-landscape'] })).toEqual(['Landscape Photo']); // 3:1
    // Landscape is just "wider than tall", panoramic ones included; panoramic starts at 2.5:1.
    expect(f({ shapes: ['landscape', 'square'] })).toHaveLength(6);
    expect(f({ shapes: ['portrait'] })).toEqual(['Mockup iPhone']);
    expect(f({ shapes: ['panoramic-portrait'] })).toEqual([]); // 1:2 is not panoramic
    expect(f({ shapes: ['bogus' as never] })).toEqual([]);
    expect(f({ aspect: { w: 16, h: 9 } })).toEqual(['Clip']);
    expect(f({ aspect: { w: 3, h: 2 } })).toEqual(['oil sketch 10']);
    expect(f({ aspect: { w: 4, h: 3 } })).toEqual(['Élève study', 'oil sketch 2']);
    expect(f({ aspect: { w: 4, h: 3, tolerance: 0.2 } })).toEqual([
      'Élève study',
      'oil sketch 10',
      'oil sketch 2',
    ]);
    expect(f({ aspect: { w: 1, h: 1 } })).toEqual(['Drawing Study']); // items without dimensions never match
  });

  it('rating, with 0 meaning unrated', () => {
    expect(f({ rating: [5, 4] })).toEqual(['Drawing Study', 'oil sketch 2']);
    expect(f({ rating: [0] })).toEqual(['Élève study', 'Song', 'oil sketch 10']);
  });

  it('types: extensions and groups', () => {
    expect(f({ types: { include: ['video'], exclude: [] } })).toEqual(['Clip']);
    expect(f({ types: { include: ['audio', 'mp4'], exclude: [] } })).toEqual(['Clip', 'Song']);
    expect(f({ types: { include: ['image'], exclude: ['jpg'] } })).toEqual([
      'Drawing Study',
      'Mockup iPhone',
    ]);
    expect(f({ types: { include: ['.PNG'], exclude: [] } })).toEqual([
      'Drawing Study',
      'Mockup iPhone',
    ]);
    expect(f({ types: { include: [], exclude: ['image', 'audio'] } })).toEqual(['Clip']);
  });

  it('ranges: size, dimensions, duration, dates', () => {
    expect(f({ fileSize: { min: 1_000_000 } })).toEqual(['Clip', 'Song']);
    expect(f({ width: { min: 900, max: 1000 } })).toEqual(['Mockup iPhone', 'oil sketch 10']);
    expect(f({ height: { min: 480, max: 500 } })).toEqual([
      'Drawing Study',
      'E\u0301le\u0300ve study',
    ]);
    expect(f({ duration: { min: 100 } })).toEqual(['Song']);
    expect(f({ importedAt: { min: 1_700_000_003_000, max: 1_700_000_005_000 } })).toEqual([
      'Drawing Study',
      'Landscape Photo',
      'oil sketch 10',
    ]);
    // modified = the file's own mtime, falling back to the import time
    expect(f({ modifiedAt: { max: 1_650_000_000_000 } })).toEqual(['oil sketch 2']);
    expect(f({ width: {} })).toHaveLength(8);
  });

  it('has URL / has note, and contains (one literal, case-insensitive string)', () => {
    expect(f({ hasUrl: true })).toEqual(['Landscape Photo', 'Mockup iPhone']);
    expect(f({ hasUrl: false })).toHaveLength(6);
    expect(f({ hasNote: true })).toEqual(['Mockup iPhone', 'oil sketch 2']);
    expect(f({ urlContains: 'DRIBBBLE.com/shots' })).toEqual(['Mockup iPhone']);
    expect(f({ urlContains: 'dribbble, shots' })).toEqual([]); // literal: there is no comma in that URL
    expect(f({ noteContains: 'GÉRÔME' })).toEqual(['oil sketch 2']);
    expect(f({ noteContains: 'fr' })).toEqual(['Mockup iPhone']); // short string path
  });

  it('urlContains finds URLs that hold commas, spaces and quotes', () => {
    const s = new Fixture(makeRoot());
    s.add({ name: 'a', url: 'https://example.com/a,b/c d?q="x"' });
    s.add({ name: 'b', url: 'https://example.com/other' });
    const names = (urlContains: string) => run(s, all, { urlContains }).names;
    expect(names('a,b/c d')).toEqual(['a']);
    expect(names('q="x"')).toEqual(['a']);
    expect(names('example.com')).toHaveLength(2);
  });

  it('filters combine with the scope', () => {
    const r = run(
      fx,
      { kind: 'folder', id: ART, includeSubfolders: true },
      { rating: [3, 5], keywords: 'sketch OR mockup' },
    );
    expect(sorted(r.names)).toEqual(['Mockup iPhone', 'oil sketch 2']);
  });
});

describe('color filter', () => {
  it('a red swatch at 40% matches red with minRatio 30 but not 50', () => {
    const c = new Fixture();
    const red = c.add({
      name: 'Red poster',
      palettes: [
        { color: [220, 30, 30], ratio: 40 },
        { color: [240, 240, 235], ratio: 60 },
      ],
    });
    c.add({
      name: 'Blue poster',
      palettes: [
        { color: [20, 30, 200], ratio: 70 },
        { color: [240, 240, 235], ratio: 30 },
      ],
    });
    c.add({ name: 'No palette' });
    const color = (minRatio?: number) =>
      run(c, all, { color: { rgb: [220, 20, 20], tolerance: 'similar', minRatio } }).res.ids;
    expect(color(30)).toEqual([red.id]);
    expect(color(50)).toEqual([]);
    expect(color()).toEqual([red.id]);
    // color only filters: the sort is still the one asked for
    const r = run(
      c,
      all,
      { color: { rgb: [20, 30, 200], tolerance: 'close' } },
      { by: 'NAME', ascending: true },
    );
    expect(r.names).toEqual(['Blue poster']);
  });

  it('color combines with a scope, skips trashed items and keeps the folder sort', () => {
    const F = 'FCOLOR000001';
    const c = new Fixture(makeRoot([folder(F, 'Posters')]));
    const red = (name: string, extra: Partial<EagleItemRecord> = {}) =>
      c.add({ name, palettes: [{ color: [220, 30, 30], ratio: 50 }], ...extra });
    red('in folder b', { folders: [F] });
    red('in folder a', { folders: [F] });
    red('elsewhere');
    red('trashed', { folders: [F], isDeleted: true });
    const r = run(
      c,
      { kind: 'folder', id: F, includeSubfolders: false },
      { color: { rgb: [220, 30, 30], tolerance: 'close' } },
      { by: 'NAME', ascending: true },
    );
    expect(r.names).toEqual(['in folder a', 'in folder b']);
    expect(
      run(c, { kind: 'trash' }, { color: { rgb: [220, 30, 30], tolerance: 'close' } }).names,
    ).toEqual(['trashed']);
  });

  it("after palette changes, loads only the changed items' swatches and still answers right", () => {
    const c = new Fixture();
    const engine = c.engine();
    const red = (name: string) => c.add({ name, palettes: [{ color: [220, 30, 30], ratio: 50 }] });
    const a = red('a');
    const query = () =>
      engine
        .query({
          scope: all,
          filter: { color: { rgb: [220, 30, 30], tolerance: 'close' } },
          sort: null,
        })
        .ids.sort();
    const load = vi.spyOn(PaletteMemory, 'load');
    try {
      expect(query()).toEqual([a.id]);
      expect(load).toHaveBeenCalledTimes(1); // everything, once

      const b = red('b');
      expect(query()).toEqual([a.id, b.id].sort());
      c.add({ ...a, palettes: [{ color: [20, 30, 200], ratio: 50 }] }); // a turns blue
      expect(query()).toEqual([b.id]);
      c.ix.removeItems([b.id]);
      expect(query()).toEqual([]);
      expect(query()).toEqual([]); // nothing changed: nothing loaded
      // Every load after the first was for the changed items only.
      expect(load.mock.calls.slice(1).every((args) => Array.isArray(args[1]))).toBe(true);
      expect(load).toHaveBeenCalledTimes(4);
    } finally {
      load.mockRestore();
    }
  });

  it('close is stricter than similar', () => {
    const c = new Fixture();
    c.add({ name: 'Orange-red', palettes: [{ color: [230, 90, 40], ratio: 50 }] });
    const q = (tolerance: 'similar' | 'close') =>
      run(c, all, { color: { rgb: [220, 30, 30], tolerance, minRatio: 10 } }).res.total;
    expect(q('similar')).toBe(1);
    expect(q('close')).toBe(0);
  });
});

describe('sorts', () => {
  const build = (items: (Partial<EagleItemRecord> & { name: string })[], root = makeRoot()) => {
    const s = new Fixture(root);
    for (const it of items) s.add(it);
    return s;
  };
  const order = (s: Fixture, by: SortSpec['by'], ascending: boolean, scope: Scope = all) =>
    run(s, scope, {}, { by, ascending }).names;

  it('default for a plain scope is IMPORT, newest first', () => {
    const s = build([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    const r = run(s, all);
    expect(r.names).toEqual(['c', 'b', 'a']);
    expect(r.res.sort).toEqual({ by: 'IMPORT', ascending: false });
    expect(order(s, 'IMPORT', true)).toEqual(['a', 'b', 'c']);
  });

  it('NAME is natural and case-insensitive: img_2 before img_10', () => {
    const s = build([
      { name: 'img_10' },
      { name: 'IMG_2' },
      { name: 'Img_1' },
      { name: 'apple' },
      { name: 'Écran' },
      { name: 'zebra' },
    ]);
    expect(order(s, 'NAME', true)).toEqual(['apple', 'Écran', 'Img_1', 'IMG_2', 'img_10', 'zebra']);
    expect(order(s, 'NAME', false)).toEqual([
      'zebra',
      'img_10',
      'IMG_2',
      'Img_1',
      'Écran',
      'apple',
    ]);
  });

  it('NAME puts punctuation in the same order as the ICU collator Eagle uses', () => {
    const names = [
      'x (y)',
      'x - y',
      'x, y',
      'x_y',
      'x y',
      'x.y',
      'x2',
      'x10',
      'x',
      'X 1877-04 (detail)',
      'x 1877-04 ~ z',
      'Ex',
      'e5',
    ];
    const s = build(names.map((name) => ({ name })));
    const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
    expect(order(s, 'NAME', true)).toEqual(
      [...names].sort((a, b) => collator.compare(a, b) || (a < b ? -1 : 1)),
    );
  });

  it('EXT, RESOLUTION, FILESIZE, RATING, DURATION, TAGS', () => {
    const s = build([
      {
        name: 'a',
        ext: 'png',
        width: 100,
        height: 100,
        size: 30,
        star: 2,
        duration: 5,
        tags: ['zeta', 'alpha'],
      },
      {
        name: 'b',
        ext: 'gif',
        width: 50,
        height: 400,
        size: 10,
        star: 5,
        duration: 60,
        tags: ['Beta'],
      },
      { name: 'c', ext: 'jpg', size: 20, tags: [] },
    ]);
    expect(order(s, 'EXT', true)).toEqual(['b', 'c', 'a']);
    expect(order(s, 'RESOLUTION', false)).toEqual(['b', 'a', 'c']); // 20000, 10000, none
    expect(order(s, 'FILESIZE', true)).toEqual(['b', 'c', 'a']);
    expect(order(s, 'RATING', false)).toEqual(['b', 'a', 'c']);
    expect(order(s, 'DURATION', false)).toEqual(['b', 'a', 'c']);
    // TAGS is the "Number of tags" sort: 0, 1, 2 (Eagle's own hidden TAGS order is by first tag name)
    expect(order(s, 'TAGS', true)).toEqual(['c', 'b', 'a']);
    expect(order(s, 'TAGS', false)).toEqual(['a', 'b', 'c']);
  });

  it('BTIME and MTIME use the file times, falling back to the import time', () => {
    const s = build([
      { name: 'old-file', btime: 1000, mtime: 9000 },
      { name: 'new-file', btime: 5000, mtime: 2000 },
      { name: 'no-times' }, // falls back to modificationTime (about 1.7e12), the biggest
    ]);
    expect(order(s, 'BTIME', true)).toEqual(['old-file', 'new-file', 'no-times']);
    expect(order(s, 'MTIME', true)).toEqual(['new-file', 'old-file', 'no-times']);
  });

  it('ties break by id ascending in both directions', () => {
    const s = build([
      { id: 'IDB', name: 'b', size: 5 },
      { id: 'IDA', name: 'a', size: 5 },
      { id: 'IDC', name: 'c', size: 5 },
    ]);
    const byId = (asc: boolean) => run(s, all, {}, { by: 'FILESIZE', ascending: asc }).res.ids;
    expect(byId(true)).toEqual(['IDA', 'IDB', 'IDC']);
    expect(byId(false)).toEqual(['IDA', 'IDB', 'IDC']);
  });

  it('MANUAL compares the order keys as text, top first (descending), falling back to the import time text', () => {
    const G = 'FMANUAL000001';
    const OTHER = 'FOTHER0000001';
    const s = new Fixture(
      makeRoot([
        folder(G, 'Manual', [], { orderBy: 'MANUAL', sortIncrease: true }),
        folder(OTHER, 'Other'),
      ]),
    );
    const recs = [
      // as text "999.5" > "1000.5", although 999.5 < 1000.5 as numbers
      s.add({ name: 'k4', folders: [G], order: { [G]: '999.5' } }),
      s.add({ name: 'k5', folders: [G], order: { [G]: '1000.5' } }),
      // real-looking keys: long decimals that a float would round together
      s.add({ name: 'k1', folders: [G], order: { [G]: '1708727558963.56655092592592592596' } }),
      s.add({ name: 'k2', folders: [G], order: { [G]: '1708727558963.6' } }),
      s.add({ name: 'k3', folders: [G], order: { [G]: '1708727558963.5665509259259259259' } }),
      s.add({ name: 'k6', folders: [G], order: { [G]: '1708727558963.1' } }),
      s.add({ name: 'k7', folders: [G], order: { [G]: '1708727558963.10000000000000000001' } }),
      // no key for this folder: the key is String(modificationTime); a key for another folder is ignored
      s.add({
        name: 'no-order',
        folders: [G],
        modificationTime: '1708727558963' as unknown as number,
      }),
      s.add({ name: 'other-only', folders: [G], order: { [OTHER]: '9999999999999.9' } }),
    ];
    const keyOf = (r: EagleItemRecord) => r.order?.[G] || String(r.modificationTime);
    const expected = recs
      .sort((a, b) => (keyOf(a) > keyOf(b) ? -1 : keyOf(a) < keyOf(b) ? 1 : 0))
      .map((r) => r.name);
    const got = run(s, { kind: 'folder', id: G, includeSubfolders: false });
    expect(got.names).toEqual(expected);
    expect(got.names.indexOf('k2')).toBeLessThan(got.names.indexOf('k1')); // ".6" beats ".566..." like JS string comparison
    expect(got.names.indexOf('k4')).toBeLessThan(got.names.indexOf('k5'));
    expect(got.names.indexOf('k7')).toBeLessThan(got.names.indexOf('k6')); // a longer key with the same start is bigger
    expect(got.res.sort).toEqual({ by: 'MANUAL', ascending: false });
    // ascending = bottom first = the exact reverse (no ties here)
    expect(
      run(
        s,
        { kind: 'folder', id: G, includeSubfolders: false },
        {},
        { by: 'MANUAL', ascending: true },
      ).names,
    ).toEqual([...expected].reverse());
  });

  it('RANDOM outside the random scope is stable for a given seed', () => {
    const s = build(Array.from({ length: 30 }, (_, i) => ({ name: `n${i}` })));
    const eng = s.engine(); // one engine per library session: it holds the shuffle seed
    const req: QueryRequest = { scope: all, filter: {}, sort: { by: 'RANDOM', ascending: true } };
    const a = eng.query(req).ids;
    expect(eng.query(req).ids).toEqual(a);
    expect(a).not.toEqual([...a].sort());
    // a caller can ask for a new shuffle by passing a seed on the sort
    const seeded = (seed: number) =>
      eng.query({ ...req, sort: { by: 'RANDOM', ascending: true, seed } as SortSpec }).ids;
    expect(seeded(1)).toEqual(seeded(1));
    expect(seeded(1)).not.toEqual(seeded(2));
  });

  it("a folder's own orderBy and sortIncrease give the default (sortIncrease is Eagle's, not literal)", () => {
    const F = (id: string, orderBy: SortSpec['by'] | undefined, sortIncrease?: boolean) =>
      folder(id, id, [], orderBy ? { orderBy, sortIncrease } : {});
    const s = new Fixture(
      makeRoot([
        F('FNAMEUP000001', 'NAME', true),
        F('FNAMEDN000001', 'NAME', false),
        F('FIMPUP0000001', 'IMPORT', true),
        F('FIMPDN0000001', 'IMPORT', false),
        F('FMANUP0000001', 'MANUAL', true),
        F('FNONE00000001', undefined),
      ]),
    );
    const eng = s.engine();
    const d = (id: string) => eng.defaultSort({ kind: 'folder', id, includeSubfolders: false });
    expect(d('FNAMEUP000001')).toEqual({ by: 'NAME', ascending: true });
    expect(d('FNAMEDN000001')).toEqual({ by: 'NAME', ascending: false });
    expect(d('FIMPUP0000001')).toEqual({ by: 'IMPORT', ascending: false }); // Eagle's "increase" for IMPORT is newest first
    expect(d('FIMPDN0000001')).toEqual({ by: 'IMPORT', ascending: true });
    expect(d('FMANUP0000001')).toEqual({ by: 'MANUAL', ascending: false });
    expect(d('FNONE00000001')).toEqual({ by: 'IMPORT', ascending: false });
    expect(d('nope')).toEqual({ by: 'IMPORT', ascending: false });
    expect(eng.defaultSort({ kind: 'tag', name: 'x' })).toEqual({ by: 'IMPORT', ascending: false });
    expect(eng.defaultSort({ kind: 'random', seed: 1 }).by).toBe('RANDOM');
  });

  it('a request with no sort uses the folder sort; an explicit sort wins', () => {
    const G = 'FSORTED000001';
    const s = build(
      [
        { name: 'b', folders: [G] },
        { name: 'a', folders: [G] },
        { name: 'c', folders: [G] },
      ],
      makeRoot([folder(G, 'Sorted', [], { orderBy: 'NAME', sortIncrease: true })]),
    );
    const scope: Scope = { kind: 'folder', id: G, includeSubfolders: false };
    expect(run(s, scope).names).toEqual(['a', 'b', 'c']);
    expect(run(s, scope, {}, { by: 'NAME', ascending: false }).names).toEqual(['c', 'b', 'a']);
  });
});

describe('result shape', () => {
  it('returns ids, aspects (1 when unknown), total, applied sort and timing', () => {
    const s = new Fixture();
    s.add({ name: 'wide', width: 200, height: 100 });
    s.add({ name: 'unknown' });
    const r = s.engine().query({ scope: all, filter: {}, sort: { by: 'NAME', ascending: true } });
    expect(r.total).toBe(2);
    expect(r.ids).toHaveLength(2);
    expect(r.aspects).toEqual([1, 2]);
    expect(r.sort).toEqual({ by: 'NAME', ascending: true });
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

describe('briefs and items', () => {
  it('briefs keep the order asked for and skip unknown ids', () => {
    const eng = fx.engine();
    const b = eng.briefs([ids.song, 'missing', ids.mockup]);
    expect(b.map((x) => x.name)).toEqual(['Song', 'Mockup iPhone']);
    expect(b[1]).toMatchObject({
      ext: 'png',
      width: 1000,
      height: 2000,
      star: 3,
      tagCount: 2,
      isDeleted: false,
      noPreview: false,
      duration: null,
    });
    expect(b[0].thumbUrl).toBe(urls.thumb(ids.song, b[0].version));
    expect(eng.briefs([])).toEqual([]);
    expect(eng.briefs([ids.trashed])[0].isDeleted).toBe(true);
  });

  it('item builds the full record view with urls and file path', () => {
    const c = new Fixture();
    const rec = c.add({
      name: 'Full',
      tags: ['a'],
      folders: ['F1'],
      star: 4,
      width: 10,
      height: 20,
      palettes: [{ color: [1, 2, 3], ratio: 60, $$hashKey: 'object:9' }],
      comments: [{ id: 'C1', annotation: 'hello', lastModified: 5 }],
      order: { F1: '1708727558963.5' },
      btime: 11,
      mtime: 22,
      duration: 3.5,
    });
    const item = c.engine().item(rec.id)!;
    expect(item).toMatchObject({
      id: rec.id,
      name: 'Full',
      ext: 'png',
      tags: ['a'],
      folders: ['F1'],
      star: 4,
      width: 10,
      height: 20,
      importedAt: rec.modificationTime,
      modifiedAt: rec.lastModified,
      btime: 11,
      mtime: 22,
      duration: 3.5,
      deletedTime: null,
      comments: [{ id: 'C1', annotation: 'hello', lastModified: 5 }],
      order: { F1: '1708727558963.5' },
      palettes: [{ color: [1, 2, 3], ratio: 60 }], // $$hashKey dropped
      filePath: `/lib/images/${rec.id}.info/file`,
      version: rec.lastModified,
    });
    expect(item.thumbUrl).toBe(urls.thumb(rec.id, rec.lastModified!));
    expect(item.fileUrl).toBe(urls.file(rec.id, rec.lastModified!));
    expect(item.previewUrl).toBe(urls.preview(rec.id, 'png', rec.lastModified!));
    expect(c.engine().item('nope')).toBeNull();
    expect(
      c
        .engine()
        .items([rec.id, 'nope', rec.id])
        .map((i) => i.id),
    ).toEqual([rec.id, rec.id]);
  });

  it('a string modificationTime (2 real items have one) still gives a numeric importedAt', () => {
    const c = new Fixture();
    const rec = c.add({ name: 'odd', modificationTime: '1779741123280.51' as unknown as number });
    expect(c.engine().item(rec.id)!.importedAt).toBe(1779741123280.51);
  });
});

describe('suggest', () => {
  it('fuzzy: "mki" finds "Mockup iPhone"; prefix beats word start beats letters-in-order, then count', () => {
    const s = new Fixture(
      makeRoot([
        folder('F1', 'Mockup iPhone'),
        folder('F2', 'Smock'),
        folder('F3', 'Mock ups'),
        folder('F4', 'Art', [folder('F5', 'Kitchen mixups')]),
      ]),
    );
    s.add({ name: 'x', folders: ['F1'] });
    s.add({ name: 'y', folders: ['F3'] });
    s.add({ name: 'z', folders: ['F3'] });
    s.add({ name: 'gone', folders: ['F1'], isDeleted: true });
    const eng = s.engine();
    const labels = (
      text: string,
      kinds: ('tag' | 'folder' | 'smartFolder')[] = ['folder'],
      limit = 10,
    ) => eng.suggest(text, kinds, limit).map((r) => r.label);

    expect(labels('mki')).toContain('Mockup iPhone');
    expect(labels('mock')).toEqual(['Mock ups', 'Mockup iPhone', 'Smock']); // prefix (more items first), then letters in order
    expect(labels('iph')).toEqual(['Mockup iPhone']); // starts a word
    expect(labels('kitmix')).toEqual(['Kitchen mixups']);
    expect(labels('art kit')).toEqual(['Kitchen mixups']); // matches through the path "Art / Kitchen mixups"
    expect(labels('zzz')).toEqual([]);
    expect(eng.suggest('mock', ['folder'], 1)).toHaveLength(1);
    const hit = eng.suggest('iph', ['folder'], 5)[0];
    expect(hit).toEqual({
      kind: 'folder',
      id: 'F1',
      label: 'Mockup iPhone',
      path: 'Mockup iPhone',
      count: 1,
    }); // the trashed item is not counted
    expect(eng.suggest('kitmix', ['folder'], 5)[0].path).toBe('Art / Kitchen mixups');
  });

  it('tags: counted from live items; tags that only live in a tag group show with 0', () => {
    const s = new Fixture(
      makeRoot([], [], {
        tagsGroups: [{ id: 'G1', name: 'Group', tags: ['grouped-only', 'dog'] }],
      }),
    );
    s.add({ name: 'a', tags: ['dog', 'cat'] });
    s.add({ name: 'b', tags: ['dog'] });
    s.add({ name: 'c', tags: ['dog'], isDeleted: true });
    const eng = s.engine();
    expect(eng.suggest('dog', ['tag'], 5)[0]).toMatchObject({
      kind: 'tag',
      label: 'dog',
      count: 2,
    });
    expect(eng.suggest('grouped', ['tag'], 5)).toEqual([
      { kind: 'tag', id: 'grouped-only', label: 'grouped-only', path: '', count: 0 },
    ]);
    // empty text lists the most used first
    expect(eng.suggest('', ['tag'], 2).map((r) => r.label)).toEqual(['dog', 'cat']);
  });

  it('sees changes made after the engine was created', () => {
    const s = new Fixture();
    const eng = s.engine();
    expect(eng.suggest('newtag', ['tag'], 5)).toEqual([]);
    s.add({ name: 'a', tags: ['newtag'] });
    expect(eng.suggest('newtag', ['tag'], 5)).toHaveLength(1);
  });
});

describe('factory', () => {
  it('queryEngines.create builds an engine from a LibraryIndex', () => {
    const s = new Fixture();
    s.add({ name: 'one' });
    const eng: QueryEngine = queryEngines.create(s.index(), urls, (id) => id);
    expect(eng.query({ scope: all, filter: {}, sort: null }).total).toBe(1);
  });
});

describe('round 4 filters (saved filters from Eagle)', () => {
  const DAY = 86_400_000;
  const now = Date.now();
  const s = new Fixture(makeRoot([folder('F1', 'One')]));
  s.add({ name: 'tagged', tags: ['oil'], folders: ['F1'], modificationTime: now - 2 * DAY });
  s.add({ name: 'untagged', tags: [], modificationTime: now - 40 * DAY, mtime: now - DAY });
  s.add({
    name: 'gray',
    tags: ['x'],
    modificationTime: now,
    palettes: [
      { color: [120, 121, 125], ratio: 60 },
      { color: [200, 0, 0], ratio: 0.01 }, // too small to count
    ],
    comments: [{ id: 'c1', annotation: 'Fix the Hand', lastModified: 1 }],
  });
  s.add({
    name: 'red',
    tags: ['y'],
    modificationTime: now,
    palettes: [{ color: [200, 30, 30], ratio: 90 }],
  });
  const f = (filter: FilterSpec) => sorted(run(s, all, filter).names);

  it('no tags joins an "any" tag list, otherwise means untagged; unfiled joins the folder list', () => {
    expect(f({ noTags: true })).toEqual(['untagged']);
    expect(f({ noTags: true, tags: { mode: 'any', include: ['oil'], exclude: [] } })).toEqual([
      'tagged',
      'untagged',
    ]);
    expect(f({ noTags: true, tags: { mode: 'all', include: ['oil'], exclude: [] } })).toEqual([]);
    expect(f({ unfiled: true })).toEqual(['gray', 'red', 'untagged']);
    expect(f({ unfiled: true, folders: { include: ['F1'], exclude: [] } })).toHaveLength(4);
  });

  it('grayscale, region comments, and rolling "last N days" windows', () => {
    expect(f({ grayscale: true })).toEqual(['gray']);
    expect(f({ hasComments: true })).toEqual(['gray']);
    expect(f({ hasComments: false })).toHaveLength(3);
    expect(f({ commentContains: 'the hand' })).toEqual(['gray']); // case-insensitive, like Eagle
    expect(f({ commentContains: 'fo' })).toEqual([]);
    expect(f({ importedWithinDays: 7 })).toEqual(['gray', 'red', 'tagged']);
    // Date modified is the file's mtime, else the import time.
    expect(f({ modifiedWithinDays: 7 })).toEqual(['gray', 'red', 'tagged', 'untagged']);
    expect(f({ modifiedWithinDays: 7, importedWithinDays: 30 })).toHaveLength(3);
  });
});

describe('password-locked folders (Boogie never unlocks)', () => {
  const s = new Fixture(
    makeRoot(
      [
        folder('FLOCK', 'Private', [folder('FSUB', 'Inside')], { password: 'x' }),
        folder('FOPEN', 'Open'),
      ],
      [
        {
          id: 'SF1',
          name: 'Everything tagged',
          modificationTime: 1,
          conditions: [
            { match: 'AND', rules: [{ property: 'tags', method: 'not-empty', value: [] }] },
          ],
          children: [],
        },
      ],
    ),
  );
  s.add({ name: 'locked', tags: ['t'], folders: ['FLOCK'], size: 10 });
  s.add({ name: 'deep', tags: ['t'], folders: ['FSUB'], size: 20 });
  s.add({ name: 'both', tags: ['t'], folders: ['FOPEN', 'FLOCK'], size: 30 }); // one lock is enough
  s.add({ name: 'open', tags: ['t'], folders: ['FOPEN'], size: 40 });
  s.add({ name: 'loose', tags: [], size: 50 });
  s.add({ name: 'binned', tags: ['t'], folders: ['FLOCK'], isDeleted: true, size: 60 });
  const names = (scope: Scope) => sorted(run(s, scope).names);

  it("hides their items (and their subfolders') from every view but the trash", () => {
    expect(names(all)).toEqual(['loose', 'open']);
    expect(names({ kind: 'folder', id: 'FOPEN', includeSubfolders: false })).toEqual(['open']);
    expect(names({ kind: 'folder', id: 'FLOCK', includeSubfolders: true })).toEqual([]);
    expect(names({ kind: 'tag', name: 't' })).toEqual(['open']);
    expect(names({ kind: 'smartFolder', id: 'SF1' })).toEqual(['open']);
    expect(names({ kind: 'trash' })).toEqual(['binned']);
  });

  it('leaves them out of the counts and tags; folder badges still count them, like Eagle', () => {
    const c = s.ix.counts();
    expect(c).toMatchObject({ all: 2, untagged: 1, uncategorized: 1, trash: 1, totalSize: 90 });
    expect(c.folders.FLOCK).toEqual({ own: 2, deep: 3 });
    expect(s.ix.tags().find((t) => t.name === 't')?.count).toBe(1);
    expect(s.engine().smartFolderCounts()).toEqual({ SF1: 1 });
  });

  it('shows everything again once the password is gone', () => {
    const t = new Fixture(makeRoot([folder('FLOCK', 'Private', [], { password: 'x' })]));
    t.add({ name: 'a', folders: ['FLOCK'] });
    expect(run(t, all).names).toEqual([]);
    t.setRoot(makeRoot([folder('FLOCK', 'Private')], [], { modificationTime: 2 }));
    expect(run(t, all).names).toEqual(['a']);
  });
});

describe('briefs', () => {
  it('say when the thumb is our own rendition, and when an item is animated', () => {
    const s = new Fixture();
    const kra = s.add({ name: 'paint', ext: 'kra', noPreview: true }).id;
    const odt = s.add({ name: 'doc', ext: 'odt', noPreview: true }).id;
    const webp = s.add({ name: 'anim', ext: 'webp', animated: true }).id;
    const jpg = s.add({ name: 'pic', ext: 'jpg' }).id;
    const b = Object.fromEntries(
      s
        .engine()
        .briefs([kra, odt, webp, jpg])
        .map((x) => [x.name, x]),
    );
    expect(b.paint.localThumb).toBe(true);
    expect(b.doc.localThumb).toBeUndefined(); // nothing we can draw
    expect(b.pic.localThumb).toBeUndefined(); // Eagle's own thumbnail
    expect(b.anim.animated).toBe(true);
    expect(b.pic.animated).toBeUndefined();
  });
});
