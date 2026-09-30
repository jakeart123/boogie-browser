// Checks smart folder conditions that arrive from outside (Eagle API v2 smartFolder/create and
// update, the MCP smart folder tool) before they are written into the library, the way Eagle's own
// API checks them: known property, a method that property takes, and a value of the right shape.
// A bad rule would otherwise land in the shared metadata.json and quietly empty the folder in
// the partner's Eagle. The property table is research/format-notes/smartfolders-filters.md.
import type { SmartCondition, SmartRule } from '../../shared/types';

const TEXT = [
  'contain',
  'uncontain',
  'startWith',
  'endWith',
  'equal',
  'empty',
  'not-empty',
  'regex',
];
const NUMBER = ['>', '>=', '=', '<', '<=', 'between'];
const DATE = ['before', 'after', 'between', 'on', 'within'];
const SET = ['union', 'intersection', 'equal', 'identity', 'empty', 'not-empty'];

type Kind = 'text' | 'number' | 'date' | 'list' | 'word' | 'none';
const rule = (kind: Kind, methods: string[], units?: string[]) => ({ kind, methods, units });

/** property -> what it takes. */
const SMART_RULES: Record<string, ReturnType<typeof rule>> = {
  name: rule('text', TEXT),
  folderName: rule('text', TEXT),
  url: rule('text', TEXT),
  annotation: rule('text', TEXT),
  comments: rule('text', TEXT),
  camera: rule('text', TEXT),
  width: rule('number', NUMBER),
  height: rule('number', NUMBER),
  fileSize: rule('number', NUMBER, ['kb', 'mb']),
  duration: rule('number', NUMBER, ['s', 'm', 'h']),
  bpm: rule('number', NUMBER),
  iso: rule('number', NUMBER),
  aperture: rule('number', NUMBER),
  focalLength: rule('number', NUMBER),
  shutter: rule('number', NUMBER),
  createTime: rule('date', DATE),
  mtime: rule('date', DATE),
  btime: rule('date', DATE),
  timestamp: rule('date', DATE),
  tags: rule('list', SET),
  folders: rule('list', SET),
  type: rule('word', ['equal', 'unequal']),
  rating: rule('word', ['equal', 'unequal', 'contain']),
  shape: rule('word', ['equal', 'unequal']),
  color: rule('word', ['similar', 'accuracy', 'grayscale']),
  fontActivated: rule('none', ['activate', 'deactivate']),
};

const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

/** Eagle's editor and API both stop at 30 conditions per folder and 30 rules per condition. */
const MAX = 30;

/**
 * Eagle builds a regular expression from a startWith/endWith value (and, for `regex`, from the
 * value itself), after lowercasing it. One that doesn't compile makes startWith/endWith throw,
 * which empties the whole smart folder in Eagle.
 */
function patternOf(method: string, value: string): { source: string; flags: string } | null {
  const v = value.toLowerCase();
  if (method === 'startWith') return { source: `^${v}`, flags: 'i' };
  if (method === 'endWith') return { source: `${v}$`, flags: 'i' };
  if (method === 'regex') return { source: v, flags: 'g' };
  return null;
}

function compiles(p: { source: string; flags: string }): boolean {
  try {
    new RegExp(p.source, p.flags);
    return true;
  } catch {
    return false;
  }
}

/** A value with no objects inside: a string, a number, or a flat list of them. */
function plainValue(v: unknown): unknown {
  if (typeof v === 'string' || isNum(v)) return v;
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' || isNum(x));
  return '';
}

/** One rule as it will be written: only the keys Eagle reads, checked like Eagle's API checks them. */
function checkRule(r: unknown, where: string): SmartRule {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error(`${where}: not a rule.`);
  const { property, method, value } = r as SmartRule;
  const spec = typeof property === 'string' ? SMART_RULES[property] : undefined;
  if (!spec)
    throw new Error(
      `${where}: unknown property ${JSON.stringify(property)}. Known: ${Object.keys(SMART_RULES).join(', ')}.`,
    );
  if (typeof method !== 'string' || !spec.methods.includes(method))
    throw new Error(
      `${where}: ${property} takes the methods ${spec.methods.join(', ')}, not ${JSON.stringify(method)}.`,
    );
  const out: SmartRule = { property, method, value: plainValue(value) };
  const bad = (shape: string) => new Error(`${where}: ${property} ${method} needs ${shape}.`);
  const valueless = method === 'empty' || method === 'not-empty' || spec.kind === 'none';
  if (valueless) {
    // No value to check.
  } else if (spec.kind === 'text' || spec.kind === 'word') {
    if (spec.kind === 'word' && property === 'color' && method === 'grayscale') {
      // grayscale ignores the value
    } else if (typeof value !== 'string') throw bad('a text value');
    const pattern = typeof value === 'string' ? patternOf(method, value) : null;
    if (pattern && !compiles(pattern))
      throw new Error(
        `${where}: Eagle reads ${property} ${method} ${JSON.stringify(value)} as a pattern, and it is not a valid one. Put a backslash before ( ) [ ] { } * + ? . ^ $ | to match them as plain characters.`,
      );
  } else if (spec.kind === 'list') {
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string'))
      throw bad('a list of names');
  } else {
    const n = method === 'between' ? 2 : 1;
    if (!Array.isArray(value) || value.length < n || !value.slice(0, n).every(isNum))
      throw bad(n === 2 ? 'two numbers, [from, to]' : 'a number, as [n]');
    // Eagle's editor always writes two slots for numbers.
    out.value =
      spec.kind === 'number' ? [value[0], isNum(value[1]) ? value[1] : 0] : value.slice(0, n);
  }
  if (spec.units) {
    const unit = (r as SmartRule).unit ?? spec.units[property === 'fileSize' ? 1 : 0];
    if (!spec.units.includes(unit as string))
      throw new Error(`${where}: ${property} unit must be one of ${spec.units.join(', ')}.`);
    out.unit = unit;
  }
  if (property === 'shape' && value === 'custom') {
    const { width, height } = r as { width?: unknown; height?: unknown };
    if (!isNum(width) || !isNum(height)) throw bad('width and height numbers for a custom shape');
    out.width = width;
    out.height = height;
  }
  return out;
}

/** The conditions as they will be written, or an Error saying plainly what is wrong. */
export function checkConditions(raw: unknown): SmartCondition[] {
  if (!Array.isArray(raw) || !raw.length)
    throw new Error('conditions must be a list of at least one condition.');
  if (raw.length > MAX) throw new Error(`At most ${MAX} conditions, as in Eagle.`);
  return raw.map((c, i) => {
    const where = `condition ${i + 1}`;
    if (!c || typeof c !== 'object' || Array.isArray(c))
      throw new Error(`${where}: not an object.`);
    const cond = c as SmartCondition;
    if (!Array.isArray(cond.rules) || !cond.rules.length)
      throw new Error(`${where}: rules must be a list of at least one rule.`);
    if (cond.rules.length > MAX) throw new Error(`${where}: at most ${MAX} rules, as in Eagle.`);
    const match = cond.match ?? 'AND';
    if (match !== 'AND' && match !== 'OR') throw new Error(`${where}: match must be AND or OR.`);
    const boolean = cond.boolean ?? 'TRUE';
    if (boolean !== 'TRUE' && boolean !== 'FALSE')
      throw new Error(`${where}: boolean must be TRUE or FALSE.`);
    // Only the keys Eagle reads: anything else from the caller stays out of metadata.json.
    return {
      rules: cond.rules.map((r, j) => checkRule(r, `${where}, rule ${j + 1}`)),
      match,
      boolean,
    };
  });
}
