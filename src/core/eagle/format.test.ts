import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setWritableRoots } from '../safety/writeGuard';
import { createLibrary, probeLibrary } from './create';
import { guid, isItemId } from './ids';
import { isBlankOrNul, parseJson, serialize } from './json';
import { sanitizeFolderName, sanitizeItemName } from './names';
import { compareOrder, formatDecimal, parseDecimal, placeBetween, spreadDuplicates } from './order';
import { isSupportedVersion } from './version';
import {
  TEMPLATES,
  TMP,
  USING_FIXTURES,
  allowTmp,
  cleanup,
  openLib,
  readText,
  scratch,
} from './testkit';

beforeAll(allowTmp);
afterAll(async () => {
  setWritableRoots([]);
  await cleanup();
});

const templates = ['sample', 'art-archive'].filter((t) =>
  existsSync(join(TEMPLATES, `${t}.library`)),
);

describe('byte-exact round trip of the real libraries (read-only)', () => {
  it.each(templates)(
    '%s: every JSON file parses and serializes to the identical bytes',
    async (name) => {
      const lib = join(TEMPLATES, `${name}.library`);
      const files = [
        'metadata.json',
        'mtime.json',
        'tags.json',
        'saved-filters.json',
        'actions.json',
      ].map((f) => join(lib, f));
      const ids = (await readdir(join(lib, 'images'))).filter((n) => n.endsWith('.info'));
      for (const d of ids) files.push(join(lib, 'images', d, 'metadata.json'));

      const mismatches: string[] = [];
      const unparseable: string[] = [];
      let checked = 0;
      let next = 0;
      const worker = async () => {
        while (next < files.length) {
          const f = files[next++];
          let text: string;
          try {
            text = await readFile(f, 'utf8');
          } catch {
            continue; // an .info folder with no metadata.json
          }
          try {
            const back = serialize(parseJson(text));
            checked++;
            if (back !== text) mismatches.push(f);
          } catch {
            if (!isBlankOrNul(text)) unparseable.push(f);
          }
        }
      };
      await Promise.all(Array.from({ length: 32 }, worker));
      expect(unparseable).toEqual([]);
      expect(mismatches).toEqual([]);
      expect(checked).toBeGreaterThan(ids.length * 0.9);
    },
  );
});

describe('ids', () => {
  it('guid is 13 chars of [0-9A-Z] whose first 8 decode to the time', () => {
    const now = Date.now();
    const id = guid(now);
    expect(id).toMatch(/^[0-9A-Z]{13}$/);
    expect(parseInt(id.slice(0, 8), 36)).toBe(now);
    expect(isItemId(id)).toBe(true);
  });
  it('accepts 13 and 36 char ids and nothing that could be a path', () => {
    expect(isItemId('LT24XY3DPJFLK')).toBe(true);
    expect(isItemId('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(isItemId('LT24XY3DPJFL')).toBe(false);
    expect(isItemId('../../etc/pass')).toBe(false);
    expect(isItemId('LT24XY3DPJ/LK')).toBe(false);
  });
});

describe('names', () => {
  it('strips emoji, illegal characters, invisible characters and percent signs', () => {
    expect(sanitizeItemName('a/b:c*d?e"f<g>h|i')).toBe('abcdefghi');
    expect(sanitizeItemName('emoji 😀 here')).toBe('emoji  here');
    expect(sanitizeItemName('zero​width‍join‮bidi')).toBe('zerowidthjoinbidi');
    expect(sanitizeItemName('50% off')).toBe('50 off');
    expect(sanitizeItemName('tab\there')).toBe('tabhere');
  });
  it('turns Windows reserved names into _, and empty into _', () => {
    for (const n of ['con', 'NUL', 'Com1', 'lpt9', 'aux', 'prn', 'con.', '???', '   ', '😀', '..'])
      expect(sanitizeItemName(n)).toBe('_');
    expect(sanitizeItemName('concert')).toBe('concert');
  });
  it('drops trailing spaces and dots, keeps inner ones, and NFC-normalizes', () => {
    expect(sanitizeItemName('  name. . ')).toBe('name');
    expect(sanitizeItemName('a.b')).toBe('a.b');
    expect(sanitizeItemName('Café')).toBe('Café');
  });
  it('caps characters and 200 UTF-8 bytes without cutting a character or leaving a trailing dot', () => {
    expect(sanitizeItemName('x'.repeat(500), 120)).toHaveLength(120);
    const cyr = sanitizeItemName('Ж'.repeat(300), 250);
    expect(Buffer.byteLength(cyr)).toBeLessThanOrEqual(200);
    expect(cyr).toBe('Ж'.repeat(100));
    expect(sanitizeItemName('abc.' + 'd'.repeat(50), 4)).toBe('abc');
  });
  it('never leaves HTML entities that Eagle would auto-rename', () => {
    expect(sanitizeItemName('a &lt;b&gt; c')).toBe('a b c');
    expect(sanitizeItemName('Tom &amp; Jerry')).toBe('Tom & Jerry');
    expect(sanitizeItemName('x &amp;lt; y')).toBe('x  y');
  });
  it('folder names: Windows rules, but emoji and inner spaces collapse are fine', () => {
    expect(sanitizeFolderName('  My   Folder: v2. ')).toBe('My Folder v2');
    expect(sanitizeFolderName('CON')).toBe('CON_');
    expect(sanitizeFolderName('Sketches 🎨')).toBe('Sketches 🎨');
    expect(sanitizeFolderName('???')).toBe('_');
  });
});

describe('manual order', () => {
  it('compares as strings, like Eagle', () => {
    expect(compareOrder('1708727558963.5', '1708727558963.56')).toBeLessThan(0);
    expect(compareOrder('9', '10')).toBeGreaterThan(0); // string order, on purpose
    expect(compareOrder('5', '5')).toBe(0);
  });
  it('parses and prints long decimals exactly', () => {
    const k = '1708727558963.56655092592592592596';
    expect(formatDecimal(parseDecimal(k))).toBe(k);
    expect(formatDecimal(parseDecimal('1790620130479.50'))).toBe('1790620130479.5');
    expect(formatDecimal(parseDecimal('1790620130479'))).toBe('1790620130479');
    expect(formatDecimal(parseDecimal('.25'))).toBe('0.25');
  });
  it('one item goes to the midpoint; more are spaced evenly and stay strictly between, in display order', () => {
    expect(placeBetween('1000', '990', 1)).toEqual(['995']);
    const three = placeBetween('1708727558963.56655092592592592596', '1708727558963', 3);
    expect(three).toHaveLength(3);
    const all = ['1708727558963.56655092592592592596', ...three, '1708727558963'];
    for (let i = 0; i < all.length - 1; i++)
      expect(parseDecimal(all[i])).toBeGreaterThan(parseDecimal(all[i + 1]));
    // ascending display flips the direction of the list
    const asc = placeBetween('990', '1000', 2, { descending: false });
    expect(asc.map(parseDecimal)[0]).toBeLessThan(asc.map(parseDecimal)[1]);
  });
  it('at an edge it uses the neighbor plus or minus 1', () => {
    expect(placeBetween(null, '1000', 1)).toEqual(['1000.5']);
    expect(placeBetween('1000', null, 1)).toEqual(['999.5']);
    expect(placeBetween(null, '1000', 1, { descending: false })).toEqual(['999.5']);
  });
  it('refuses when there is no room, and spreadDuplicates makes room', () => {
    expect(() => placeBetween('5', '5', 1)).toThrow(/spread/i);
    const keys = ['300', '200', '200', '200', '100'];
    const spread = spreadDuplicates(keys);
    expect(spread[0]).toBe('300');
    expect(spread[4]).toBe('100');
    expect(new Set(spread).size).toBe(5);
    expect(spread.every((k, i) => i === 0 || compareOrder(spread[i - 1], k) > 0)).toBe(true);
    expect(
      spread
        .slice(1, 4)
        .every(
          (k) => parseDecimal(k) < parseDecimal('300') && parseDecimal(k) > parseDecimal('100'),
        ),
    ).toBe(true);
    expect(spreadDuplicates(['3', '2', '1'])).toEqual(['3', '2', '1']);
  });
});

describe('versions', () => {
  it('compares dotted parts numerically, fails closed', () => {
    expect(isSupportedVersion('4.0.0')).toBe(true);
    expect(isSupportedVersion('3.9.9')).toBe(true);
    expect(isSupportedVersion('4.0.1')).toBe(false);
    expect(isSupportedVersion('4.10.0')).toBe(false);
    expect(isSupportedVersion('5')).toBe(false);
    expect(isSupportedVersion(undefined)).toBe(false);
    expect(isSupportedVersion('banana')).toBe(false);
  });
});

describe('createLibrary and probeLibrary', () => {
  it("writes Eagle's skeleton byte for byte", async () => {
    const parent = await scratch();
    const before = Date.now();
    const lib = await createLibrary(parent, 'My: Lib.library');
    expect(lib).toBe(join(parent, 'My Lib.library'));
    const meta = await readText(join(lib, 'metadata.json'));
    const m =
      /^\{"applicationVersion":"4\.0\.0","folders":\[\],"smartFolders":\[\],"quickAccess":\[\],"tagsGroups":\[\],"modificationTime":(\d+)\}$/.exec(
        meta,
      );
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(before);
    expect(await readText(join(lib, 'mtime.json'))).toBe('{}');
    expect(await readText(join(lib, 'tags.json'))).toBe('{"historyTags":[],"starredTags":[]}');
    expect(await readText(join(lib, 'saved-filters.json'))).toBe('[]');
    expect(await readText(join(lib, 'actions.json'))).toBe('[]');
    expect((await stat(join(lib, 'images'))).isDirectory()).toBe(true);
    expect((await stat(join(lib, 'backup'))).isDirectory()).toBe(true);
    expect((await readdir(lib)).sort()).toEqual([
      'actions.json',
      'backup',
      'images',
      'metadata.json',
      'mtime.json',
      'saved-filters.json',
      'tags.json',
    ]);
    await expect(createLibrary(parent, 'My Lib')).rejects.toThrow(/already exists/);
    expect(await probeLibrary(lib)).toEqual({
      ok: true,
      applicationVersion: '4.0.0',
      reason: null,
    });
    // and it opens and lists cleanly
    const { lib: open } = await openLib(lib);
    expect(await open.listItemIds()).toEqual([]);
    expect((await open.readRoot()).value.applicationVersion).toBe('4.0.0');
    await open.close();
  });
  it('probe reports not-a-library and newer versions without throwing', async () => {
    const dir = await scratch();
    const none = await probeLibrary(dir);
    expect(none.ok).toBe(false);
    expect(none.applicationVersion).toBeNull();
    const lib = await createLibrary(dir, 'newer');
    const meta = (await readText(join(lib, 'metadata.json'))).replace('"4.0.0"', '"4.1.0"');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(lib, 'metadata.json'), meta);
    const p = await probeLibrary(lib);
    expect(p).toMatchObject({ ok: false, applicationVersion: '4.1.0' });
    expect(p.reason).toMatch(/newer Eagle/);
  });
  it('refuses to create outside the writable roots', async () => {
    setWritableRoots([join(TMP, 'somewhere-else')]);
    try {
      await expect(createLibrary(await scratch(), 'nope')).rejects.toThrow(/Write blocked/);
    } finally {
      allowTmp();
    }
  });
});

describe('reading the real Art Archive (read-only)', () => {
  it.skipIf(!templates.includes('art-archive') || USING_FIXTURES)(
    'lists ids and reads all 5.4k items fast',
    async () => {
      const path = join(TEMPLATES, 'art-archive.library');
      const { lib } = await openLib(path, { readOnly: true });
      const t0 = performance.now();
      const ids = await lib.listItemIds();
      let ok = 0;
      let next = 0;
      const worker = async () => {
        while (next < ids.length) {
          const doc = await lib.readItem(ids[next++]);
          if (doc && doc.value.id) ok++;
        }
      };
      await Promise.all(Array.from({ length: 32 }, worker));
      const ms = performance.now() - t0;
      console.log(`art-archive: ${ids.length} ids, ${ok} items read in ${ms.toFixed(0)} ms`);
      expect(ids.length).toBeGreaterThan(5000);
      expect(ok).toBeGreaterThan(5000);
      expect(ms).toBeLessThan(2000);
      await lib.close();
    },
  );
});
