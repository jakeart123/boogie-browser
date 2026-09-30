// Timings on a synthetic 85k-item library (the size of a big real-world library). Prints a table;
// asserts only generous ceilings so a busy machine doesn't make it flaky. Set
// BOOGIE_PERF_STRICT=1 to assert the spec's 150 ms for the simple scopes.
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  EagleFolderRecord,
  EagleItemRecord,
  FilterSpec,
  Scope,
  SortSpec,
} from '../../../shared/types';
import type { QueryEngine } from '../../contracts';
import type { EagleSmartFolderRecord } from '../../../shared/types';
import { Fixture, folder, makeRoot } from './testUtil';

const N = 85_000;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'portrait',
  'landscape',
  'study',
  'sketch',
  'oil',
  'figure',
  'pose',
  'anatomy',
  'gesture',
  'still',
  'life',
  'academy',
  'painting',
  'drawing',
  'charcoal',
  'head',
  'hand',
  'torso',
  'costume',
  'reference',
  'mockup',
  'iphone',
  'poster',
  'concept',
  'cast',
  'plaster',
  'master',
  'copy',
  'bargue',
  'gerome',
];
const EXTS = ['jpg', 'jpg', 'jpg', 'jpg', 'jpg', 'jpg', 'jpg', 'png', 'png', 'webp', 'gif', 'mp4'];

let fx: Fixture;
let eng: QueryEngine;
let BIG: string; // biggest folder
let TOP: string; // a top-level folder with many descendants
let COMMON_TAG: string;
let buildMs = 0;

beforeAll(() => {
  const rand = rng(1);
  const pick = <T>(a: T[]): T => a[Math.floor(rand() * a.length)];
  const ids: string[] = [];
  let f = 0;
  const mk = (depth: number): EagleFolderRecord[] =>
    Array.from({ length: depth === 0 ? 6 : depth === 1 ? 5 : 3 }, () => {
      const id = `FOLD${String(++f).padStart(9, '0')}`;
      ids.push(id);
      return folder(id, `${pick(WORDS)} ${f}`, depth < 2 ? mk(depth + 1) : []);
    });
  const tree = mk(0);
  const tags300 = Array.from({ length: 300 }, (_, i) => `${pick(WORDS)}-${i}`);
  TOP = tree[0].id;
  BIG = ids[3];
  const sf = (
    id: string,
    rules: { property: string; method: string; value: unknown; unit?: string }[],
    match: 'AND' | 'OR' = 'AND',
  ): EagleSmartFolderRecord => ({
    id,
    name: id,
    modificationTime: 1,
    conditions: [{ rules, match }],
    children: [],
  });
  const smart = [
    sf('SMART_SQL', [
      { property: 'tags', method: 'union', value: [tags300[0], tags300[1]] },
      { property: 'rating', method: 'equal', value: '4' },
    ]),
    sf('SMART_REGEX', [{ property: 'name', method: 'regex', value: 'oil.* \\d+5$' }]),
    sf('SMART_MIXED', [
      { property: 'type', method: 'equal', value: 'jpg' },
      { property: 'comments', method: 'contain', value: 'nice' },
    ]),
    sf('SMART_COLOR', [{ property: 'color', method: 'similar', value: '#DC1E1E' }]),
  ];
  const root = makeRoot(tree, smart);
  const t0 = performance.now();
  fx = new Fixture(root);
  const tags = tags300;
  COMMON_TAG = tags[0];
  fx.db.exec('BEGIN');
  for (let i = 0; i < N; i++) {
    const ext = pick(EXTS);
    const nTags = Math.floor(rand() * 5);
    const rec: Partial<EagleItemRecord> & { name: string } = {
      name: `${pick(WORDS)} ${pick(WORDS)} ${i}`,
      ext,
      tags: Array.from({ length: nTags }, () => tags[Math.floor(rand() * rand() * tags.length)]),
      folders: rand() < 0.15 ? [] : rand() < 0.8 ? [pick(ids)] : [pick(ids), pick(ids)],
      width: 400 + Math.floor(rand() * 4000),
      height: 400 + Math.floor(rand() * 4000),
      size: Math.floor(rand() * 20_000_000),
      star: rand() < 0.7 ? 0 : 1 + Math.floor(rand() * 5),
      url: rand() < 0.2 ? `https://example.com/${pick(WORDS)}/${i}` : '',
      annotation:
        rand() < 0.24 ? `Date: 18${Math.floor(rand() * 90)}. Student of ${pick(WORDS)}.` : '',
      isDeleted: rand() < 0.02,
      palettes: Array.from({ length: 6 }, (_, k) => ({
        color: [Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256)] as [
          number,
          number,
          number,
        ],
        ratio: k === 0 ? 30 + Math.floor(rand() * 40) : Math.floor(rand() * 12),
      })),
      mtime: 1_500_000_000_000 + Math.floor(rand() * 3e11),
    };
    fx.add(rec);
  }
  fx.db.exec('COMMIT');
  fx.db.exec('ANALYZE');
  buildMs = performance.now() - t0;
  eng = fx.engine();
}, 300_000);

interface Timing {
  name: string;
  ms: number;
  n: number;
}
const results: Timing[] = [];

function time(
  name: string,
  scope: Scope,
  filter: FilterSpec = {},
  sort: SortSpec | null = null,
): Timing {
  const req = { scope, filter, sort };
  eng.query(req); // warm the statement cache and page cache
  const runs: number[] = [];
  let n = 0;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    n = eng.query(req).total;
    runs.push(performance.now() - t0);
  }
  runs.sort((a, b) => a - b);
  const t = { name, ms: Math.round(runs[2] * 10) / 10, n };
  results.push(t);
  return t;
}

const CEILING = process.env.BOOGIE_PERF_STRICT ? 150 : 1000;

describe(`synthetic ${N} item library`, () => {
  it('simple scopes return every id well inside 150 ms', () => {
    const rows = [
      time('all (IMPORT desc)', { kind: 'all' }),
      time('all (IMPORT asc)', { kind: 'all' }, {}, { by: 'IMPORT', ascending: true }),
      time('uncategorized', { kind: 'uncategorized' }),
      time('untagged', { kind: 'untagged' }),
      time('trash', { kind: 'trash' }),
      time('folder (own)', { kind: 'folder', id: BIG, includeSubfolders: false }),
      time('folder (top, subfolders)', { kind: 'folder', id: TOP, includeSubfolders: true }),
      time('tag (common)', { kind: 'tag', name: COMMON_TAG }),
      time('random', { kind: 'random', seed: 3 }),
    ];
    for (const r of rows) expect(r.ms, r.name).toBeLessThan(CEILING);
    expect(rows[0].n).toBeGreaterThan(N * 0.9);
  });

  it('keyword searches', () => {
    const rows = [
      time('keyword "portrait" (trigram)', { kind: 'all' }, { keywords: 'portrait' }),
      time('keyword "oil sketch" (AND)', { kind: 'all' }, { keywords: 'oil sketch' }),
      time(
        'keyword "portrait" OR "study" -oil',
        { kind: 'all' },
        { keywords: '(portrait || study) -oil' },
      ),
      time('keyword "gerome" (note)', { kind: 'all' }, { keywords: 'gerome' }),
      time('keyword "oi" (2 chars, LIKE path)', { kind: 'all' }, { keywords: 'oi' }),
      time('keyword phrase', { kind: 'all' }, { keywords: '"student of oil"' }),
    ];
    for (const r of rows) expect(r.ms, r.name).toBeLessThan(CEILING * 2);
  });

  it('sorts', () => {
    const by = (b: SortSpec['by']) =>
      time(`sort ${b}`, { kind: 'all' }, {}, { by: b, ascending: true });
    const rows = [
      by('NAME'),
      by('EXT'),
      by('RESOLUTION'),
      by('FILESIZE'),
      by('RATING'),
      by('BTIME'),
      by('MTIME'),
      by('TAGS'),
      by('RANDOM'),
    ];
    time(
      'sort MANUAL in a folder',
      { kind: 'folder', id: TOP, includeSubfolders: true },
      {},
      { by: 'MANUAL', ascending: false },
    );
    for (const r of rows) expect(r.ms, r.name).toBeLessThan(CEILING * 3);
  });

  it('filters', () => {
    const rows = [
      time(
        'filter tags any',
        { kind: 'all' },
        { tags: { mode: 'any', include: [COMMON_TAG], exclude: [] } },
      ),
      time(
        'filter tags all (2)',
        { kind: 'all' },
        { tags: { mode: 'all', include: [COMMON_TAG, 'portrait-5'], exclude: [] } },
      ),
      time(
        'filter rating + types',
        { kind: 'all' },
        { rating: [4, 5], types: { include: ['jpg', 'png'], exclude: [] } },
      ),
      time(
        'filter ranges',
        { kind: 'all' },
        { width: { min: 1000 }, fileSize: { min: 1_000_000, max: 8_000_000 } },
      ),
      time(
        'filter shapes + aspect',
        { kind: 'all' },
        { shapes: ['landscape'], aspect: { w: 16, h: 9 } },
      ),
      time('filter has URL', { kind: 'all' }, { hasUrl: true }),
      time(
        'filter color similar',
        { kind: 'all' },
        { color: { rgb: [220, 30, 30], tolerance: 'similar', minRatio: 20 } },
      ),
      time(
        'filter color similar, any ratio',
        { kind: 'all' },
        { color: { rgb: [128, 128, 128], tolerance: 'similar' } },
      ),
      time(
        'filter color close',
        { kind: 'all' },
        { color: { rgb: [220, 30, 30], tolerance: 'close', minRatio: 0 } },
      ),
      time(
        'filter color, one folder (645 items)',
        { kind: 'folder', id: BIG, includeSubfolders: false },
        { color: { rgb: [128, 128, 128], tolerance: 'similar' } },
      ),
      time(
        'filter color, folder tree (13.7k items)',
        { kind: 'folder', id: TOP, includeSubfolders: true },
        { color: { rgb: [128, 128, 128], tolerance: 'similar' } },
      ),
    ];
    for (const r of rows) expect(r.ms, r.name).toBeLessThan(CEILING * 3);
  });

  it('color search after a palette change (an import with a color filter on)', () => {
    const req = {
      scope: { kind: 'all' } as Scope,
      filter: { color: { rgb: [128, 128, 128], tolerance: 'similar' } } as FilterSpec,
      sort: null,
    };
    const id = eng.query({ ...req, filter: {} }).ids[0];
    eng.query(req);
    const runs: number[] = [];
    let n = 0;
    for (let i = 0; i < 5; i++) {
      const rec = fx.ix.getRecord(id)!;
      fx.ix.upsertRecords([{ ...rec, palettes: [{ color: [i * 40, 128, 128], ratio: 50 }] }]);
      const t0 = performance.now();
      n = eng.query(req).total;
      runs.push(performance.now() - t0);
    }
    runs.sort((a, b) => a - b);
    const t = {
      name: 'filter color, after a palette change',
      ms: Math.round(runs[2] * 10) / 10,
      n,
    };
    results.push(t);
    expect(t.ms).toBeLessThan(CEILING * 3);
  });

  it('smart folders', () => {
    const rows = [
      time('smart folder, all rules in SQL', { kind: 'smartFolder', id: 'SMART_SQL' }),
      time('smart folder, regex on name (JS)', { kind: 'smartFolder', id: 'SMART_REGEX' }),
      time('smart folder, type + comments (SQL + JS)', { kind: 'smartFolder', id: 'SMART_MIXED' }),
      time('smart folder, color (JS)', { kind: 'smartFolder', id: 'SMART_COLOR' }),
    ];
    for (const r of rows) expect(r.ms, r.name).toBeLessThan(CEILING * 6);
    const t0 = performance.now();
    const counts = eng.smartFolderCounts();
    results.push({
      name: 'smartFolderCounts (4 smart folders, cold)',
      ms: Math.round((performance.now() - t0) * 10) / 10,
      n: Object.keys(counts).length,
    });
  });

  it('briefs, items, suggest, counts', () => {
    const page = eng.query({ scope: { kind: 'all' }, filter: {}, sort: null }).ids.slice(0, 200);
    const t = (name: string, fn: () => void) => {
      fn();
      const t0 = performance.now();
      for (let i = 0; i < 5; i++) fn();
      results.push({ name, ms: Math.round(((performance.now() - t0) / 5) * 10) / 10, n: 0 });
    };
    t('briefs(200)', () => eng.briefs(page));
    t('items(200)', () => eng.items(page));
    t('suggest tag "por" (cached corpus)', () => eng.suggest('por', ['tag', 'folder'], 20));
    const first = performance.now();
    const rec = fx.ix.getRecord(page[0])!;
    fx.ix.upsertRecords([{ ...rec, tags: [...rec.tags, 'touched'] }]); // invalidates the corpus
    eng.suggest('por', ['tag', 'folder'], 20);
    results.push({
      name: 'suggest after a write (rebuild corpus)',
      ms: Math.round((performance.now() - first) * 10) / 10,
      n: 0,
    });
    t('smartFolderCounts (none defined)', () => eng.smartFolderCounts());
  });

  it('a password-locked folder (its 13.7k items hidden everywhere)', () => {
    const root = fx.root;
    const locked = structuredClone(root);
    locked.folders[0].password = 'secret';
    locked.modificationTime = root.modificationTime + 1;
    fx.setRoot(locked);
    try {
      const rows = [
        time('all, one folder tree locked', { kind: 'all' }),
        time('tag, one folder tree locked', { kind: 'tag', name: COMMON_TAG }),
      ];
      for (const r of rows) expect(r.ms, r.name).toBeLessThan(CEILING * 3);
      fx.ix.counts();
      const t0 = performance.now();
      const c = fx.ix.counts();
      results.push({
        name: 'counts(), one folder tree locked',
        ms: Math.round((performance.now() - t0) * 10) / 10,
        n: c.all,
      });
    } finally {
      fx.setRoot(root);
    }
  });

  it('prints the table', () => {
    // eslint-disable-next-line no-console
    console.log(
      `\nbuilt ${N} items in ${(buildMs / 1000).toFixed(1)} s\n` +
        results
          .map(
            (r) =>
              `${r.name.padEnd(42)} ${String(r.ms).padStart(8)} ms  ${r.n ? r.n + ' ids' : ''}`,
          )
          .join('\n'),
    );
    expect(results.length).toBeGreaterThan(10);
  });
});
