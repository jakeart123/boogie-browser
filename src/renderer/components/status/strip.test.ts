import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '../../../shared/types';
import { externalText, oldCopiesText, partnerText, portLines, syncText } from './strip';

const entry = (actorName: string, label: string): HistoryEntry => ({
  groupId: 'g',
  libraryId: 'l',
  actor: { kind: 'external', name: actorName },
  label,
  at: 0,
  itemIds: [],
  itemCount: 0,
  kind: 'external',
  undoable: false,
  undoneBy: null,
});

describe('status strip words', () => {
  it('names who made an outside change without saying it twice', () => {
    expect(externalText(entry('Sam', 'Sam added 12 items to Prix de Rome'), 'Sam')).toBe(
      'Sam added 12 items to Prix de Rome',
    );
    expect(externalText(entry('Sam', 'Added 12 items to Prix de Rome'), 'Sam')).toBe(
      'Sam added 12 items to Prix de Rome',
    );
    // No partner name: the core's stand-in actor is not a person, and the label stands alone.
    const stale = 'Your partner’s Eagle may have written an old copy over your change';
    expect(externalText(entry('Dropbox', stale), null)).toBe(stale);
  });
  it('uses the sync detail from the core, with fixed words as the fallback', () => {
    expect(syncText({ state: 'syncing', detail: 'Syncing 3 files…', conflicts: [] })).toBe(
      'Syncing 3 files…',
    );
    expect(syncText({ state: 'offline', detail: ' ', conflicts: [] })).toBe('Dropbox is offline');
    expect(syncText(null)).toBe('Dropbox status unknown');
  });
  it('lists what is listening, or why nothing is', () => {
    expect(portLines({ eagleApi: 41595, extension: 41593, mcp: 41597, reason: null })).toEqual([
      'Eagle extension API on 41595',
      'Extension link on 41593',
      'MCP on 41597',
    ]);
    expect(
      portLines({ eagleApi: null, extension: null, mcp: null, reason: 'Eagle is using 41595' }),
    ).toEqual(['Eagle is using 41595']);
  });
});

describe('the partner’s Eagle', () => {
  it('says whether it is open and how many of your changes it has not shown yet', () => {
    const p = (active: boolean, pending: number) => ({ active, lastSeen: 1, pending });
    expect(partnerText(p(true, 3), 'Sam')).toBe('Sam’s Eagle is open · 3 of your changes waiting');
    expect(partnerText(p(true, 0), 'Sam')).toBe('Sam’s Eagle is open');
    expect(partnerText(p(false, 1), null)).toBe(
      'The other Eagle isn’t open · 1 of your changes waiting',
    );
    expect(partnerText(p(false, 0), 'Sam')).toBeNull();
    expect(partnerText(undefined, 'Sam')).toBeNull();
  });
  it('counts changes the partner’s Eagle may have overwritten, and names whose Eagle', () => {
    const p = { active: false, lastSeen: null, pending: 0 };
    expect(oldCopiesText({ ...p, oldCopies: 3 }, 'Sam')).toBe(
      '3 of your changes may have been overwritten by Sam’s Eagle',
    );
    expect(oldCopiesText({ ...p, oldCopies: 1 }, null)).toBe(
      '1 of your changes may have been overwritten by your partner’s Eagle',
    );
    expect(oldCopiesText({ ...p, oldCopies: 0 }, 'Sam')).toBeNull();
    expect(oldCopiesText(p, 'Sam')).toBeNull();
  });
});
