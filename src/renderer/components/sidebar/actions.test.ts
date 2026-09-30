// The sidebar's rules that are easy to get wrong: what a drop does, what delete asks and where it
// leaves you, and what Quick Access keeps. The app API is faked; the stores are the real ones.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  updateItems: vi.fn(),
  deleteFolder: vi.fn(),
  setQuickAccess: vi.fn(),
  importPaths: vi.fn(),
  query: vi.fn(),
  undo: vi.fn(),
}));
vi.mock('../../lib/api', () => ({ api, on: () => () => {}, inElectron: false }));

import { ITEMS_MIME } from '../../lib/dnd';
import { library } from '../../lib/stores/library.svelte';
import { ui } from '../../lib/stores/ui.svelte';
import { view } from '../../lib/stores/view.svelte';
import type { FolderNode, LibraryState } from '../../../shared/types';
import { deleteFolder, dropOnFolder, toggleQuickAccess } from './actions';

const folder = (id: string, children: FolderNode[] = []): FolderNode => ({
  id,
  name: id,
  description: '',
  children,
  tags: [],
  icon: null,
  iconColor: null,
  coverId: null,
  orderBy: null,
  sortIncrease: null,
  hasPassword: false,
  modificationTime: 0,
});

function setLibrary(patch: Partial<LibraryState> = {}) {
  library.state = {
    ref: { id: 'lib1', path: '/tmp/x.library', name: 'x' },
    readOnly: false,
    readOnlyReason: null,
    applicationVersion: '4.0.0',
    modificationTime: 0,
    folders: [folder('A', [folder('A1')]), folder('B')],
    smartFolders: [],
    quickAccess: [],
    tagGroups: [],
    indexing: null,
    ...patch,
  };
}

const dropEvent = (ids: string[], shiftKey = false) =>
  ({
    shiftKey,
    dataTransfer: {
      getData: (t: string) => (t === ITEMS_MIME ? JSON.stringify(ids) : ''),
      files: [],
      types: [ITEMS_MIME],
    },
  }) as unknown as DragEvent;

beforeEach(() => {
  vi.clearAllMocks();
  api.updateItems.mockImplementation(async (ids: string[]) => ({
    groupId: 'g1',
    changed: ids.length,
    skipped: [],
  }));
  api.deleteFolder.mockResolvedValue({ groupId: 'g2', changed: 0, skipped: [] });
  api.setQuickAccess.mockResolvedValue({ groupId: 'g3', changed: 1, skipped: [] });
  api.query.mockResolvedValue({
    total: 0,
    ids: [],
    aspects: [],
    sort: { by: 'IMPORT', ascending: false },
    elapsedMs: 0,
  });
  ui.toasts = [];
  ui.dialog = null;
  setLibrary();
  view.scope = { kind: 'all' };
});

describe('dropping items on a folder', () => {
  it('adds them, and Shift moves them out of the folder you are looking at', async () => {
    await dropOnFolder(dropEvent(['i1', 'i2']), 'B');
    expect(api.updateItems).toHaveBeenLastCalledWith(['i1', 'i2'], { addFolders: ['B'] });

    // With subfolder contents shown, an item on screen may live only in A1: leave the whole subtree.
    view.scope = { kind: 'folder', id: 'A', includeSubfolders: true };
    await dropOnFolder(dropEvent(['i1'], true), 'B');
    expect(api.updateItems).toHaveBeenLastCalledWith(['i1'], {
      addFolders: ['B'],
      removeFolders: ['A', 'A1'],
    });
    // ...but never the target: moving down into A1 leaves only A.
    await dropOnFolder(dropEvent(['i1'], true), 'A1');
    expect(api.updateItems).toHaveBeenLastCalledWith(['i1'], {
      addFolders: ['A1'],
      removeFolders: ['A'],
    });
    view.scope = { kind: 'folder', id: 'A', includeSubfolders: false };
    await dropOnFolder(dropEvent(['i1'], true), 'B');
    expect(api.updateItems).toHaveBeenLastCalledWith(['i1'], {
      addFolders: ['B'],
      removeFolders: ['A'],
    });

    // Shift with no folder open (or onto the same folder) has nothing to move out of.
    view.scope = { kind: 'all' };
    await dropOnFolder(dropEvent(['i1'], true), 'B');
    expect(api.updateItems).toHaveBeenLastCalledWith(['i1'], { addFolders: ['B'] });
  });

  it('changes nothing in a read-only library and says why', async () => {
    setLibrary({ readOnly: true, readOnlyReason: 'Wine Eagle has this library open' });
    await dropOnFolder(dropEvent(['i1']), 'B');
    expect(api.updateItems).not.toHaveBeenCalled();
    expect(ui.toasts[0].text).toContain('Wine Eagle has this library open');
  });
});

describe('deleting a folder', () => {
  it('asks first, passes the checkbox on, and leaves the folder you were in', async () => {
    view.scope = { kind: 'folder', id: 'A1', includeSubfolders: true };
    const done = deleteFolder('A');
    expect(ui.dialog?.kind).toBe('confirm');
    expect(ui.dialog?.props?.danger).toBe(true);
    (ui.dialog!.props!.resolve as (r: { ok: boolean; checked: boolean }) => void)({
      ok: true,
      checked: true,
    });
    await done;
    expect(api.deleteFolder).toHaveBeenCalledWith('A', { deleteContents: true });
    expect(view.scope.kind).toBe('all'); // A1 lived inside A
    expect(ui.toasts.at(-1)?.action?.label).toBe('Undo');
  });

  it('does nothing when you cancel', async () => {
    const done = deleteFolder('B');
    (ui.dialog!.props!.resolve as (r: { ok: boolean; checked: boolean }) => void)({
      ok: false,
      checked: false,
    });
    await done;
    expect(api.deleteFolder).not.toHaveBeenCalled();
  });
});

describe('Quick Access', () => {
  it('adds and removes without dropping entries that point at folders that no longer exist', async () => {
    setLibrary({ quickAccess: [{ type: 'folder', id: 'GONE', extra: 1 }] });
    await toggleQuickAccess('folder', 'A');
    expect(api.setQuickAccess).toHaveBeenLastCalledWith([
      { type: 'folder', id: 'GONE' },
      { type: 'folder', id: 'A' },
    ]);

    setLibrary({
      quickAccess: [
        { type: 'folder', id: 'GONE' },
        { type: 'folder', id: 'A' },
      ],
    });
    await toggleQuickAccess('folder', 'A');
    expect(api.setQuickAccess).toHaveBeenLastCalledWith([{ type: 'folder', id: 'GONE' }]);
  });
});
