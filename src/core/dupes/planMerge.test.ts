import { describe, expect, it } from 'vitest';
import type { EagleItemRecord, MergeOptions } from '../../shared/types';
import { planMerge } from './planMerge';

function rec(id: string, extra: Partial<EagleItemRecord> = {}): EagleItemRecord {
  return {
    id,
    name: id,
    size: 10,
    btime: 1,
    mtime: 1,
    ext: 'png',
    tags: [],
    folders: [],
    isDeleted: false,
    url: '',
    annotation: '',
    modificationTime: 1,
    ...extra,
  };
}

const opts = (over: Partial<MergeOptions> = {}): MergeOptions => ({
  keeperId: 'K',
  otherIds: ['A', 'B'],
  ...over,
});
const noAuto = () => [] as string[];

describe('planMerge', () => {
  it('unions tags (keeper first) and folders, and applies auto-tags of the folders it adds', () => {
    const keeper = rec('K', { tags: ['ref', 'face'], folders: ['F1'] });
    const a = rec('A', { tags: ['face', 'ink'], folders: ['F1', 'F2'] });
    const b = rec('B', { tags: ['sketch'], folders: ['F3'] });
    const auto = (f: string) => (f === 'F2' ? ['portrait'] : f === 'F3' ? ['ink', 'study'] : []);
    const plan = planMerge(keeper, [a, b], opts(), auto);
    expect(plan.trashIds).toEqual(['A', 'B']);

    const fresh = rec('K', { tags: ['ref', 'face'], folders: ['F1'] });
    expect(plan.keeper(fresh)).toBe(true);
    expect(fresh.folders).toEqual(['F1', 'F2', 'F3']);
    expect(fresh.tags).toEqual(['ref', 'face', 'ink', 'sketch', 'portrait', 'study']);
    // Applying it again changes nothing (a retried merge must not double up).
    expect(plan.keeper(fresh)).toBe(false);
  });

  it('is computed against the fresh keeper, not the snapshot', () => {
    const plan = planMerge(
      rec('K', { tags: ['old'] }),
      [rec('A', { tags: ['x'] })],
      opts({ otherIds: ['A'] }),
      noAuto,
    );
    const fresh = rec('K', { tags: ['old', 'added-by-sam'] });
    plan.keeper(fresh);
    expect(fresh.tags).toEqual(['old', 'added-by-sam', 'x']);
  });

  it('appends distinct notes after the keeper note, each identical note once', () => {
    const keeper = rec('K', { annotation: 'Date: 1880\nStudent of: Gerome' });
    const a = rec('A', { annotation: 'from the museum site' });
    const b = rec('B', { annotation: '  from the museum site \n' }); // same as A's once trimmed
    const c = rec('C', { annotation: 'Date: 1880\nStudent of: Gerome' }); // same as the keeper's
    const d = rec('D', { annotation: '' });
    const plan = planMerge(keeper, [a, b, c, d], opts({ otherIds: ['A', 'B', 'C', 'D'] }), noAuto);
    const fresh = rec('K', { annotation: keeper.annotation });
    plan.keeper(fresh);
    expect(fresh.annotation).toBe('Date: 1880\nStudent of: Gerome\n\nfrom the museum site');
    expect(plan.keeper(fresh)).toBe(false);

    // An empty keeper note takes the others' notes without a leading blank line.
    const empty = rec('K');
    planMerge(rec('K'), [a], opts({ otherIds: ['A'] }), noAuto).keeper(empty);
    expect(empty.annotation).toBe('from the museum site');
  });

  it('keeps the keeper url, else the first other url, and the best rating', () => {
    const others = [
      rec('A', { url: '', star: 2 }),
      rec('B', { url: 'https://b.example', star: 4 }),
    ];
    const withUrl = rec('K', { url: 'https://k.example', star: 3 });
    planMerge(withUrl, others, opts(), noAuto).keeper(withUrl);
    expect(withUrl.url).toBe('https://k.example');
    expect(withUrl.star).toBe(4);

    const bare = rec('K');
    planMerge(bare, others, opts(), noAuto).keeper(bare);
    expect(bare.url).toBe('https://b.example');
    expect(bare.star).toBe(4);

    const unrated = rec('K');
    planMerge(unrated, [rec('A')], opts({ otherIds: ['A'] }), noAuto).keeper(unrated);
    expect('star' in unrated).toBe(false); // nobody rated it: the key stays absent

    const kept = rec('K', { star: 1 });
    planMerge(kept, others, opts({ keepStar: 'keeper', keepUrl: 'keeper' }), noAuto).keeper(kept);
    expect([kept.star, kept.url]).toEqual([1, '']);
  });

  it('carries manual order entries for folders the keeper joins, and only those', () => {
    const keeper = rec('K', { folders: ['F1'], order: { F1: '1700000000000.5' } });
    const a = rec('A', {
      folders: ['F1', 'F2'],
      order: { F1: '1600000000000.1', F2: '1750000000000.25', GONE: '1.5' }, // F1: keeper has it; GONE: a stale entry
    });
    const b = rec('B', { folders: ['F2'], order: { F2: '1111.1' } }); // F2 already taken from A
    const plan = planMerge(keeper, [a, b], opts(), noAuto);
    const fresh = rec('K', { folders: ['F1'], order: { F1: '1700000000000.5' } });
    plan.keeper(fresh);
    expect(fresh.order).toEqual({ F1: '1700000000000.5', F2: '1750000000000.25' });
  });

  it('honors the option switches', () => {
    const a = rec('A', { tags: ['x'], folders: ['F2'], annotation: 'note', order: { F2: '5.5' } });
    const fresh = rec('K', { tags: ['k'], folders: ['F1'] });
    const plan = planMerge(
      fresh,
      [a],
      opts({ otherIds: ['A'], unionTags: false, unionFolders: false, mergeNotes: false }),
      () => ['auto'],
    );
    expect(plan.keeper(fresh)).toBe(false);
    expect(fresh).toMatchObject({ tags: ['k'], folders: ['F1'], annotation: '' });
    expect(fresh.order).toBeUndefined();
    expect(plan.trashIds).toEqual(['A']);
  });

  it('never trashes the keeper or anything the caller did not name', () => {
    const plan = planMerge(
      rec('K'),
      [rec('K'), rec('A'), rec('A'), rec('OTHER-LIBRARY-ID')],
      opts({ otherIds: ['A'] }),
      noAuto,
    );
    expect(plan.trashIds).toEqual(['A']);

    // An empty list merges nothing: no trash, and no folders from records it was handed.
    const none = planMerge(
      rec('K'),
      [rec('A', { folders: ['F-OF-ANOTHER-LIBRARY'] })],
      opts({ otherIds: [] }),
      noAuto,
    );
    const fresh = rec('K');
    expect(none.trashIds).toEqual([]);
    expect(none.keeper(fresh)).toBe(false);
    expect(fresh.folders).toEqual([]);
  });
});
