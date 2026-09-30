import { describe, expect, it } from 'vitest';
import { conflictText } from './edit';

describe('conflictText', () => {
  it("says the core's reason, and how many other reasons there were", () => {
    const c = (reason: string) => ({ id: 'x', field: 'tags', reason });
    expect(conflictText([c('changed since'), c('changed since')])).toBe(
      '2 changes left alone: edited after this action.',
    );
    expect(
      conflictText([
        c("the earlier thumbnail wasn't kept, so the new one stays"),
        c('changed since'),
      ]),
    ).toBe(
      "2 changes left alone: the earlier thumbnail wasn't kept, so the new one stays (and 1 other reason).",
    );
  });
});
