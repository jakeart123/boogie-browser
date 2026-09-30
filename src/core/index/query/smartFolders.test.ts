import { describe, expect, it } from 'vitest';
import type {
  EagleItemRecord,
  EagleSmartFolderRecord,
  SmartCondition,
  SmartRule,
} from '../../../shared/types';
import {
  compileSmartFolder,
  evaluateSmartFolder,
  findSmartFolder,
  flattenSmartFolders,
  normalizeSmartFolders,
} from './smartFolders';
import { Fixture, folder, makeRoot } from './testUtil';

const rule = (
  property: string,
  method: string,
  value: unknown,
  extra: Partial<SmartRule> = {},
): SmartRule => ({ property, method, value, ...extra });
const cond = (
  rules: SmartRule[],
  match: 'AND' | 'OR' = 'AND',
  boolean?: 'TRUE' | 'FALSE',
): SmartCondition => ({ rules, match, ...(boolean ? { boolean } : {}) });
const sf = (
  id: string,
  conditions: SmartCondition[],
  children: EagleSmartFolderRecord[] = [],
  extra: Partial<EagleSmartFolderRecord> = {},
): EagleSmartFolderRecord => ({
  id,
  name: id,
  modificationTime: 1,
  conditions,
  children,
  ...extra,
});
const rec = (p: Partial<EagleItemRecord> = {}): EagleItemRecord =>
  ({
    id: 'X',
    name: 'Item',
    size: 1000,
    btime: 0,
    mtime: 0,
    ext: 'png',
    tags: [],
    folders: [],
    isDeleted: false,
    url: '',
    annotation: '',
    modificationTime: 1_700_000_000_000,
    ...p,
  }) as EagleItemRecord;

/** Does one item satisfy a single rule (as a folder with one condition)? */
const one = (r: SmartRule, item: Partial<EagleItemRecord> = {}, ctx = {}): boolean =>
  evaluateSmartFolder(sf('S', [cond([r])]), [], rec(item), ctx);

describe('string rules', () => {
  it('lowercase both sides; empty value never matches except empty / not-empty', () => {
    expect(one(rule('name', 'contain', 'OIL'), { name: 'Oil Sketch' })).toBe(true);
    expect(one(rule('name', 'equal', 'oil sketch'), { name: 'Oil Sketch' })).toBe(true);
    expect(one(rule('name', 'uncontain', 'oil'), { name: 'Oil Sketch' })).toBe(false);
    expect(one(rule('name', 'contain', ''), { name: 'Oil Sketch' })).toBe(false);
    expect(one(rule('name', 'uncontain', ''), { name: 'Oil Sketch' })).toBe(false);
    expect(one(rule('annotation', 'empty', ''), { annotation: '' })).toBe(true);
    expect(one(rule('annotation', 'not-empty', ''), { annotation: 'x' })).toBe(true);
    expect(one(rule('url', 'contain', 'dribbble'), { url: 'https://Dribbble.com/x' })).toBe(true);
  });

  it('startWith / endWith use the value as a raw regex (a dot matches anything), like Eagle', () => {
    expect(one(rule('name', 'startWith', 'o.l'), { name: 'Oil Sketch' })).toBe(true);
    expect(one(rule('name', 'endWith', '\\d+'), { name: 'sketch 12' })).toBe(true);
  });

  it('an invalid startWith regex throws in Eagle and empties the whole folder: same here', () => {
    const folderWithBadRule = sf('S', [cond([rule('name', 'startWith', '(')])]);
    expect(evaluateSmartFolder(folderWithBadRule, [], rec({ name: '(anything' }))).toBe(false);
    // ...but a rule that is never reached because an earlier AND rule failed doesn't throw
    expect(
      evaluateSmartFolder(
        sf('S', [cond([rule('name', 'equal', 'nope'), rule('name', 'startWith', '(')])]),
        [],
        rec(),
      ),
    ).toBe(false);
  });

  it('regex lowercases the pattern too (so \\D means \\d) and an invalid pattern just does not match', () => {
    expect(one(rule('name', 'regex', 'sketch \\D'), { name: 'sketch 12' })).toBe(true); // \D became \d
    expect(one(rule('name', 'regex', 'sketch [A-Z]'), { name: 'sketch B' })).toBe(true); // [a-z] vs lowercased text
    expect(one(rule('name', 'regex', '('), { name: 'x' })).toBe(false);
  });

  it('folderName: any of the item folders; an item in no folder never matches, even with empty', () => {
    const names = new Map([
      ['F1', 'Portraits'],
      ['F2', 'Landscapes'],
    ]);
    const ctx = { folderName: (id: string) => names.get(id) };
    expect(one(rule('folderName', 'contain', 'port'), { folders: ['F2', 'F1'] }, ctx)).toBe(true);
    expect(one(rule('folderName', 'contain', 'port'), { folders: ['F2'] }, ctx)).toBe(false);
    expect(one(rule('folderName', 'empty', ''), { folders: [] }, ctx)).toBe(false);
  });

  it('comments: joined without a separator, case-sensitive, contain "" matches anything that has comments', () => {
    const c = (t: string) => ({ id: 'c', annotation: t, lastModified: 1 });
    const item = { comments: [c('Great'), c('colors')] };
    expect(one(rule('comments', 'contain', 'Greatcolors'), item)).toBe(true);
    expect(one(rule('comments', 'contain', 'great'), item)).toBe(false); // not lowercased
    expect(one(rule('comments', 'startWith', 'GREAT'), item)).toBe(true); // startWith has the i flag
    expect(one(rule('comments', 'contain', ''), item)).toBe(true);
    expect(one(rule('comments', 'uncontain', 'zzz'), {})).toBe(false); // no comments array fails everything but empty
    expect(one(rule('comments', 'empty', ''), {})).toBe(true);
    expect(one(rule('comments', 'empty', ''), { comments: [] })).toBe(true);
  });

  it('camera never matches without rawMetas.camera, even for empty', () => {
    expect(one(rule('camera', 'contain', 'canon'), { rawMetas: { camera: 'Canon EOS R5' } })).toBe(
      true,
    );
    expect(one(rule('camera', 'empty', ''), {})).toBe(false);
    expect(one(rule('camera', 'empty', ''), { rawMetas: { camera: '' } })).toBe(false); // an empty camera counts as missing
  });

  it('a method from another family never matches (Eagle can save these)', () => {
    expect(one(rule('comments', '>', [480, 0]), { comments: [] })).toBe(false);
    expect(one(rule('name', 'union', ['a']), { name: 'a' })).toBe(false);
  });
});

describe('numeric rules', () => {
  it('compare against value[0]; between is inclusive; missing data never matches', () => {
    expect(one(rule('width', '>', [500, 0]), { width: 600 })).toBe(true);
    expect(one(rule('width', '>', [500, 0]), { width: 500 })).toBe(false);
    expect(one(rule('width', '>=', [500, 0]), { width: 500 })).toBe(true);
    expect(one(rule('width', 'between', [500, 700]), { width: 700 })).toBe(true);
    expect(one(rule('width', '=', [500, 0]), { width: 500 })).toBe(true);
    expect(one(rule('height', '<', [500, 0]), {})).toBe(false);
  });

  it('fileSize is 1024-based (kb, else mb); duration converts s/m/h and skips zero durations', () => {
    expect(one(rule('fileSize', '>', [1, 0], { unit: 'mb' }), { size: 1_048_577 })).toBe(true);
    expect(one(rule('fileSize', '>', [1, 0], { unit: 'mb' }), { size: 1_048_576 })).toBe(false);
    expect(one(rule('fileSize', '<=', [2, 0], { unit: 'kb' }), { size: 2048 })).toBe(true);
    expect(one(rule('fileSize', '>', [1, 0]), { size: 2_000_000 })).toBe(true); // missing unit = mb
    expect(one(rule('duration', '<=', [2, 0], { unit: 'm' }), { duration: 120 })).toBe(true);
    expect(one(rule('duration', '<=', [1, 0], { unit: 'h' }), { duration: 3600 })).toBe(true);
    expect(one(rule('duration', '<=', [30, 0], { unit: 's' }), { duration: 0 })).toBe(false);
    expect(one(rule('duration', '<=', [30, 0], { unit: 's' }), {})).toBe(false);
  });

  it('raw camera fields: aperture/focal length take the first number, shutter the denominator', () => {
    const meta = {
      rawMetas: { isoSpeed: '400', aperture: 'f/2.8', focalLength: '50 mm', shutter: '1/200' },
    };
    expect(one(rule('iso', '>', [100, 0]), meta)).toBe(true);
    expect(one(rule('aperture', '<', [3, 0]), meta)).toBe(true);
    expect(one(rule('focalLength', '=', [50, 0]), meta)).toBe(true);
    expect(one(rule('shutter', '=', [200, 0]), meta)).toBe(true);
    expect(one(rule('shutter', '>', [0, 0]), { rawMetas: { shutter: '2' } })).toBe(false); // no slash: never
    expect(one(rule('iso', '>', [0, 0]), {})).toBe(false);
    expect(one(rule('bpm', '>=', [100, 0]), { bpm: 128 })).toBe(true);
    expect(one(rule('bpm', '>=', [100, 0]), {})).toBe(false);
  });
});

describe('date rules', () => {
  const day = (y: number, m: number, d: number, h = 0) => new Date(y, m, d, h).getTime(); // local time
  const at = (t: number) => ({ modificationTime: t });

  it('before and after include the chosen day; between includes both end days; on is a calendar day', () => {
    const d = day(2024, 0, 10);
    expect(one(rule('createTime', 'before', [d]), at(day(2024, 0, 10, 23)))).toBe(true); // same day, late evening
    expect(one(rule('createTime', 'before', [d]), at(day(2024, 0, 11, 1)))).toBe(false);
    expect(one(rule('createTime', 'after', [d]), at(day(2024, 0, 10, 1)))).toBe(true);
    expect(one(rule('createTime', 'after', [d]), at(day(2024, 0, 9, 23)))).toBe(false);
    expect(
      one(rule('createTime', 'between', [d, day(2024, 0, 12)]), at(day(2024, 0, 12, 20))),
    ).toBe(true);
    expect(one(rule('createTime', 'between', [d, day(2024, 0, 12)]), at(day(2024, 0, 13, 2)))).toBe(
      false,
    );
    expect(one(rule('createTime', 'on', [d]), at(day(2024, 0, 10, 15)))).toBe(true);
    expect(one(rule('createTime', 'on', [d]), at(day(2024, 0, 11, 0)))).toBe(false);
  });

  it('within is a rolling window of N x 24h, a half-filled rule never matches', () => {
    const now = day(2024, 5, 30, 12);
    expect(one(rule('createTime', 'within', [30]), at(now - 29 * 86_400_000), { now })).toBe(true);
    expect(one(rule('createTime', 'within', [30]), at(now - 31 * 86_400_000), { now })).toBe(false);
    expect(one(rule('createTime', 'before', []), at(1))).toBe(false);
    expect(one(rule('createTime', 'between', ''), at(1))).toBe(false);
  });

  it('mtime and btime fall back to the import time; createTime is the import time (modificationTime)', () => {
    const d = day(2024, 0, 10);
    expect(one(rule('mtime', 'after', [d]), { mtime: 0, modificationTime: day(2024, 0, 11) })).toBe(
      true,
    );
    expect(
      one(rule('mtime', 'after', [d]), {
        mtime: day(2023, 0, 1),
        modificationTime: day(2024, 0, 11),
      }),
    ).toBe(false);
    expect(one(rule('btime', 'before', [d]), { btime: day(2023, 5, 1) })).toBe(true);
    expect(
      one(rule('createTime', 'on', [day(2026, 5, 1)]), {
        modificationTime: String(day(2026, 5, 1, 9)) as unknown as number,
      }),
    ).toBe(true); // string dates exist
  });
});

describe('tags and folders (exact, case-sensitive, direct membership)', () => {
  it('union = any, intersection = all, equal = same set size, identity = none of', () => {
    const item = { tags: ['oil', 'sketch'] };
    expect(one(rule('tags', 'union', ['oil', 'x']), item)).toBe(true);
    expect(one(rule('tags', 'union', ['Oil']), item)).toBe(false);
    expect(one(rule('tags', 'intersection', ['oil', 'sketch']), item)).toBe(true);
    expect(one(rule('tags', 'intersection', ['oil', 'x']), item)).toBe(false);
    expect(one(rule('tags', 'equal', ['sketch', 'oil']), item)).toBe(true);
    expect(one(rule('tags', 'equal', ['oil']), item)).toBe(false);
    expect(one(rule('tags', 'identity', ['x', 'y']), item)).toBe(true); // "Excludes": has none of these
    expect(one(rule('tags', 'identity', ['oil']), item)).toBe(false);
    expect(one(rule('tags', 'empty', []), { tags: [] })).toBe(true);
    expect(one(rule('tags', 'not-empty', []), item)).toBe(true);
  });

  it('an empty list: tags/intersection and tags/equal never match, folders/intersection matches everything', () => {
    expect(one(rule('tags', 'intersection', []), { tags: ['a'] })).toBe(false);
    expect(one(rule('tags', 'equal', []), { tags: [] })).toBe(false); // Eagle builds equal on intersection, which needs a non-empty list
    expect(one(rule('folders', 'equal', []), { folders: [] })).toBe(true); // ...but not for folders
    expect(one(rule('folders', 'intersection', []), { folders: ['a'] })).toBe(true);
    expect(one(rule('folders', 'union', ['F1']), { folders: ['F1'] })).toBe(true);
  });

  it('a record without the field fails every method, empty included', () => {
    const noTags = { tags: undefined } as unknown as Partial<EagleItemRecord>;
    expect(one(rule('tags', 'empty', []), noTags)).toBe(false);
    expect(one(rule('tags', 'identity', ['x']), noTags)).toBe(false);
  });
});

describe('type, rating, shape, color', () => {
  it('type: exact extension, groups, bookmark media, unequal negates', () => {
    expect(one(rule('type', 'equal', 'png'), { ext: 'png' })).toBe(true);
    expect(one(rule('type', 'unequal', 'png'), { ext: 'png' })).toBe(false);
    expect(one(rule('type', 'equal', 'video'), { ext: 'mkv' })).toBe(true);
    expect(one(rule('type', 'equal', 'audio'), { ext: 'flac' })).toBe(true);
    expect(one(rule('type', 'equal', 'word'), { ext: 'docx' })).toBe(true);
    expect(one(rule('type', 'unequal', 'font'), { ext: 'png' })).toBe(true);
    expect(one(rule('type', 'equal', 'url'), { ext: 'url' })).toBe(true);
    // Eagle checks ext === value first, so "url" also catches bookmarks that have a medium
    expect(one(rule('type', 'equal', 'url'), { ext: 'url', medium: 'youtube' })).toBe(true);
    expect(one(rule('type', 'equal', 'youtube'), { ext: 'url', medium: 'vimeo' })).toBe(false);
    expect(one(rule('type', 'equal', 'youtube'), { ext: 'url', medium: 'youtube' })).toBe(true);
    expect(one(rule('type', 'equal', 'constructor'), { ext: 'png' })).toBe(false); // group lookup ignores Object.prototype
  });

  it('rating: none = unrated; contain is a substring test and "none" matches everything', () => {
    expect(one(rule('rating', 'equal', '5'), { star: 5 })).toBe(true);
    expect(one(rule('rating', 'equal', 'none'), {})).toBe(true);
    expect(one(rule('rating', 'equal', 'none'), { star: 2 })).toBe(false);
    expect(one(rule('rating', 'unequal', '3'), { star: 4 })).toBe(true);
    expect(one(rule('rating', 'contain', '345'), { star: 4 })).toBe(true);
    expect(one(rule('rating', 'contain', '345'), { star: 2 })).toBe(false);
    expect(one(rule('rating', 'contain', '1none'), { star: 2 })).toBe(true); // the Eagle bug we copy
    // Eagle reads the value with parseInt and treats junk and 0 as "unrated"
    expect(one(rule('rating', 'equal', ''), {})).toBe(true);
    expect(one(rule('rating', 'equal', '0'), { star: 3 })).toBe(false);
    // an unrated item has no digit to find in the text, only "none" reaches it
    expect(one(rule('rating', 'contain', '012345'), {})).toBe(false);
    expect(one(rule('rating', 'contain', 'none'), {})).toBe(true);
  });

  it('shape: exclusive; panoramic from 2.5:1; Eagle quirks with missing sizes', () => {
    const w = (width: number, height: number) => ({ width, height });
    expect(one(rule('shape', 'equal', 'landscape'), w(2000, 1000))).toBe(true);
    expect(one(rule('shape', 'equal', 'landscape'), w(2500, 1000))).toBe(false);
    expect(one(rule('shape', 'equal', 'panoramic-landscape'), w(2500, 1000))).toBe(true);
    expect(one(rule('shape', 'equal', 'panoramic-portrait'), w(1000, 2500))).toBe(true);
    expect(one(rule('shape', 'equal', 'square'), w(500, 500))).toBe(true);
    expect(one(rule('shape', 'equal', 'square'), w(500, 501))).toBe(false);
    expect(one(rule('shape', 'equal', 'custom', { width: 16, height: 9 }), w(1920, 1080))).toBe(
      true,
    );
    expect(one(rule('shape', 'equal', 'custom', { width: 0, height: 9 }), w(1920, 1080))).toBe(
      false,
    );
    expect(one(rule('shape', 'equal', 'landscape'), {})).toBe(false);
    expect(one(rule('shape', 'unequal', 'landscape'), {})).toBe(true);
    // Eagle compares the raw fields: no width and no height is undefined === undefined, which is "square"
    expect(one(rule('shape', 'equal', 'square'), {})).toBe(true);
    expect(one(rule('shape', 'equal', 'square'), { width: 100 })).toBe(false); // only one side: no shape at all
    // a custom ratio with a missing number is false for both methods
    expect(one(rule('shape', 'unequal', 'custom', { height: 9 }), w(1920, 1080))).toBe(false);
    expect(one(rule('shape', 'unequal', 'custom', { width: 4, height: 3 }), w(1920, 1080))).toBe(
      true,
    );
    // a zero side divides to Infinity: that is panoramic
    expect(one(rule('shape', 'equal', 'panoramic-portrait'), w(0, 50))).toBe(true);
    expect(one(rule('shape', 'equal', 'panoramic-landscape'), w(50, 0))).toBe(true);
  });

  it('color (smart folder version): first swatch must cover 33%+; exact or near match on the first two', () => {
    const sw = (r: number, g: number, b: number, ratio: number) => ({
      color: [r, g, b] as [number, number, number],
      ratio,
    });
    const red = { palettes: [sw(220, 30, 30, 60), sw(240, 240, 240, 40)] };
    expect(one(rule('color', 'similar', '#DC1E1E'), red)).toBe(true); // exact
    expect(one(rule('color', 'similar', '#D82020'), red)).toBe(true); // near
    expect(one(rule('color', 'accuracy', '#0000FF'), red)).toBe(false);
    expect(one(rule('color', 'similar', '#DC1E1E'), { palettes: [sw(220, 30, 30, 20)] })).toBe(
      false,
    ); // under 33%
    expect(one(rule('color', 'similar', '#DC1E1E'), {})).toBe(false);
    expect(one(rule('color', 'grayscale', ''), { palettes: [sw(100, 102, 99, 90)] })).toBe(true);
    expect(one(rule('color', 'grayscale', ''), red)).toBe(false);
  });

  it('color works on whole-number Lab values, like Eagle: a borderline pair lands on the same side', () => {
    const sw = (r: number, g: number, b: number, ratio: number) => ({
      color: [r, g, b] as [number, number, number],
      ratio,
    });
    // (220,30,30) vs (204,0,56): CIEDE2000 is 9.973 on exact Lab but 10.008 on Eagle's rounded Lab
    const near = { palettes: [sw(204, 0, 56, 60), sw(240, 240, 240, 40)] };
    expect(one(rule('color', 'accuracy', '#DC1E1E'), near)).toBe(false); // needs < 10
    expect(one(rule('color', 'similar', '#DC1E1E'), near)).toBe(true);
    // the exact-color shortcut needs a second swatch to exist; with one swatch at exactly 33% it falls through
    expect(one(rule('color', 'similar', '#DC1E1E'), { palettes: [sw(220, 30, 30, 33)] })).toBe(
      false,
    );
    expect(
      one(rule('color', 'similar', '#DC1E1E'), {
        palettes: [sw(220, 30, 30, 33), sw(1, 1, 1, 10)],
      }),
    ).toBe(true);
  });
});

describe('conditions and the folder tree', () => {
  const item = rec({ name: 'oil sketch', tags: ['oil'], width: 800, height: 600 });

  it('match AND vs OR; anything else behaves like AND; zero rules always match', () => {
    const r1 = rule('name', 'contain', 'oil');
    const r2 = rule('name', 'contain', 'zzz');
    const ev = (c: SmartCondition) => evaluateSmartFolder(sf('S', [c]), [], item);
    expect(ev(cond([r1, r2], 'AND'))).toBe(false);
    expect(ev(cond([r1, r2], 'OR'))).toBe(true);
    expect(ev({ rules: [r1, r2], match: 'nonsense' as 'AND' })).toBe(false);
    expect(ev(cond([]))).toBe(true);
  });

  it('with a missing or odd match Eagle evaluates every rule (no early exit), so a later bad rule still empties the folder', () => {
    const fails = rule('name', 'equal', 'nope');
    const bad = rule('nonsense', 'equal', 'x');
    const negated = (match: SmartCondition['match'] | undefined) =>
      evaluateSmartFolder(
        sf('S', [{ rules: [fails, bad], match: match as 'AND', boolean: 'FALSE' }]),
        [],
        item,
      );
    expect(negated('AND')).toBe(true); // AND stops at the first failing rule; FALSE flips it
    expect(negated(undefined)).toBe(false); // the bad rule is reached and throws
    expect(negated('XOR' as 'AND')).toBe(false);
  });

  it('boolean FALSE negates the whole condition', () => {
    const r1 = rule('tags', 'union', ['oil']);
    expect(evaluateSmartFolder(sf('S', [cond([r1], 'AND', 'FALSE')]), [], item)).toBe(false);
    expect(
      evaluateSmartFolder(sf('S', [cond([r1], 'AND', 'FALSE')]), [], rec({ tags: ['other'] })),
    ).toBe(true);
    expect(evaluateSmartFolder(sf('S', [cond([], 'AND', 'FALSE')]), [], item)).toBe(false); // empty condition is true, negated
  });

  it('several conditions are ANDed', () => {
    const c1 = cond([rule('name', 'contain', 'oil')]);
    const c2 = cond([rule('width', '>', [1000, 0])]);
    expect(evaluateSmartFolder(sf('S', [c1, c2]), [], item)).toBe(false);
    expect(evaluateSmartFolder(sf('S', [c1]), [], item)).toBe(true);
  });

  it('a child narrows its parent: the item must pass both', () => {
    const parent = sf(
      'P',
      [cond([rule('type', 'equal', 'jpg')])],
      [sf('C', [cond([rule('width', '>', [1000, 0])])])],
    );
    const child = parent.children![0];
    const wideJpg = rec({ ext: 'jpg', width: 2000 });
    const wideRaw = rec({ ext: 'png', width: 2000 });
    const narrowJpg = rec({ ext: 'jpg', width: 500 });
    expect(evaluateSmartFolder(child, [parent], wideJpg)).toBe(true);
    expect(evaluateSmartFolder(child, [parent], wideRaw)).toBe(false); // fails the parent
    expect(evaluateSmartFolder(child, [parent], narrowJpg)).toBe(false); // fails itself
    expect(evaluateSmartFolder(parent, [], narrowJpg)).toBe(true);
  });

  it('a folder without conditions is a group: the union of its children (still narrowed by its own parents)', () => {
    const group = sf(
      'G',
      [],
      [
        sf('A', [cond([rule('name', 'contain', 'oil')])]),
        sf('B', [cond([rule('name', 'contain', 'ink')])]),
      ],
    );
    expect(evaluateSmartFolder(group, [], rec({ name: 'oil study' }))).toBe(true);
    expect(evaluateSmartFolder(group, [], rec({ name: 'ink study' }))).toBe(true);
    expect(evaluateSmartFolder(group, [], rec({ name: 'pencil' }))).toBe(false);
    expect(evaluateSmartFolder(sf('E', []), [], rec())).toBe(false); // an empty group holds nothing
    const top = sf('T', [cond([rule('type', 'equal', 'jpg')])], [group]);
    expect(evaluateSmartFolder(group, [top], rec({ name: 'oil study', ext: 'png' }))).toBe(false);
    expect(evaluateSmartFolder(group, [top], rec({ name: 'oil study', ext: 'jpg' }))).toBe(true);
  });

  it('a group nested in a group has no conditions and so passes what its ancestors pass (Eagle)', () => {
    const inner = sf('IN', []); // a group with no children of its own
    const outer = sf('OUT', [], [inner]);
    expect(evaluateSmartFolder(outer, [], rec())).toBe(true); // opened from the top: the child passes everything
    expect(evaluateSmartFolder(inner, [outer], rec())).toBe(false); // opened directly: an empty group holds nothing
    const top = sf('T', [cond([rule('type', 'equal', 'jpg')])], [outer]);
    expect(evaluateSmartFolder(outer, [top], rec({ ext: 'png' }))).toBe(false);
    expect(evaluateSmartFolder(outer, [top], rec({ ext: 'jpg' }))).toBe(true);
  });

  it('trashed items are never in a smart folder; an unknown property empties the folder', () => {
    expect(evaluateSmartFolder(sf('S', []), [], rec({ isDeleted: true }))).toBe(false);
    expect(
      evaluateSmartFolder(
        sf('S', [cond([rule('name', 'contain', 'oil')])]),
        [],
        rec({ name: 'oil', isDeleted: true }),
      ),
    ).toBe(false);
    expect(one(rule('nonsense', 'equal', 'x'), { name: 'x' })).toBe(false);
    expect(
      evaluateSmartFolder(
        sf('S', [cond([rule('nonsense', 'equal', 'x'), rule('name', 'equal', 'x')], 'OR')]),
        [],
        rec({ name: 'x' }),
      ),
    ).toBe(false); // throws before reaching the true rule
  });

  it('reads old top-level records (set + rules) and tolerates missing fields', () => {
    const tree = normalizeSmartFolders([
      { id: 'OLD1', name: 'old and', set: 'intersection', rules: [rule('name', 'contain', 'a')] },
      {
        id: 'OLD2',
        name: 'old or',
        set: 'union',
        rules: [rule('name', 'contain', 'a')],
        children: [{ id: 'KID', name: 'kid' }],
      },
      { name: 'no id, dropped' },
      'junk',
    ]);
    expect(tree.map((n) => n.id)).toEqual(['OLD1', 'OLD2']);
    expect(tree[0].conditions).toEqual([{ rules: [rule('name', 'contain', 'a')], match: 'AND' }]);
    expect(tree[1].conditions[0].match).toBe('OR');
    expect(tree[1].children![0]).toMatchObject({ id: 'KID', conditions: [], children: [] });
    expect(normalizeSmartFolders(undefined)).toEqual([]);
    expect(flattenSmartFolders(tree).map((e) => e.path)).toEqual([
      'old and',
      'old or',
      'old or / kid',
    ]);
    expect(findSmartFolder(tree, 'KID')!.ancestors.map((a) => a.id)).toEqual(['OLD2']);
  });
});

// ──────────────── SQL and the evaluator must agree ────────────────

describe('compiled SQL agrees with the evaluator', () => {
  const H = 3_600_000;
  const T0 = new Date(2024, 0, 10, 12).getTime(); // local noon
  const mid = (y: number, m: number, d: number) => new Date(y, m, d).getTime();
  const FA = 'FA0000000001';
  const FB = 'FB0000000001';

  const items: (Partial<EagleItemRecord> & { name: string })[] = [
    {
      name: 'Oil Sketch 2',
      ext: 'jpg',
      width: 800,
      height: 600,
      size: 2_500_000,
      star: 5,
      tags: ['oil', 'sketch'],
      folders: [FA],
      url: 'https://dribbble.com/x',
      annotation: 'Student of Gérôme',
      mtime: T0 - 400 * 24 * H,
      palettes: [
        { color: [220, 30, 30], ratio: 60 },
        { color: [240, 240, 240], ratio: 40 },
      ],
      comments: [{ id: 'c1', annotation: 'Nice work', lastModified: 1 }],
    },
    {
      name: 'oil sketch 10',
      ext: 'jpg',
      width: 1200,
      height: 900,
      size: 900,
      star: 0,
      tags: ['sketch'],
      folders: [FA, FB],
      btime: T0 - 100 * 24 * H,
    },
    { name: 'Drawing', width: 500, height: 500, size: 4096, star: 3, tags: [], folders: [] },
    {
      name: 'Wide',
      width: 3000,
      height: 1000,
      size: 1_500_000,
      star: 4,
      tags: ['photo'],
      folders: [FB],
      palettes: [
        { color: [10, 10, 10], ratio: 50 },
        { color: [200, 200, 200], ratio: 30 },
      ],
    },
    {
      name: 'Tall',
      ext: 'jpg',
      width: 1000,
      height: 3000,
      star: 1,
      tags: ['photo', 'oil'],
      palettes: [{ color: [20, 30, 200], ratio: 70 }],
    },
    { name: 'Song', ext: 'mp3', duration: 125, bpm: 128, size: 4_000_000, tags: ['audio'] },
    {
      name: 'Short clip',
      ext: 'mp4',
      width: 1920,
      height: 1080,
      duration: 12.5,
      tags: ['video'],
      star: 2,
    },
    {
      name: 'Long film',
      ext: 'mkv',
      width: 1280,
      height: 720,
      duration: 7300,
      tags: ['video', 'oil'],
    },
    { name: 'Zero dur', ext: 'mov', duration: 0, tags: ['video'] },
    { name: 'Font', ext: 'ttf', tags: ['font'] },
    {
      name: 'Bookmark',
      ext: 'url',
      medium: 'youtube',
      url: 'https://youtube.com/watch',
    } as Partial<EagleItemRecord> & { name: string },
    { name: 'Bookmark2', ext: 'url' },
    {
      name: 'RAW photo',
      ext: 'cr2',
      width: 6000,
      height: 4000,
      rawMetas: {
        camera: 'Canon EOS R5',
        isoSpeed: '400',
        aperture: 'f/2.8',
        focalLength: '50 mm',
        shutter: '1/200',
        timestamp: String(T0),
      },
    } as Partial<EagleItemRecord> & { name: string },
    {
      name: 'RAW photo 2',
      ext: 'nef',
      width: 6000,
      height: 4000,
      rawMetas: {
        camera: 'Nikon Z9',
        isoSpeed: '100',
        aperture: '5.6',
        focalLength: '24',
        shutter: '2',
        timestamp: String(T0 + 30 * 24 * H),
      },
    } as Partial<EagleItemRecord> & { name: string },
    { name: 'Trashed', tags: ['oil'], isDeleted: true, width: 900, height: 900 },
    { name: 'UPPER NAME', tags: ['Oil'] },
    { name: 'No dims', ext: 'pdf', size: 0 },
    {
      name: 'Comment only',
      comments: [
        { id: 'c2', annotation: 'Great', lastModified: 1 },
        { id: 'c3', annotation: 'colors', lastModified: 1 },
      ],
    },
    { name: 'Empty comments', comments: [] },
    { name: 'Square', width: 1000, height: 1000 },
    { name: 'Almost panoramic', ext: 'jpg', width: 2500, height: 1000 },
    { name: 'Tall panoramic', width: 1000, height: 2500 },
    { name: 'Sixteen nine', width: 1600, height: 900 },
    { name: 'École', ext: 'gif', annotation: 'ÉCOLE de Paris', tags: ['étude'] },
    { name: 'Zero wide', width: 0, height: 40 },
    { name: 'Zero tall', width: 40, height: 0 },
    { name: 'Only width', width: 40 },
  ];

  // [label, rule, does SQL express it exactly?]
  const R = (label: string, r: SmartRule, sql: boolean) => [label, r, sql] as const;
  const rules = [
    R('name contain', rule('name', 'contain', 'OIL'), true),
    R('name contain (no match)', rule('name', 'contain', 'zzz'), true),
    R('name contain empty', rule('name', 'contain', ''), true),
    R('name equal', rule('name', 'equal', 'oil sketch 10'), true),
    R('name uncontain', rule('name', 'uncontain', 'sketch'), true),
    R('name empty', rule('name', 'empty', ''), true),
    R('name not-empty', rule('name', 'not-empty', ''), true),
    R('name startWith', rule('name', 'startWith', 'oil'), false),
    R('name endWith', rule('name', 'endWith', '\\d+'), false),
    R('name regex', rule('name', 'regex', 'sketch \\d'), false),
    R('name non-ascii value', rule('name', 'contain', 'école'), false),
    R('name wrong-family method', rule('name', 'union', ['a']), true),
    R('url contain', rule('url', 'contain', 'dribbble'), true),
    R('url empty', rule('url', 'empty', ''), true),
    R('annotation contain', rule('annotation', 'contain', 'student'), true),
    R('annotation not-empty', rule('annotation', 'not-empty', ''), true),
    R('folderName contain', rule('folderName', 'contain', 'ports'), false),
    R('comments contain', rule('comments', 'contain', 'Nice'), false),
    R('comments empty', rule('comments', 'empty', ''), false),
    R('camera contain', rule('camera', 'contain', 'canon'), false),
    R('width >', rule('width', '>', [1000, 0]), true),
    R('width >=', rule('width', '>=', [1000, 0]), true),
    R('width <', rule('width', '<', [800, 0]), true),
    R('width <=', rule('width', '<=', [800, 0]), true),
    R('width =', rule('width', '=', [800, 0]), true),
    R('width between', rule('width', 'between', [800, 1200]), true),
    R('height >', rule('height', '>', [900, 0]), true),
    R('fileSize mb', rule('fileSize', '>', [1, 0], { unit: 'mb' }), true),
    R('fileSize kb', rule('fileSize', 'between', [1, 5], { unit: 'kb' }), true),
    R('duration s', rule('duration', '<=', [30, 0], { unit: 's' }), true),
    R('duration m', rule('duration', '>', [2, 0], { unit: 'm' }), true),
    R('duration h', rule('duration', '>=', [2, 0], { unit: 'h' }), true),
    R('bpm', rule('bpm', '>=', [100, 0]), false),
    R('iso', rule('iso', '>', [100, 0]), false),
    R('aperture', rule('aperture', '<', [3, 0]), false),
    R('focalLength', rule('focalLength', '>=', [50, 0]), false),
    R('shutter', rule('shutter', '=', [200, 0]), false),
    R('createTime before', rule('createTime', 'before', [mid(2024, 0, 12)]), true),
    R('createTime after', rule('createTime', 'after', [mid(2024, 0, 12)]), true),
    R(
      'createTime between',
      rule('createTime', 'between', [mid(2024, 0, 11), mid(2024, 0, 13)]),
      true,
    ),
    R('createTime on', rule('createTime', 'on', [mid(2024, 0, 12)]), true),
    R('createTime within (huge)', rule('createTime', 'within', [5000]), true),
    R('createTime within (small)', rule('createTime', 'within', [30]), true),
    R('createTime unfinished', rule('createTime', 'before', []), true),
    R('mtime before', rule('mtime', 'before', [mid(2023, 0, 1)]), true),
    R('mtime after', rule('mtime', 'after', [mid(2024, 0, 12)]), true),
    R('btime before', rule('btime', 'before', [mid(2023, 11, 1)]), true),
    R('timestamp after', rule('timestamp', 'after', [mid(2024, 0, 12)]), false),
    R('tags union', rule('tags', 'union', ['oil', 'font']), true),
    R('tags union empty list', rule('tags', 'union', []), true),
    R('tags intersection', rule('tags', 'intersection', ['oil', 'sketch']), true),
    R('tags intersection empty', rule('tags', 'intersection', []), true),
    R('tags equal', rule('tags', 'equal', ['sketch', 'oil']), true),
    R('tags equal empty', rule('tags', 'equal', []), true),
    R('folders equal empty', rule('folders', 'equal', []), false),
    R('tags equal repeated values', rule('tags', 'equal', ['oil', 'oil']), false),
    R('tags identity', rule('tags', 'identity', ['oil']), true),
    R('tags identity empty list', rule('tags', 'identity', []), true),
    R('tags empty', rule('tags', 'empty', []), true),
    R('tags not-empty', rule('tags', 'not-empty', []), true),
    R('folders union', rule('folders', 'union', [FA]), false),
    R('folders empty', rule('folders', 'empty', []), false),
    R('type equal ext', rule('type', 'equal', 'jpg'), true),
    R('type unequal ext', rule('type', 'unequal', 'png'), true),
    R('type equal video', rule('type', 'equal', 'video'), true),
    R('type unequal audio', rule('type', 'unequal', 'audio'), true),
    R('type equal url', rule('type', 'equal', 'url'), false),
    R('type equal youtube', rule('type', 'equal', 'youtube'), false),
    R('rating equal 5', rule('rating', 'equal', '5'), true),
    R('rating equal none', rule('rating', 'equal', 'none'), true),
    R('rating unequal 3', rule('rating', 'unequal', '3'), true),
    R('rating contain 345', rule('rating', 'contain', '345'), true),
    R('rating contain none', rule('rating', 'contain', 'x none'), true),
    R('rating equal junk', rule('rating', 'equal', 'zzz'), true),
    R('rating contain digits', rule('rating', 'contain', '0123'), true),
    R('shape landscape', rule('shape', 'equal', 'landscape'), true),
    R('shape panoramic-landscape', rule('shape', 'equal', 'panoramic-landscape'), true),
    R('shape portrait', rule('shape', 'equal', 'portrait'), true),
    R('shape panoramic-portrait', rule('shape', 'equal', 'panoramic-portrait'), true),
    R('shape square', rule('shape', 'equal', 'square'), true),
    R('shape unequal square', rule('shape', 'unequal', 'square'), true),
    R('shape custom', rule('shape', 'equal', 'custom', { width: 16, height: 9 }), false),
    R('shape custom unequal', rule('shape', 'unequal', 'custom', { width: 16 }), false),
    R('color similar', rule('color', 'similar', '#DC1E1E'), false),
    R('color accuracy', rule('color', 'accuracy', '#0000FF'), false),
    R('color grayscale', rule('color', 'grayscale', ''), false),
    R('fontActivated', rule('fontActivated', 'activate', ''), false),
    R('unknown property', rule('nonsense', 'equal', 'x'), false),
  ];

  // Combinations: OR, a negated condition, several conditions, nested child + parent.
  const combos: [string, EagleSmartFolderRecord][] = [
    [
      'OR of two rules',
      sf('C1', [cond([rule('name', 'contain', 'oil'), rule('tags', 'union', ['video'])], 'OR')]),
    ],
    ['negated condition', sf('C2', [cond([rule('tags', 'union', ['oil'])], 'AND', 'FALSE')])],
    [
      'negated OR',
      sf('C3', [cond([rule('type', 'equal', 'jpg'), rule('type', 'equal', 'mp4')], 'OR', 'FALSE')]),
    ],
    [
      'two conditions',
      sf('C4', [cond([rule('type', 'equal', 'jpg')]), cond([rule('width', '>', [900, 0])])]),
    ],
    [
      'mixed exact and JS rules',
      sf('C5', [cond([rule('type', 'equal', 'jpg'), rule('name', 'regex', 'sketch')])]),
    ],
    [
      'child and parent',
      sf(
        'C6',
        [cond([rule('type', 'equal', 'jpg')])],
        [sf('C6K', [cond([rule('name', 'regex', 'sketch')])])],
      ),
    ],
    [
      'group of children',
      sf(
        'C7',
        [],
        [
          sf('C7A', [cond([rule('tags', 'union', ['video'])])]),
          sf('C7B', [cond([rule('name', 'startWith', 'oil')])]),
        ],
      ),
    ],
    ['empty condition', sf('C8', [cond([])])],
    [
      'nested group',
      sf('C9', [cond([rule('type', 'equal', 'jpg')])], [sf('C9G', [], [sf('C9GG', [])])]),
    ],
    [
      'odd match keeps evaluating',
      sf('C10', [
        {
          rules: [rule('name', 'equal', 'nope'), rule('nonsense', 'equal', 'x')],
          match: undefined as unknown as 'AND',
          boolean: 'FALSE',
        },
      ]),
    ],
  ];

  const nodes: EagleSmartFolderRecord[] = [
    ...rules.map(([label], i) => sf(`R${i}`, [cond([rules[i][1]])], [], { name: label })),
    ...combos.map(([, node]) => node),
  ];

  const fx = new Fixture(makeRoot([folder(FA, 'Portraits'), folder(FB, 'Faces')], nodes));
  const records = items.map((it, k) => fx.add({ modificationTime: T0 + k * 17 * H, ...it }));
  const eng = fx.engine();
  const names = new Map([
    [FA, 'Portraits'],
    [FB, 'Faces'],
  ]);
  const ctx = { folderName: (id: string) => names.get(id) };

  const expectedFor = (node: EagleSmartFolderRecord, ancestors: EagleSmartFolderRecord[] = []) =>
    records
      .filter((r) => evaluateSmartFolder(node, ancestors, r, { ...ctx, now: Date.now() }))
      .map((r) => r.id)
      .sort();
  const engineFor = (id: string) =>
    eng.query({ scope: { kind: 'smartFolder', id }, filter: {}, sort: null }).ids.sort();

  it.each(rules.map(([label], i) => [label, i] as const))('%s', (label, i) => {
    const node = nodes[i];
    const compiled = compileSmartFolder(node, [], Date.now());
    expect(compiled.exact, `${label} exactness`).toBe(rules[i][2]);
    expect(engineFor(node.id)).toEqual(expectedFor(node));
  });

  it.each(combos.map(([label, node]) => [label, node] as const))('%s', (_label, node) => {
    expect(engineFor(node.id)).toEqual(expectedFor(node));
    for (const { node: n, ancestors } of flattenSmartFolders([node]))
      expect(engineFor(n.id)).toEqual(expectedFor(n, ancestors));
  });

  it('the rules matched something (the matrix is not vacuous)', () => {
    const nonEmpty = nodes.filter((n) => engineFor(n.id).length > 0).length;
    expect(nonEmpty).toBeGreaterThan(nodes.length * 0.7);
  });

  it('smartFolderCounts counts live matches, 0 for a group, and includes ancestors', () => {
    const counts = eng.smartFolderCounts();
    for (const { node, ancestors } of flattenSmartFolders(nodes)) {
      const isGroup = (node.conditions ?? []).length === 0;
      expect(counts[node.id], node.id).toBe(isGroup ? 0 : expectedFor(node, ancestors).length);
    }
    expect(counts.C6K).toBeLessThan(counts.C6 + 1); // a child never holds more than its parent
  });

  it('never returns trashed items', () => {
    const trashed = records.find((r) => r.isDeleted)!.id;
    for (const n of nodes) expect(engineFor(n.id)).not.toContain(trashed);
  });
});

describe('smart folder scope in the engine', () => {
  it('own sort: sortIncrease is Eagle-style, so IMPORT with sortIncrease true is newest first', () => {
    const fx = new Fixture(
      makeRoot(
        [],
        [
          sf('S1', [cond([rule('name', 'contain', 'a')])], [], {
            orderBy: 'NAME',
            sortIncrease: true,
          }),
          sf('S2', [cond([rule('name', 'contain', 'a')])], [], {
            orderBy: 'IMPORT',
            sortIncrease: false,
          }),
        ],
      ),
    );
    fx.add({ name: 'b a' });
    fx.add({ name: 'a a' });
    const eng = fx.engine();
    expect(eng.defaultSort({ kind: 'smartFolder', id: 'S1' })).toEqual({
      by: 'NAME',
      ascending: true,
    });
    expect(eng.defaultSort({ kind: 'smartFolder', id: 'S2' })).toEqual({
      by: 'IMPORT',
      ascending: true,
    });
    const names = (id: string) =>
      eng
        .briefs(eng.query({ scope: { kind: 'smartFolder', id }, filter: {}, sort: null }).ids)
        .map((b) => b.name);
    expect(names('S1')).toEqual(['a a', 'b a']);
    expect(names('S2')).toEqual(['b a', 'a a']); // oldest first
  });

  it('filters and other scopes still combine with a smart folder; an unknown id is empty', () => {
    const fx = new Fixture(makeRoot([], [sf('S1', [cond([rule('name', 'regex', 'oil')])])]));
    fx.add({ name: 'oil one', star: 5 });
    fx.add({ name: 'oil two', star: 1 });
    fx.add({ name: 'ink' });
    const eng = fx.engine();
    const q = (id: string, rating?: number[]) =>
      eng
        .briefs(
          eng.query({
            scope: { kind: 'smartFolder', id },
            filter: { rating },
            sort: { by: 'NAME', ascending: true },
          }).ids,
        )
        .map((b) => b.name);
    expect(q('S1')).toEqual(['oil one', 'oil two']);
    expect(q('S1', [5])).toEqual(['oil one']);
    expect(q('nope')).toEqual([]);
  });

  it('counts and members follow item edits, trash and folder renames without going stale', () => {
    const tree = [folder('FOLDERAAAAAAA', 'Studies')];
    const fx = new Fixture(
      makeRoot(tree, [
        sf('RX', [cond([rule('name', 'regex', '^oil')])]),
        sf('FN', [cond([rule('folderName', 'contain', 'stud')])]),
      ]),
    );
    const a = fx.add({ name: 'oil one' });
    const b = fx.add({ name: 'ink', folders: ['FOLDERAAAAAAA'] });
    const eng = fx.engine();
    const names = (id: string) =>
      eng
        .briefs(eng.query({ scope: { kind: 'smartFolder', id }, filter: {}, sort: null }).ids)
        .map((x) => x.name);
    expect(eng.smartFolderCounts()).toEqual({ RX: 1, FN: 1 });

    fx.ix.upsertRecords([{ ...b, name: 'oil two', lastModified: 2 }]); // now matches the regex
    expect(eng.smartFolderCounts()).toEqual({ RX: 2, FN: 1 });
    expect(names('RX').sort()).toEqual(['oil one', 'oil two']);
    fx.ix.upsertRecords([{ ...a, isDeleted: true, lastModified: 2 }]); // trash never counts
    expect(eng.smartFolderCounts()).toEqual({ RX: 1, FN: 1 });
    expect(names('RX')).toEqual(['oil two']);
    fx.ix.removeItems([b.id]);
    expect(eng.smartFolderCounts()).toEqual({ RX: 0, FN: 0 });

    const c = fx.add({ name: 'pencil', folders: ['FOLDERAAAAAAA'] });
    expect(eng.smartFolderCounts()).toEqual({ RX: 0, FN: 1 });
    // Renaming the folder changes which items a folder-name rule holds, with no item written.
    fx.setRoot({ ...fx.root, folders: [folder('FOLDERAAAAAAA', 'Sketches')], modificationTime: 9 });
    expect(eng.smartFolderCounts()).toEqual({ RX: 0, FN: 0 });
    expect(names('FN')).toEqual([]);
    void c;
  });
});
