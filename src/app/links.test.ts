import { describe, expect, it } from 'vitest';
import { referenceList, revealFromEagleUrl, urlsFromClipboardText } from './links';

describe('eagle:// links', () => {
  it('reveal items, folders and smart folders; anything else only focuses the window', () => {
    expect(revealFromEagleUrl('eagle://item/LT24XY3DPJFLK')).toEqual({
      kind: 'item',
      id: 'LT24XY3DPJFLK',
    });
    expect(revealFromEagleUrl('eagle://folder/KBHG6KA0Y5S9W/')).toEqual({
      kind: 'folder',
      id: 'KBHG6KA0Y5S9W',
    });
    expect(revealFromEagleUrl('EAGLE://smart-folder/M0Y5?x=1')).toEqual({
      kind: 'smartFolder',
      id: 'M0Y5',
    });
    for (const odd of ['eagle://open', 'eagle://item/', 'eagle://item/../x', 'eagle://tag/abc'])
      expect(revealFromEagleUrl(odd), odd).toBeNull();
  });
});

describe('pasted links', () => {
  it('takes a list of web addresses, but not a sentence that happens to contain one', () => {
    expect(urlsFromClipboardText('https://a.com/1.jpg\n\nhttp://b.org/page \n')).toEqual([
      'https://a.com/1.jpg',
      'http://b.org/page',
    ]);
    expect(urlsFromClipboardText('see https://a.com/1.jpg')).toEqual([]);
    expect(urlsFromClipboardText('https://a.com\nnot a link')).toEqual([]);
    expect(urlsFromClipboardText('javascript:alert(1)')).toEqual([]);
    expect(urlsFromClipboardText('data:image/png;base64,iVBOR')).toEqual([
      'data:image/png;base64,iVBOR',
    ]);
  });

  it('reads a uri-list, skipping comments and files (those come back as paths)', () => {
    const list =
      '# from Firefox\r\nhttps://a.com/x.png\r\nfile:///home/user/a.png\r\nhttps://a.com/x.png';
    expect(urlsFromClipboardText(list, true)).toEqual(['https://a.com/x.png']);
  });
});

describe('reference window list', () => {
  it('keeps the order given, always holds the opened item, and drops ids that are not ids', () => {
    expect(referenceList('B', ['A', 'B', 'C', 'B'])).toEqual(['A', 'B', 'C']);
    expect(referenceList('X', ['A', 'B'])).toEqual(['X', 'A', 'B']);
    expect(referenceList('A', ['A', 'bad,id', '../x'])).toEqual(['A']);
    expect(referenceList('A', undefined)).toEqual(['A']);
  });

  it('caps a huge selection to a window around the opened item', () => {
    const ids = Array.from({ length: 12_000 }, (_, i) => `I${i}`);
    const list = referenceList('I9000', ids);
    expect(list).toHaveLength(5000);
    expect(list).toContain('I9000');
    expect(list[0]).toBe('I6500');
  });
});
