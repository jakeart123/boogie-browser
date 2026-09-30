// The smart folder editor's model: rules it writes must be what Eagle writes, and rules made in
// Eagle must come back out unharmed. See research/format-notes/smartfolders-filters.md.
import { describe, expect, it } from 'vitest';
import type { SmartCondition } from '../../../shared/types';
import {
  changeMethod,
  dateToInput,
  defaultRule,
  firstProblem,
  inputToDate,
  methodsFor,
  nextKey,
  ruleProblem,
  toConditions,
  toModel,
} from './smart';

describe('defaults (what Eagle puts in when a property is picked)', () => {
  it('matches the editor defaults', () => {
    expect(defaultRule('name')).toEqual({ property: 'name', method: 'contain', value: '' });
    expect(defaultRule('width')).toEqual({ property: 'width', method: '>', value: [480, 0] });
    expect(defaultRule('fileSize')).toEqual({
      property: 'fileSize',
      method: '>',
      value: [1, 0],
      unit: 'mb',
    });
    expect(defaultRule('duration')).toEqual({
      property: 'duration',
      method: '<=',
      value: [30, 0],
      unit: 's',
    });
    expect(defaultRule('tags')).toEqual({ property: 'tags', method: 'intersection', value: [] });
    expect(defaultRule('rating')).toEqual({ property: 'rating', method: 'equal', value: '5' });
  });
  it('only offers methods Eagle understands for each kind', () => {
    expect(methodsFor('tags').map((m) => m.id)).toEqual([
      'union',
      'intersection',
      'equal',
      'identity',
      'empty',
      'not-empty',
    ]);
    expect(methodsFor('createTime').map((m) => m.id)).toEqual([
      'before',
      'after',
      'on',
      'between',
      'within',
    ]);
    // Eagle's `comments` rule has no working "doesn't contain".
    expect(methodsFor('comments').map((m) => m.id)).not.toContain('uncontain');
  });
});

describe('saving and loading', () => {
  const eagle: SmartCondition[] = [
    {
      match: 'OR',
      boolean: 'FALSE',
      $$hashKey: 'object:41',
      rules: [
        {
          property: 'name',
          method: 'contain',
          value: 'sketch',
          $$hashKey: 'object:42',
          import: '2026/01/01',
        },
        { property: 'camera', method: 'contain', value: 'Canon' }, // a property this editor doesn't know
      ],
    },
  ];

  it('writes untouched rules back exactly, and drops the junk Eagle leaks from rules you edit', () => {
    const groups = toModel(eagle);
    expect(toConditions(groups)).toEqual([
      { rules: eagle[0].rules, match: 'OR', boolean: 'FALSE' },
    ]);
    groups[0].rules[0].rule = { ...groups[0].rules[0].rule, value: 'study' };
    expect(toConditions(groups)[0].rules).toEqual([
      { property: 'name', method: 'contain', value: 'study' },
      { property: 'camera', method: 'contain', value: 'Canon' },
    ]);
  });
  it('hands the app plain data, never a Svelte proxy (Electron IPC cannot clone one)', () => {
    const [g] = toModel([
      {
        rules: [{ property: 'tags', method: 'union', value: ['a'] }],
        match: 'AND',
        note: { deep: 1 },
      },
    ]);
    const proxied = new Proxy(
      {
        ...g,
        rules: g.rules.map((r) => new Proxy({ ...r, rule: new Proxy(r.rule, {}) }, {})),
        extra: new Proxy(g.extra, {}),
      },
      {},
    );
    expect(() => structuredClone(toConditions([proxied]))).not.toThrow();
  });
  it('treats a missing or odd match as "all" and a missing boolean as "is true", like Eagle', () => {
    const [g] = toModel([{ rules: [], match: 'XOR' as 'AND' }]);
    expect([g.match, g.boolean]).toEqual(['AND', 'TRUE']);
  });
  it('keeps an untouched number rule as Eagle wrote it (no [480] -> [480, 0], unit kept)', () => {
    const rule = { property: 'width', method: '>', value: [480], unit: 'px' };
    expect(toConditions(toModel([{ rules: [rule], match: 'AND' }]))[0].rules).toEqual([rule]);
  });
  it('writes edited numbers as [n, 0] unless it is a range, and only keeps a unit where one applies', () => {
    const [g] = toModel([
      {
        rules: [
          { property: 'width', method: '>', value: [800, 12], unit: 'kb' },
          { property: 'fileSize', method: 'between', value: [1, 5], unit: 'mb' },
        ],
        match: 'AND',
      },
    ]);
    g.rules[0].rule = { ...g.rules[0].rule, value: [900, 12] };
    g.rules[1].rule = { ...g.rules[1].rule, value: [1, 6] };
    expect(toConditions([g])[0].rules).toEqual([
      { property: 'width', method: '>', value: [900, 0] },
      { property: 'fileSize', method: 'between', value: [1, 6], unit: 'mb' },
    ]);
  });
});

describe('changing a method keeps the value the right shape', () => {
  it('numbers: a range gets two numbers, anything else one', () => {
    const r = changeMethod({ property: 'width', method: '>', value: [800, 0] }, 'between');
    expect(r.value).toEqual([800, 800]);
    expect(changeMethod(r, '<').value).toEqual([800, 0]);
  });
  it('dates: "within" holds a day count, the others hold midnight timestamps', () => {
    const within = changeMethod(
      { property: 'createTime', method: 'before', value: [1_700_000_000_000] },
      'within',
    );
    expect(within.value).toEqual([30]);
    const on = changeMethod(within, 'on');
    expect(on.value).toEqual([null]);
  });
  it('text rules that need no text lose it', () => {
    expect(changeMethod({ property: 'name', method: 'contain', value: 'abc' }, 'empty').value).toBe(
      '',
    );
  });
});

describe('rules that would silently match nothing are caught', () => {
  it('flags empty text, empty tag lists and reversed ranges', () => {
    expect(ruleProblem(defaultRule('name'))).toBeTruthy();
    expect(ruleProblem(defaultRule('tags'))).toBeTruthy();
    expect(ruleProblem({ property: 'width', method: 'between', value: [900, 100] })).toBeTruthy();
    expect(ruleProblem({ property: 'createTime', method: 'before', value: [] })).toBeTruthy();
  });
  it('flags a pattern that would blank the whole folder in Eagle', () => {
    expect(ruleProblem({ property: 'name', method: 'startWith', value: '(' })).toBeTruthy();
    expect(ruleProblem({ property: 'name', method: 'regex', value: '(' })).toBeTruthy();
    expect(ruleProblem({ property: 'name', method: 'contain', value: '(' })).toBeNull();
  });
  it('passes good rules, and rules with no value to fill in', () => {
    expect(ruleProblem({ property: 'tags', method: 'empty', value: [] })).toBeNull();
    expect(ruleProblem({ property: 'color', method: 'grayscale', value: '' })).toBeNull();
    expect(ruleProblem({ property: 'rating', method: 'equal', value: 'none' })).toBeNull();
  });
  it('names where the first problem is', () => {
    const groups = toModel([
      { rules: [{ property: 'rating', method: 'equal', value: '5' }], match: 'AND' },
      { rules: [{ property: 'rating', method: 'equal', value: '4' }], match: 'AND' },
    ]);
    groups[1].rules.push({ k: nextKey(), rule: defaultRule('name') }); // added in the editor
    expect(firstProblem(groups)).toBe('Group 2, rule 2: Type what to look for.');
  });
});

describe('rules made in Eagle', () => {
  it('edits rating "is one of" and custom aspect ratios', () => {
    const [g] = toModel([
      {
        match: 'AND',
        rules: [
          { property: 'rating', method: 'contain', value: '345' },
          { property: 'shape', method: 'equal', value: 'custom', width: 16, height: 9 },
        ],
      },
    ]);
    expect(g.rules.map((r) => r.kept)).toEqual([false, false]);
    expect(firstProblem([g])).toBeNull();
    expect(changeMethod(g.rules[0].rule, 'equal').value).toBe('3');
    expect(ruleProblem({ property: 'shape', method: 'equal', value: 'custom' })).toBeTruthy();
  });
  it('keeps what it does not understand exactly as it was, and still saves', () => {
    const odd = [
      { property: 'tags', method: 'subset', value: ['a'] }, // a method this editor doesn't offer
      { property: 'rating', method: 'contain', value: 'none' }, // Eagle reads this as "everything"
      { property: 'name', method: 'contain', value: '' }, // Eagle's own default rule
      { property: 'bpm', method: '>=', value: [160, 0] }, // a property it has no control for
    ];
    const groups = toModel([{ match: 'OR', rules: odd }]);
    expect(groups[0].rules.every((r) => r.kept)).toBe(true);
    expect(firstProblem(groups)).toBeNull();
    expect(toConditions(groups)[0].rules).toEqual(odd);
  });
});

describe('dates', () => {
  it("stores local midnight of the chosen day, like Eagle's date picker", () => {
    const ms = inputToDate('2026-09-28')!;
    const d = new Date(ms);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([
      2026, 8, 28, 0, 0,
    ]);
    expect(dateToInput(ms)).toBe('2026-09-28');
  });
  it('shows nothing for a date that was never picked', () => {
    expect(inputToDate('')).toBeNull();
    expect(dateToInput(undefined)).toBe('');
    expect(dateToInput('')).toBe('');
  });
});
