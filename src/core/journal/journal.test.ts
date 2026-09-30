import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EagleItemRecord, EagleRootRecord } from '../../shared/types';
import type { Doc, JournalGroup, UndoPlan } from '../contracts';
import { createJournal, type JournalStore } from './index';

// ───────────── a tiny fake of what the Eagle adapter does to the journal ─────────────

const LIB = 'abcdef0123456789';
const YOU = { kind: 'user', name: 'You' } as const;
const scratch = resolve('.tmp/journal');

type Rec = Record<string, any>;

class FakeLibrary {
  files = new Map<string, string>();
  renames: { id: string; to: string }[] = [];
  constructor(readonly journal: JournalStore) {}

  path = (id: string) => `images/${id}.info/metadata.json`;
  put(id: string, rec: Rec) {
    this.files.set(this.path(id), JSON.stringify(rec));
  }
  item = (id: string): Rec | null =>
    this.files.has(this.path(id)) ? JSON.parse(this.files.get(this.path(id))!) : null;
  root = (): Rec => JSON.parse(this.files.get('metadata.json')!);
  setRoot(rec: Rec) {
    this.files.set('metadata.json', JSON.stringify(rec));
  }

  /** Same order as the adapter: read, mutate, journal the before/after, then replace the file. */
  edit(group: JournalGroup, id: string, mutate: (r: Rec) => void) {
    const before = this.files.get(this.path(id)) ?? null;
    const rec = before === null ? {} : JSON.parse(before);
    mutate(rec);
    const after = JSON.stringify(rec);
    this.journal.recordFile(group, { relPath: this.path(id), before, after, itemId: id });
    this.files.set(this.path(id), after);
  }
  editRoot(group: JournalGroup, mutate: (r: Rec) => void) {
    const before = this.files.get('metadata.json')!;
    const rec = JSON.parse(before);
    mutate(rec);
    const after = JSON.stringify(rec);
    this.journal.recordFile(group, { relPath: 'metadata.json', before, after, itemId: null });
    this.files.set('metadata.json', after);
  }

  /** One user action: begin, do the writes, commit. */
  act(label: string, run: (g: JournalGroup) => void, ids: string[] = []) {
    const g = this.journal.begin(LIB, YOU, label, 'items');
    run(g);
    return this.journal.commit(g, { itemIds: ids })!;
  }

  current = {
    readItem: async (id: string): Promise<Doc<EagleItemRecord> | null> => {
      const text = this.files.get(this.path(id));
      return text === undefined ? null : { value: JSON.parse(text), text };
    },
    readRoot: async (): Promise<Doc<EagleRootRecord>> => {
      const text = this.files.get('metadata.json')!;
      return { value: JSON.parse(text), text };
    },
  };

  /** What the service does with a plan: apply through the adapter into one 'undo' group. */
  async applyPlan(plan: UndoPlan) {
    const g = this.journal.begin(LIB, YOU, plan.label, 'undo');
    for (const it of plan.items) {
      this.edit(g, it.id, (r) => {
        it.apply(r as EagleItemRecord);
      });
      if (it.renameTo !== undefined) this.renames.push({ id: it.id, to: it.renameTo });
    }
    if (plan.root) this.editRoot(g, (r) => void plan.root!(r as EagleRootRecord));
    this.journal.markUndone(plan.groupId, g.id); // lands at commit, dropped if nothing changed
    return this.journal.commit(g, { itemIds: plan.items.map((i) => i.id) });
  }
  async undo(groupId: string) {
    const plan = await this.journal.planUndo(groupId, this.current);
    return { plan, entry: await this.applyPlan(plan) };
  }
}

const item = (id: string, extra: Rec = {}): Rec => ({
  id,
  name: `name ${id}`,
  tags: [],
  folders: [],
  isDeleted: false,
  annotation: '',
  lastModified: 1000,
  ...extra,
});

let dir: string;
let journal: JournalStore;
let lib: FakeLibrary;

beforeEach(() => {
  mkdirSync(scratch, { recursive: true });
  dir = mkdtempSync(join(scratch, 'j-'));
  journal = createJournal({ dir });
  lib = new FakeLibrary(journal);
});
afterEach(() => {
  journal.close();
  rmSync(dir, { recursive: true, force: true }); // our own scratch folder under .tmp/journal
});

describe('undo of item changes', () => {
  it('tag added, then someone else adds another tag: undo removes only ours', async () => {
    lib.put('A', item('A', { tags: ['old'] }));
    const entry = lib.act('Tagged 1 item', (g) => lib.edit(g, 'A', (r) => r.tags.push('ours')), [
      'A',
    ]);
    // The partner adds a tag afterwards, outside the journal.
    const cur = lib.item('A')!;
    cur.tags.push('by-sam');
    lib.put('A', cur);

    const { plan } = await lib.undo(entry.groupId);
    expect(plan.conflicts).toEqual([]);
    expect(plan.label).toBe('Undo: Tagged 1 item');
    expect(lib.item('A')!.tags).toEqual(['old', 'by-sam']);
  });

  it('with nothing changed since, tags come back in their exact original order', async () => {
    lib.put('A', item('A', { tags: ['b', 'a', 'c'] }));
    const entry = lib.act('Untagged', (g) => lib.edit(g, 'A', (r) => (r.tags = ['c'])), ['A']);
    await lib.undo(entry.groupId);
    expect(lib.item('A')!.tags).toEqual(['b', 'a', 'c']);
  });

  it('star 3 to 5, but it is 4 now: reports a conflict and leaves the rating alone', async () => {
    lib.put('A', item('A', { star: 3, annotation: 'x' }));
    const entry = lib.act(
      'Edited',
      (g) => lib.edit(g, 'A', (r) => ((r.star = 5), (r.annotation = 'y'))),
      ['A'],
    );
    const cur = lib.item('A')!;
    cur.star = 4;
    lib.put('A', cur);

    const { plan } = await lib.undo(entry.groupId);
    expect(plan.conflicts).toEqual([{ id: 'A', field: 'star', reason: 'changed since' }]);
    // The other field in the same action is still undone; the rating is untouched.
    expect(lib.item('A')).toMatchObject({ star: 4, annotation: 'x' });
  });

  it('a conflict on the only changed field yields no plan item at all', async () => {
    lib.put('A', item('A', { star: 3 }));
    const entry = lib.act('Rated', (g) => lib.edit(g, 'A', (r) => (r.star = 5)), ['A']);
    const cur = lib.item('A')!;
    cur.star = 4;
    lib.put('A', cur);
    const plan = await journal.planUndo(entry.groupId, lib.current);
    expect(plan.items).toEqual([]);
    expect(plan.conflicts).toHaveLength(1);
  });

  it('unrating: absent star comes back, and undoing a first rating deletes the key', async () => {
    lib.put('A', item('A'));
    const rated = lib.act('Rated', (g) => lib.edit(g, 'A', (r) => (r.star = 4)), ['A']);
    await lib.undo(rated.groupId);
    expect('star' in lib.item('A')!).toBe(false);
  });

  it('trash then undo: isDeleted false and deletedTime removed; restore then undo re-trashes', async () => {
    lib.put('A', item('A'));
    const trashed = lib.act(
      'Trashed',
      (g) => lib.edit(g, 'A', (r) => ((r.isDeleted = true), (r.deletedTime = 555))),
      ['A'],
    );
    await lib.undo(trashed.groupId);
    expect(lib.item('A')!.isDeleted).toBe(false);
    expect('deletedTime' in lib.item('A')!).toBe(false);

    lib.put('B', item('B', { isDeleted: true, deletedTime: 777 }));
    const restored = lib.act(
      'Restored',
      (g) => lib.edit(g, 'B', (r) => ((r.isDeleted = false), delete r.deletedTime)),
      ['B'],
    );
    await lib.undo(restored.groupId);
    expect(lib.item('B')).toMatchObject({ isDeleted: true, deletedTime: 777 });
  });

  it('rename: the plan asks the service to rename through the adapter and does not touch name itself', async () => {
    lib.put('A', item('A', { name: 'P1060228' }));
    const entry = lib.act('Renamed', (g) => lib.edit(g, 'A', (r) => (r.name = 'Dehaisne 1876')), [
      'A',
    ]);
    const plan = await journal.planUndo(entry.groupId, lib.current);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].renameTo).toBe('P1060228');
    const rec = lib.item('A') as EagleItemRecord;
    expect(plan.items[0].apply(rec)).toBe(false);
    expect(rec.name).toBe('Dehaisne 1876');

    const cur = lib.item('A')!;
    cur.name = 'Someone else renamed it';
    lib.put('A', cur);
    const again = await journal.planUndo(entry.groupId, lib.current);
    expect(again.conflicts).toEqual([{ id: 'A', field: 'name', reason: 'changed since' }]);
  });

  it('an item the group created is trashed by undo, never deleted', async () => {
    const entry = lib.act(
      'Imported 1 item',
      (g) => lib.edit(g, 'N', (r) => Object.assign(r, item('N'))),
      ['N'],
    );
    const { plan } = await lib.undo(entry.groupId);
    expect(plan.items.map((i) => i.id)).toEqual(['N']);
    expect(lib.item('N')).toMatchObject({ isDeleted: true });
    expect(typeof lib.item('N')!.deletedTime).toBe('number');
  });

  it('manual order and palette noise: only the changed folder entry is undone, $$hashKey is ignored', async () => {
    lib.put(
      'A',
      item('A', { order: { f1: '10', f2: '20' }, palettes: [{ color: [1, 2, 3], ratio: 1 }] }),
    );
    const entry = lib.act(
      'Reordered',
      (g) =>
        lib.edit(g, 'A', (r) => {
          r.order.f1 = '15';
          r.palettes[0].$$hashKey = 'object:12'; // Eagle's own noise
        }),
      ['A'],
    );
    const cur = lib.item('A')!;
    cur.order.f2 = '25'; // someone reordered in another folder since
    lib.put('A', cur);
    const { plan } = await lib.undo(entry.groupId);
    expect(plan.conflicts).toEqual([]);
    expect(lib.item('A')!.order).toEqual({ f1: '10', f2: '25' });
    expect(lib.item('A')!.palettes[0].$$hashKey).toBe('object:12'); // not a change worth undoing
  });

  it('a group with several writes to one file (import: write, then palette) is one net change', async () => {
    const entry = lib.act(
      'Imported',
      (g) => {
        lib.edit(g, 'N', (r) => Object.assign(r, item('N', { processingPalette: true })));
        lib.edit(g, 'N', (r) => {
          delete r.processingPalette;
          r.palettes = [];
        });
      },
      ['N'],
    );
    const { plan } = await lib.undo(entry.groupId);
    expect(plan.items).toHaveLength(1);
    expect(lib.item('N')!.isDeleted).toBe(true);
  });

  it('undo then redo (undo of the undo group) puts the change back', async () => {
    lib.put('A', item('A', { tags: ['x'] }));
    const entry = lib.act('Tagged', (g) => lib.edit(g, 'A', (r) => r.tags.push('y')), ['A']);
    const undone = await lib.undo(entry.groupId);
    expect(lib.item('A')!.tags).toEqual(['x']);
    const redone = await lib.undo(undone.entry!.groupId);
    expect(lib.item('A')!.tags).toEqual(['x', 'y']);

    const history = journal.list(LIB);
    expect(history.map((h) => [h.kind, h.undoable, h.undoneBy !== null])).toEqual([
      ['undo', true, false], // the redo: can be undone again
      ['undo', false, true],
      ['items', false, true], // undone: not offered again
    ]);
    expect(redone.entry!.undoable).toBe(true);
    // The committed entries already say what they undid, so the UI needn't parse "Undo: ".
    expect(undone.entry!.undoOf).toBe(entry.groupId);
    expect(redone.entry!.undoOf).toBe(undone.entry!.groupId);
    expect(history.map((h) => h.undoOf)).toEqual([undone.entry!.groupId, entry.groupId, null]);
  });

  it('an already undone group gives an empty plan, not a second undo', async () => {
    lib.put('A', item('A', { tags: [] }));
    const entry = lib.act('Tagged', (g) => lib.edit(g, 'A', (r) => r.tags.push('y')), ['A']);
    // Linking after the undo group committed works too.
    const first = await journal.planUndo(entry.groupId, lib.current);
    const u = journal.begin(LIB, YOU, first.label, 'undo');
    for (const it of first.items) lib.edit(u, it.id, (r) => void it.apply(r as EagleItemRecord));
    const undoEntry = journal.commit(u, { itemIds: ['A'] })!;
    journal.markUndone(entry.groupId, undoEntry.groupId);
    expect(journal.getEntry(undoEntry.groupId)!.undoOf).toBe(entry.groupId);
    const plan = await journal.planUndo(entry.groupId, lib.current);
    expect(plan.items).toEqual([]);
    expect(plan.conflicts[0].reason).toBe('already undone');
  });

  it('permanent delete: plan moves the stored folder back, and skips it if the copy is gone', async () => {
    const store = journal.storeDirFor(LIB);
    const stored = join(store, 'g1', 'A.info');
    mkdirSync(stored, { recursive: true });
    const g = journal.begin(LIB, YOU, 'Deleted 1 item permanently', 'delete');
    journal.recordMoveOut(g, { itemId: 'A', storedAt: stored });
    const entry = journal.commit(g, { itemIds: ['A'] })!;
    expect(entry.undoable).toBe(true);
    expect(journal.listStored(LIB).map((s) => s.itemId)).toEqual(['A']);

    const plan = await journal.planUndo(entry.groupId, lib.current);
    expect(plan.moveBackIn).toEqual([{ itemId: 'A', storedAt: stored }]);

    lib.put('A', item('A')); // it is already back in the library
    expect((await journal.planUndo(entry.groupId, lib.current)).conflicts[0]).toMatchObject({
      id: 'A',
      reason: 'already in the library',
    });
  });
});

describe('external changes', () => {
  it('are stored as an undoable external group and undo works field by field', async () => {
    lib.put('A', item('A', { tags: ['a'], star: 2 }));
    const before = lib.files.get(lib.path('A'))!;
    const rec = lib.item('A')!;
    rec.tags.push('from-sam');
    rec.star = 5;
    lib.put('A', rec);
    const after = lib.files.get(lib.path('A'))!;

    const entry = journal.recordExternal(
      LIB,
      { kind: 'external', name: 'Sam' },
      [
        { itemId: 'A', relPath: lib.path('A'), before, after },
        { itemId: null, relPath: 'mtime.json', before: '{"all":1}', after: '{"all":2}' },
      ],
      'Sam changed 1 item',
    )!;
    expect(entry).toMatchObject({
      kind: 'external',
      undoable: true,
      itemIds: ['A'],
      itemCount: 1,
      label: 'Sam changed 1 item',
    });
    expect(entry.actor).toEqual({ kind: 'external', name: 'Sam' });

    await lib.undo(entry.groupId);
    expect(lib.item('A')).toMatchObject({ tags: ['a'], star: 2 });
  });

  it('nothing worth recording gives null (mtime.json alone, or identical text)', () => {
    expect(
      journal.recordExternal(
        LIB,
        { kind: 'external', name: 'Sam' },
        [{ itemId: null, relPath: 'mtime.json', before: 'a', after: 'b' }],
        'x',
      ),
    ).toBeNull();
    expect(
      journal.recordExternal(
        LIB,
        { kind: 'external', name: 'Sam' },
        [{ itemId: 'A', relPath: 'images/A.info/metadata.json', before: 'a', after: 'a' }],
        'x',
      ),
    ).toBeNull();
  });
});

describe("a partner's Eagle writing an old copy back (stale overwrite)", () => {
  const SAM = { kind: 'external', name: 'Sam' } as const;

  it('pending items keep the copy from before the first pending change; new items are never pending', () => {
    lib.put('A', item('A', { tags: ['old'] }));
    const base = lib.files.get(lib.path('A'))!;
    const first = lib.act('Tag', (g) => lib.edit(g, 'A', (r) => r.tags.push('one')), ['A']);
    const second = lib.act('Rate', (g) => lib.edit(g, 'A', (r) => (r.star = 5)), ['A']);
    const added = lib.act('Import', (g) => lib.edit(g, 'N', (r) => Object.assign(r, item('N'))));
    for (const e of [first, second, added]) journal.markPartnerPending(e.groupId);
    expect(journal.partnerPendingIds(LIB)).toEqual(['A']);
    expect(journal.partnerPendingBase(LIB, 'A')).toBe(base);
    expect(journal.partnerPendingBase(LIB, 'N')).toBeUndefined();
    journal.clearPartnerPending(LIB, ['A']);
    expect(journal.partnerPendingIds(LIB)).toEqual([]);
    expect(journal.partnerPendingBase(LIB, 'A')).toBeUndefined();
  });

  it("undo puts back only what the old copy reverted and keeps the partner's own new edits", async () => {
    lib.put('A', item('A', { tags: ['keep', 'drop-me'], star: 1, annotation: 'base note' }));
    const base = lib.files.get(lib.path('A'))!;
    // Your change, which the partner's Eagle never showed: +mine, -drop-me, 4 stars, a note.
    lib.act('Edit', (g) =>
      lib.edit(g, 'A', (r) => {
        r.tags = ['keep', 'mine'];
        r.star = 4;
        r.annotation = 'my note';
      }),
    );
    const ours = lib.files.get(lib.path('A'))!;
    // Their Eagle saves its old copy plus their own edit: a new tag and a URL.
    const theirsRec = { ...JSON.parse(base), tags: ['keep', 'drop-me', 'sam'], url: 'https://r' };
    lib.put('A', { ...theirsRec, lastModified: 2000 });
    const theirs = lib.files.get(lib.path('A'))!;

    const entry = journal.recordExternal(
      LIB,
      SAM,
      [{ itemId: 'A', relPath: lib.path('A'), before: ours, after: theirs }],
      "Sam's Eagle wrote an old copy",
      { staleBases: { A: base } },
    )!;
    expect(entry.staleOverwrite).toBe(true);
    expect(journal.getEntry(entry.groupId)?.staleOverwrite).toBe(true);

    await lib.undo(entry.groupId);
    expect(lib.item('A')).toMatchObject({
      tags: ['keep', 'sam', 'mine'], // yours back, theirs kept, the tag you removed stays removed
      star: 4,
      annotation: 'my note',
      url: 'https://r',
    });
    expect(journal.getEntry(entry.groupId)?.undoneBy).toBeTruthy();
  });

  it('an item their Eagle had picked up (seen) starts pending over from the next change', () => {
    lib.put('A', item('A', { tags: ['old'] }));
    const first = lib.act('Tag', (g) => lib.edit(g, 'A', (r) => r.tags.push('one')), ['A']);
    journal.markPartnerPending(first.groupId);
    expect(journal.partnerPendingCount(LIB)).toBe(1);
    journal.markPartnerSeen(LIB, ['A']);
    expect(journal.partnerPendingState(LIB, 'A')?.seen).toBe(true);
    expect(journal.partnerPendingCount(LIB)).toBe(0); // not waiting any more
    expect(journal.partnerPendingIds(LIB, { unseenOnly: true })).toEqual([]);
    const seenVersion = lib.files.get(lib.path('A'))!;
    const second = lib.act('Rate', (g) => lib.edit(g, 'A', (r) => (r.star = 5)), ['A']);
    journal.markPartnerPending(second.groupId);
    expect(journal.partnerPendingState(LIB, 'A')).toEqual({ base: seenVersion, seen: false });
    journal.clearAllPartnerPending(LIB);
    expect(journal.partnerPendingIds(LIB)).toEqual([]);
  });

  it('"Keep theirs" resolves an entry: it survives reopening and stops counting', () => {
    const change = [
      { itemId: 'A', relPath: lib.path('A'), before: '{"id":"A"}', after: '{"id":"A","star":1}' },
    ];
    const stale = journal.recordExternal(LIB, SAM, change, 'may have', {
      staleBases: { A: '{"id":"A"}' },
    })!;
    const plain = journal.recordExternal(LIB, SAM, change, 'Sam edited 1 item')!;
    expect(journal.countStale(LIB, 0)).toBe(1);
    expect(journal.markKeptTheirs(plain.groupId)?.keptTheirs).toBeUndefined(); // not a stale entry
    expect(journal.markKeptTheirs(stale.groupId)).toMatchObject({ keptTheirs: true });
    journal.close();
    journal = createJournal({ dir });
    expect(journal.getEntry(stale.groupId)).toMatchObject({
      staleOverwrite: true,
      keptTheirs: true,
    });
    expect(journal.countStale(LIB, 0)).toBe(0);
  });

  it('seen rows go a day after they were marked', () => {
    let clock = 1_790_000_000_000;
    journal.close();
    journal = createJournal({ dir, now: () => clock });
    lib = new FakeLibrary(journal);
    lib.put('A', item('A'));
    lib.put('B', item('B'));
    const e = lib.act(
      'Tag',
      (g) => {
        lib.edit(g, 'A', (r) => r.tags.push('x'));
        lib.edit(g, 'B', (r) => r.tags.push('x'));
      },
      ['A', 'B'],
    );
    journal.markPartnerPending(e.groupId);
    journal.markPartnerSeen(LIB, ['A']);
    clock += 25 * 60 * 60_000; // a day and an hour later, the next open
    journal.close();
    journal = createJournal({ dir, now: () => clock });
    expect(journal.partnerPendingIds(LIB)).toEqual(['B']); // the unseen one stays
  });

  it('a v2 database gets the seen and kept columns', () => {
    lib.put('A', item('A'));
    const e = lib.act('Tag', (g) => lib.edit(g, 'A', (r) => r.tags.push('x')), ['A']);
    journal.markPartnerPending(e.groupId);
    journal.close();
    const db = new Database(join(dir, LIB, 'journal.sqlite'));
    db.exec(
      'ALTER TABLE partner_pending DROP COLUMN seen; ALTER TABLE groups DROP COLUMN kept; PRAGMA user_version = 2',
    );
    db.close();
    journal = createJournal({ dir });
    expect(journal.partnerPendingState(LIB, 'A')?.seen).toBe(false);
    expect(journal.countStale(LIB, 0)).toBe(0);
  });

  it('a v3 database (with the old repair column) opens and records new entries', () => {
    lib.put('A', item('A'));
    lib.act('Tag', (g) => lib.edit(g, 'A', (r) => r.tags.push('x')), ['A']);
    journal.close();
    const db = new Database(join(dir, LIB, 'journal.sqlite'));
    db.exec(
      'ALTER TABLE groups DROP COLUMN kept; ALTER TABLE groups ADD COLUMN heal INTEGER NOT NULL DEFAULT 0; PRAGMA user_version = 3',
    );
    db.close();
    journal = createJournal({ dir });
    lib = new FakeLibrary(journal);
    lib.put('A', item('A'));
    const e = lib.act('Tag again', (g) => lib.edit(g, 'A', (r) => r.tags.push('y')), ['A']);
    expect(journal.getEntry(e.groupId)).toMatchObject({ label: 'Tag again' });
    expect(journal.list(LIB)).toHaveLength(2);
  });

  it('a v1 database gets the new column on open and keeps its history', () => {
    lib.put('A', item('A'));
    const e = lib.act('Tag', (g) => lib.edit(g, 'A', (r) => r.tags.push('x')), ['A']);
    journal.close();
    const db = new Database(join(dir, LIB, 'journal.sqlite'));
    db.exec(
      'DROP TABLE partner_pending; DROP TABLE stale_bases; ALTER TABLE groups DROP COLUMN stale; PRAGMA user_version = 1',
    );
    db.close();
    journal = createJournal({ dir });
    lib = new FakeLibrary(journal);
    expect(journal.list(LIB).map((h) => h.groupId)).toEqual([e.groupId]);
    journal.markPartnerPending(e.groupId);
    expect(journal.partnerPendingIds(LIB)).toEqual(['A']);
  });
});

describe('undo of tags.json, saved-filters.json and thumbnails', () => {
  const edit = (g: JournalGroup, relPath: string, before: unknown, after: unknown) =>
    journal.recordFile(g, {
      relPath,
      before: before === null ? null : JSON.stringify(before),
      after: JSON.stringify(after),
      itemId: null,
    });
  const run = <T>(apply: ((v: T) => boolean) | null | undefined, value: T) => {
    const v = structuredClone(value);
    return { changed: apply!(v), value: v };
  };

  it('a tag rename moved a star: undo moves it back, and a star added since stays', async () => {
    const entry = lib.act('Renamed tag cat', (g) =>
      edit(
        g,
        'tags.json',
        { historyTags: [], starredTags: ['cat', 'dog'] },
        { historyTags: [], starredTags: ['kitty', 'dog'] },
      ),
    );
    expect(entry.undoable).toBe(true);
    const plan = await journal.planUndo(entry.groupId, lib.current);
    const later = { historyTags: [], starredTags: ['kitty', 'dog', 'bird'] };
    expect(run(plan.tagsFile, later).value.starredTags).toEqual(['dog', 'bird', 'cat']);
    expect(run(plan.tagsFile, { historyTags: [], starredTags: ['kitty', 'dog'] }).value).toEqual({
      historyTags: [],
      starredTags: ['cat', 'dog'],
    });
  });

  it('saved filters: a deleted one comes back in its place, an added one goes, a reorder only if nothing changed', async () => {
    const [a, b, c] = ['a', 'b', 'c'].map((name) => ({ name, rule: { k: name } }));
    const deleted = lib.act('Deleted filter b', (g) =>
      edit(g, 'saved-filters.json', [a, b, c], [a, c]),
    );
    const plan = await journal.planUndo(deleted.groupId, lib.current);
    const d = { name: 'd', rule: {} };
    expect(run(plan.savedFilters, [a, c, d]).value).toEqual([a, b, c, d]);
    const added = lib.act('Saved filter d', (g) => edit(g, 'saved-filters.json', [a], [a, d]));
    const plan2 = await journal.planUndo(added.groupId, lib.current);
    expect(run(plan2.savedFilters, [c, a, d]).value).toEqual([c, a]);
    const moved = lib.act('Moved', (g) => edit(g, 'saved-filters.json', [a, b], [b, a]));
    const plan3 = await journal.planUndo(moved.groupId, lib.current);
    expect(run(plan3.savedFilters, [b, a]).value).toEqual([a, b]);
    expect(run(plan3.savedFilters, [b, a, c]).changed).toBe(false);
    expect(plan3.conflicts).toEqual([
      { id: 'saved-filters.json', field: 'order', reason: 'changed since' },
    ]);
  });

  it('undoing a filter edit after the partner edited it again reports it, never adds the old one beside theirs (review5 Q5)', async () => {
    const A = { name: 'Refs', rule: { tags: ['ref'] } };
    const X = { name: 'Hands', rule: { tags: ['hand'] } };
    const X1 = { name: 'Hands', rule: { tags: ['hand', 'arm'] } }; // yours
    const X2 = { name: 'Hands', rule: { tags: ['hand', 'arm', 'wrist'] } }; // theirs, later
    const edited = lib.act('Edited filter Hands', (g) =>
      edit(g, 'saved-filters.json', [A, X], [A, X1]),
    );
    const plan = await journal.planUndo(edited.groupId, lib.current);
    expect(run(plan.savedFilters, [A, X2])).toEqual({ changed: false, value: [A, X2] });
    expect(plan.conflicts).toEqual([
      { id: 'saved-filters.json', field: 'Hands', reason: 'changed since' },
    ]);
    const plan2 = await journal.planUndo(edited.groupId, lib.current);
    expect(run(plan2.savedFilters, [X1, A]).value).toEqual([X, A]); // still yours: back, in place
  });

  it('a custom thumbnail: the plan carries the old and new picture', async () => {
    const entry = lib.act('Set a custom thumbnail', (g) =>
      journal.recordFile(g, {
        relPath: 'images/A.info/thumbnail',
        before: Buffer.from([1, 2]).toString('base64'),
        after: Buffer.from([3]).toString('base64'),
        itemId: 'A',
      }),
    );
    expect(entry.undoable).toBe(true);
    const plan = await journal.planUndo(entry.groupId, lib.current);
    expect(plan.thumbnails).toEqual([
      { id: 'A', before: Buffer.from([1, 2]), after: Buffer.from([3]) },
    ]);
  });
});

describe('storage', () => {
  const blobCount = () => {
    const db = new Database(join(dir, LIB, 'journal.sqlite'), { readonly: true });
    const n = (db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number }).n;
    db.close();
    return n;
  };

  it('a 500-item group with identical before-text stores that text once', () => {
    const before = JSON.stringify(item('X', { tags: [] }));
    const g = journal.begin(LIB, YOU, 'Tagged 500 items', 'items');
    for (let i = 0; i < 500; i++) {
      journal.recordFile(g, {
        relPath: `images/I${i}.info/metadata.json`,
        before,
        after: before.replace('"tags":[]', '"tags":["t"]'),
        itemId: `I${i}`,
      });
    }
    const entry = journal.commit(g, { itemIds: Array.from({ length: 500 }, (_, i) => `I${i}`) })!;
    expect(entry.itemCount).toBe(500);
    expect(blobCount()).toBe(2); // one before, one after
  });

  it('keeps only the first 500 item ids but the full count', () => {
    const ids = Array.from({ length: 700 }, (_, i) => `I${i}`);
    const g = journal.begin(LIB, YOU, 'Big', 'items');
    journal.recordFile(g, {
      relPath: 'images/I0.info/metadata.json',
      before: '{"a":1}',
      after: '{"a":2}',
      itemId: 'I0',
    });
    const entry = journal.commit(g, { itemIds: ids })!;
    expect(entry.itemIds).toHaveLength(500);
    expect(entry.itemCount).toBe(700);
  });

  it('before- and after-text are on disk even if commit never happens (crash)', () => {
    const g = journal.begin(LIB, YOU, 'Tagging', 'items');
    journal.recordFile(g, {
      relPath: 'images/A.info/metadata.json',
      before: '{"tags":["kept"]}',
      after: '{"tags":[]}',
      itemId: 'A',
    });
    // "Crash": a second journal on the same folder, the first one never commits or closes.
    const second = createJournal({ dir });
    expect(second.list(LIB)).toEqual([]); // no half-written group shows up
    second.close();
    const db = new Database(join(dir, LIB, 'journal.sqlite'), { readonly: true });
    const texts = db.prepare('SELECT text FROM blobs').pluck().all();
    db.close();
    expect(texts.sort()).toEqual(['{"tags":["kept"]}', '{"tags":[]}']);
  });

  it('commit returns null when nothing was recorded, and mtime.json is not stored', () => {
    const empty = journal.begin(LIB, YOU, 'Nothing', 'items');
    expect(journal.commit(empty, { itemIds: [] })).toBeNull();
    const g = journal.begin(LIB, YOU, 'Only mtime', 'items');
    journal.recordFile(g, {
      relPath: 'mtime.json',
      before: '{"a":1}',
      after: '{"a":2}',
      itemId: null,
    });
    expect(journal.commit(g, { itemIds: [] })).toBeNull();
  });

  it('list is newest first with limit and before, and history survives reopening', () => {
    let clock = 1_000;
    journal.close();
    journal = createJournal({ dir, now: () => clock });
    lib = new FakeLibrary(journal);
    lib.put('A', item('A'));
    for (const label of ['one', 'two', 'three']) {
      clock += 10;
      lib.act(label, (g) => lib.edit(g, 'A', (r) => (r.annotation = label)), ['A']);
    }
    expect(journal.list(LIB).map((e) => e.label)).toEqual(['three', 'two', 'one']);
    expect(journal.list(LIB, { limit: 2 }).map((e) => e.label)).toEqual(['three', 'two']);
    expect(journal.list(LIB, { before: 1_020 }).map((e) => e.label)).toEqual(['two', 'one']); // inclusive
    expect(journal.list('0000000000000000')).toEqual([]);
    expect(existsSync(join(dir, '0000000000000000'))).toBe(false); // asking does not create files

    journal.close();
    journal = createJournal({ dir, now: () => clock });
    expect(journal.list(LIB)).toHaveLength(3);
  });

  it('prunes groups and blobs older than 90 days, but never the moved-out store entries', () => {
    let clock = Date.parse('2026-01-01');
    journal.close();
    journal = createJournal({ dir, now: () => clock });
    lib = new FakeLibrary(journal);
    lib.put('A', item('A'));
    lib.act('old edit', (g) => lib.edit(g, 'A', (r) => (r.annotation = 'x')), ['A']);
    const stored = join(journal.storeDirFor(LIB), 'g', 'B.info');
    mkdirSync(stored, { recursive: true });
    const g = journal.begin(LIB, YOU, 'old permanent delete', 'delete');
    journal.recordMoveOut(g, { itemId: 'B', storedAt: stored });
    journal.commit(g, { itemIds: ['B'] });
    journal.close();

    clock += 91 * 24 * 60 * 60 * 1000;
    journal = createJournal({ dir, now: () => clock });
    lib = new FakeLibrary(journal);
    lib.put('A', item('A', { annotation: 'x' }));
    lib.act('new edit', (g2) => lib.edit(g2, 'A', (r) => (r.annotation = 'y')), ['A']);
    expect(journal.list(LIB).map((e) => e.label)).toEqual(['new edit', 'old permanent delete']);
    expect(journal.listStored(LIB).map((s) => s.itemId)).toEqual(['B']);
    expect(blobCount()).toBe(2); // only the new edit's before and after remain
  });

  it('refuses library ids that could escape the journal folder', () => {
    expect(() => journal.begin('../evil', YOU, 'x', 'items')).toThrow();
    expect(() => journal.storeDirFor('a/b')).toThrow();
  });

  it('planUndo on an unknown group throws', async () => {
    await expect(journal.planUndo(`${LIB}.nope`, lib.current)).rejects.toThrow(
      /Unknown history group/,
    );
    await expect(journal.planUndo('garbage', lib.current)).rejects.toThrow(/Unknown history group/);
  });
});
