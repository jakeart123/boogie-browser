import { describe, expect, it } from 'vitest';
import type { FilterSpec } from '../../../shared/types';
import {
  defaultEagleRule,
  eagleCaveats,
  eagleRuleToFilter,
  filterToEagleRule,
} from './savedFilters';

const NOW = new Date(2026, 8, 29, 15, 30).getTime(); // local time, like Eagle's date flags
const DAY = 86_400_000;
const names: Record<string, string> = { F1: 'Hands', F2: 'Feet' };
const folderName = (id: string) => names[id];

/**
 * What Eagle's filter bar saves (angular.copy of its filterRules, see smartfolders-filters.md):
 * every section present, folder values are whole folder objects, undefined keys dropped by JSON.
 */
function eagleSaved(patch: Record<string, unknown>): Record<string, unknown> {
  const rule = JSON.parse(JSON.stringify(defaultEagleRule())) as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch))
    rule[k] =
      v && typeof v === 'object' && !Array.isArray(v)
        ? { ...(rule[k] as object), ...(v as object) }
        : v;
  return rule;
}

describe("Eagle's saved filter -> Boogie filter", () => {
  it('reads a typical filter-bar snapshot', () => {
    const rule = eagleSaved({
      keyword: 'bargue -cast',
      tag: { no: false, includes: ['hands', 'feet'], excludes: ['wip'] },
      folder: {
        includes: {
          F1: {
            id: 'F1',
            name: 'Hands',
            children: [],
            imageCount: 12,
            covers: ['<img>'],
            $$hashKey: 'x',
          },
          NoFolders: { id: 'NoFolders', name: 'Unfiled', isNoFolder: true },
        },
        excludes: {},
      },
      type: { includes: { jpg: true, video: true, png: false }, excludes: {} },
      rating: { '5': true, '4': true, '0': false },
      color: { gray: false, value: [200, 30, 40], accuracy: 10 },
      shape: { landscape: true, panoramicLandscape: true },
      resolution: { minW: 1920 },
      file: { min: 1, max: '2.5', unit: 'mb' },
      duration: { min: 1, unit: 'm' },
      import: { last30day: true, today: true },
      note: { has: true, no: false, keywords: 'master copy' },
      url: { has: false, no: true },
      annotation: { has: true, no: false },
    });
    const { filter, unsupported } = eagleRuleToFilter(rule, NOW);
    // Eagle's filter bar ORs included and excluded tags (eagle-proof FINDINGS-2 R2-3).
    expect(unsupported).toEqual([
      'Tags: Eagle shows items with an included tag OR without the excluded ones',
    ]);
    expect(filter).toEqual({
      keywords: 'bargue -cast',
      types: { include: ['jpg', 'video'], exclude: [] },
      tags: { mode: 'any', include: ['hands', 'feet'], exclude: ['wip'] },
      unfiled: true,
      folders: { include: ['F1'], exclude: [] },
      importedWithinDays: 30, // "today" is inside the last 30 days
      rating: [4, 5],
      color: { rgb: [200, 30, 40], tolerance: 'close' },
      shapes: ['landscape', 'panoramic-landscape'],
      width: { min: 1920 },
      fileSize: { min: 1_048_576, max: 2_621_440 },
      duration: { min: 60 },
      hasNote: true,
      noteContains: 'master copy',
      hasUrl: false,
      hasComments: true,
    } satisfies FilterSpec);
  });

  it('tolerates a partial or junk rule (the merge onto defaults is shallow)', () => {
    expect(eagleRuleToFilter({}, NOW)).toEqual({ filter: {}, unsupported: [] });
    expect(eagleRuleToFilter(null, NOW)).toEqual({ filter: {}, unsupported: [] });
    const junk = {
      tag: 'oops',
      rating: [1],
      color: { value: 'red' },
      shape: null,
      file: { min: 'x' },
    };
    expect(eagleRuleToFilter(junk, NOW)).toEqual({ filter: {}, unsupported: [] });
  });

  it('dates: today/yesterday, a custom range (whole end day), months, and the mtime range bug', () => {
    const midnight = new Date(2026, 8, 29).getTime();
    const today = eagleRuleToFilter(eagleSaved({ import: { today: true } }), NOW).filter;
    expect(today).toEqual({ importedAt: { min: midnight + 1 } });
    const both = eagleRuleToFilter(eagleSaved({ import: { today: true, yesterday: true } }), NOW);
    expect(both.filter.importedAt).toEqual({ min: midnight - DAY + 1 });
    expect(both.unsupported).toEqual([]); // one span: only midnight itself is between them

    const a = new Date(2026, 0, 10).getTime();
    const b = new Date(2026, 0, 20).getTime();
    // Eagle reads the Date Modified range from import.range.
    const ranged = eagleRuleToFilter(
      eagleSaved({ import: { range: [a, b] }, mtime: { usingRange: true } }),
      NOW,
    ).filter;
    expect(ranged).toEqual({ modifiedAt: { min: a, max: b + DAY } });

    const months = eagleRuleToFilter(
      eagleSaved({ import: { selectedMonths: { '2026/03': true, '2026/04': true } } }),
      NOW,
    );
    expect(months.filter.importedAt).toEqual({
      min: new Date(2026, 2, 1).getTime(),
      max: new Date(2026, 4, 1).getTime() - 1,
    });
    const apart = eagleRuleToFilter(
      eagleSaved({ mtime: { selectedMonths: { '2026/01': true, '2026/06': true } } }),
      NOW,
    );
    expect(apart.unsupported).toEqual(["Date modified: months that aren't next to each other"]);
  });

  it('names what only works in Eagle, and keeps the rest', () => {
    const rule = eagleSaved({
      tag: { no: true, includes: [], excludes: [] },
      camera: { 'Canon EOS R5': true },
      font: { activated: true },
      bpm: { min: 120 },
      image: { itemId: 'ABC' },
      semantic: { value: 'a cat on a sofa' },
      type: { includes: { youtube: true, gif: true }, excludes: {} },
      shape: { '43': true, square: true },
      note: { has: true, keywords: 'hand,foot' },
    });
    const { filter, unsupported } = eagleRuleToFilter(rule, NOW);
    expect(filter).toEqual({
      noTags: true,
      types: { include: ['gif'], exclude: [] },
      shapes: ['square'],
      hasNote: true,
      noteContains: 'hand',
    });
    expect(unsupported).toEqual([
      'Type: youtube links',
      'Shape: several shapes and aspect ratios together',
      'Note containing all of: hand, foot',
      'Font installed or not',
      'Camera',
      'BPM',
      'Search by image',
      'AI search',
    ]);
  });
});

describe('Boogie filter -> Eagle rule', () => {
  const full: FilterSpec = {
    keywords: 'oil "plaster cast"',
    tags: { mode: 'any', include: ['hands'], exclude: ['wip'] },
    noTags: true,
    folders: { include: ['F1'], exclude: ['F2', 'NoFolders'] },
    unfiled: true,
    types: { include: ['jpg', 'video'], exclude: ['gif'] },
    rating: [0, 5],
    color: { rgb: [10, 20, 30], tolerance: 'similar' },
    grayscale: true,
    shapes: ['portrait', 'panoramic-portrait'],
    width: { min: 100, max: 4000 },
    height: { max: 3000 },
    fileSize: { min: 2 * 1_048_576, max: 10 * 1_048_576 },
    duration: { min: 5, max: 90 },
    importedWithinDays: 7,
    modifiedAt: { min: 1_700_000_000_000, max: 1_750_000_000_000 },
    hasUrl: false,
    noteContains: 'study',
    hasNote: true,
    hasComments: true,
    commentContains: 'fix this',
  };

  it('round-trips through what Eagle would store', () => {
    const rule = filterToEagleRule(full, folderName);
    const back = eagleRuleToFilter(JSON.parse(JSON.stringify(rule)), NOW);
    expect(back.unsupported).toEqual([
      'Tags: Eagle shows items with an included tag OR without the excluded ones',
      'Folders: Eagle shows items in an included folder OR outside the excluded ones',
    ]);
    expect(back.filter).toEqual(full);
  });

  it("writes new keys where Eagle's own filter bar puts them", () => {
    const rule = JSON.parse(
      JSON.stringify(
        filterToEagleRule(
          { color: { rgb: [1, 2, 3], tolerance: 'close' }, importedAt: { min: 5, max: DAY * 9 } },
          folderName,
        ),
      ),
    );
    expect(Object.keys(rule.color)).toEqual(['gray', 'value', 'accuracy']);
    expect(Object.keys(rule.import).slice(6, 9)).toEqual(['usingRange', 'range', 'type']);
  });

  it('writes every sub-object whole (Eagle merges shallowly) and folders as {id, name}', () => {
    const rule = filterToEagleRule({ rating: [3] }, folderName);
    expect(Object.keys(rule).sort()).toEqual(Object.keys(defaultEagleRule()).sort());
    expect(rule.shape).toEqual(defaultEagleRule().shape);
    expect(rule.rating).toEqual({
      '1': false,
      '2': false,
      '3': true,
      '4': false,
      '5': false,
      '0': false,
    });
    expect(rule).not.toHaveProperty('keyword');
    const withFolder = filterToEagleRule({ folders: { include: ['F1'], exclude: [] } }, folderName);
    expect(withFolder.folder).toEqual({
      includes: { F1: { id: 'F1', name: 'Hands' } },
      excludes: {},
    });
  });

  it("aspect ratios become Eagle's presets or a custom shape; dates take its four windows", () => {
    expect(filterToEagleRule({ aspect: { w: 32, h: 18 } }, folderName).shape).toMatchObject({
      '169': true,
      custom: false,
    });
    expect(filterToEagleRule({ aspect: { w: 21, h: 9 } }, folderName).shape).toMatchObject({
      custom: true,
      width: 21,
      height: 9,
    });
    expect(filterToEagleRule({ importedWithinDays: 10 }, folderName).import).toMatchObject({
      last30day: true,
    });
    const r = filterToEagleRule({ importedAt: { max: 1_750_000_000_000 } }, folderName);
    expect(r.import).toMatchObject({ usingRange: true, range: [1, 1_750_000_000_000 - DAY] });
    // An open start or end reads back as open.
    expect(eagleRuleToFilter(r, NOW).filter.importedAt).toEqual({ max: 1_750_000_000_000 });
    // Eagle ORs a section's flags: with both, only the rolling window is written.
    const both = filterToEagleRule({ importedWithinDays: 7, importedAt: { min: 5 } }, folderName);
    expect(both.import).toMatchObject({ last7day: true, usingRange: false });
  });

  it('keeps the parts only Eagle understands when a filter is edited here', () => {
    const base = eagleSaved({
      camera: { X100V: true },
      bpm: { min: 90 },
      type: { includes: { vimeo: true, jpg: true }, excludes: {} },
    });
    const edited = filterToEagleRule(
      { types: { include: ['png'], exclude: [] } },
      folderName,
      base,
    );
    expect(edited.camera).toEqual({ X100V: true });
    expect(edited.bpm).toEqual({ min: 90 });
    expect(edited.type).toEqual({ includes: { png: true, vimeo: true }, excludes: {} });
  });
});

describe('editing a saved filter Eagle made', () => {
  // Eagle-shaped rules: its defaults patched field by field, as its filter bar saves them.
  const a = new Date(2026, 0, 10).getTime();
  const b = new Date(2026, 0, 20).getTime();
  const cases: [string, Record<string, unknown>][] = [
    ['today', { import: { today: true } }],
    ['yesterday', { mtime: { yesterday: true } }],
    ['months apart', { import: { selectedMonths: { '2026/01': true, '2026/06': true } } }],
    [
      'months next to each other',
      { import: { selectedMonths: { '2026/01': true, '2026/02': true } } },
    ],
    [
      'rolling and a range',
      { import: { last7day: true, usingRange: true, type: 'range', range: [a, b] } },
    ],
    [
      'a modified range Eagle keeps in import.range',
      { import: { range: [a, b], type: 'range' }, mtime: { usingRange: true } },
    ],
    [
      'color accuracy between the presets',
      { color: { gray: false, accuracy: 15, value: [200, 30, 40] } },
    ],
    ['shape and aspect', { shape: { square: true, '43': true } }],
    ['note with two keywords', { note: { has: true, no: false, keywords: 'hand,foot' } }],
    ['sizes in odd units', { file: { min: '2.5', unit: 'mb' }, duration: { max: 2, unit: 'h' } }],
    [
      'a folder object Eagle keeps whole',
      {
        folder: {
          includes: { F1: { id: 'F1', name: 'Hands', children: [], imageCount: 3 } },
          excludes: {},
        },
      },
    ],
    ['a key from a newer Eagle', { aiTags: { includes: ['x'] } }],
  ];
  for (const [name, patch] of cases)
    it(`changing the rating keeps ${name} byte for byte`, () => {
      const rule = eagleSaved(patch);
      const { filter } = eagleRuleToFilter(rule, NOW);
      const edited = JSON.parse(
        JSON.stringify(filterToEagleRule({ ...filter, rating: [3] }, folderName, rule, NOW)),
      );
      expect(JSON.stringify({ ...edited, rating: 0 })).toBe(JSON.stringify({ ...rule, rating: 0 }));
      expect(edited.rating['3']).toBe(true);
    });

  it('a UI that read "today" before midnight still counts as unchanged', () => {
    const rule = eagleSaved({ import: { today: true } });
    const { filter } = eagleRuleToFilter(rule, NOW);
    const edited = filterToEagleRule({ ...filter, rating: [1] }, folderName, rule, NOW + DAY);
    expect(edited.import).toEqual(rule.import);
  });

  it('a changed date section keeps the modified range Eagle reads from import.range', () => {
    const rule = eagleSaved({
      import: { range: [a, b], type: 'range' },
      mtime: { usingRange: true },
    });
    const { filter } = eagleRuleToFilter(rule, NOW);
    const edited = filterToEagleRule({ ...filter, importedWithinDays: 7 }, folderName, rule, NOW);
    expect(edited.import).toMatchObject({ last7day: true, usingRange: false, range: [a, b] });
    expect(eagleRuleToFilter(edited, NOW).filter).toMatchObject({
      importedWithinDays: 7,
      modifiedAt: { min: a, max: b + DAY },
    });
  });

  it('a changed section keeps its unknown keys and rewrites only what Boogie holds', () => {
    const rule = eagleSaved({ color: { gray: false, accuracy: 15, value: [1, 2, 3], future: 1 } });
    const edited = filterToEagleRule(
      { color: { rgb: [9, 9, 9], tolerance: 'similar' } },
      folderName,
      rule,
      NOW,
    );
    expect(edited.color).toEqual({ gray: false, value: [9, 9, 9], accuracy: 15, future: 1 });
  });
});

describe('what Eagle cannot hold, as warnings', () => {
  it('names each difference once', () => {
    expect(eagleCaveats({ rating: [5] })).toEqual([]);
    expect(
      eagleCaveats({
        tags: { mode: 'all', include: ['a', 'b'], exclude: ['c'] },
        importedWithinDays: 10,
        modifiedAt: { min: 5 },
        importedAt: { min: 6 },
      }),
    ).toEqual([
      'Eagle shows items with any of these tags, not all of them.',
      'Tags: Eagle shows items with an included tag OR without the excluded ones.',
      'Date imported: Eagle only has the last 7, 30, 90 or 365 days, so it uses 30.',
      "Date imported: Eagle can't combine a date range with the last days; it keeps the days.",
    ]);
    expect(eagleCaveats({ importedAt: { min: 5 }, modifiedAt: { min: 6 } })).toEqual([
      'Eagle keeps one date range for both dates, so it uses the imported range for both.',
    ]);
  });
});
