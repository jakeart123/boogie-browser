// Write-safety promises of the service on the REAL core, from the round-2 review
// (.tmp/review2-core/REVIEW.md must-fixes 1 and 4, should-fix 4).
import { cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSandbox, sandboxAvailable, type Sandbox } from './testSandbox';

let sb: Sandbox | null = null;
afterEach(async () => {
  await sb?.close();
  sb = null;
});

/** `n` copies of the library's first item under new ids, made before the library opens. */
function cloneItems(libPath: string, n: number): void {
  const images = join(libPath, 'images');
  const source = readdirSync(images).sort()[0]!;
  for (let i = 0; i < n; i++) {
    const id = `MCLONE${String(i).padStart(7, '0')}`;
    cpSync(join(images, source), join(images, `${id}.info`), { recursive: true });
    const meta = join(images, `${id}.info`, 'metadata.json');
    writeFileSync(meta, JSON.stringify({ ...JSON.parse(readFileSync(meta, 'utf8')), id }));
  }
}

describe.skipIf(!sandboxAvailable)('closing and switching always work', () => {
  it("a library whose mtime.json won't parse can still be switched away from, closed and quit", async () => {
    const s = (sb = await openSandbox({ area: 'sync-safety' }));
    const other = join(s.dir, 'Other.library');
    cpSync(s.libPath, other, { recursive: true });
    await s.host.api.updateItems([s.itemIds[0]!], { addTags: ['raise waiting'] });
    const mt = join(s.libPath, 'mtime.json');
    writeFileSync(mt, '{"OTHERID000001":17900'); // Dropbox or Eagle caught mid-write
    expect((await s.host.api.openLibrary(other)).ref.name).toBe('Other');
    expect(readFileSync(mt, 'utf8')).toBe('{"OTHERID000001":17900'); // never written over
    await s.host.api.openLibrary(s.libPath); // and back again
    await s.host.api.closeLibrary();
    expect(await s.host.api.getLibraryState()).toBeNull();
  });
});

describe.skipIf(!sandboxAvailable)('big edits', () => {
  it('are one History entry written in slices, and stop at the next slice when Eagle opens the library here', async () => {
    const eagle = { running: false, openLibraryPath: null as string | null };
    const s = (sb = await openSandbox({
      area: 'sync-safety',
      open: false,
      eagleMonitor: { check: async () => ({ ...eagle }) },
    }));
    cloneItems(s.libPath, 450);
    await s.host.api.openLibrary(s.libPath);
    await s.host.api.refresh({ full: true });
    const ids = (await s.host.api.query({ scope: { kind: 'all' }, filter: {}, sort: null })).ids;
    expect(ids.length).toBeGreaterThan(450);

    expect((await s.host.api.updateItems(ids, { addTags: ['all of them'] })).changed).toBe(
      ids.length,
    );
    const [whole] = await s.host.api.listHistory();
    expect(whole).toMatchObject({
      itemCount: ids.length,
      label: expect.stringMatching(/all of them/),
    });

    const tagged = () => ids.filter((id) => s.read(id).tags.includes('bulk')).length;
    const edit = s.host.api.updateItems(ids, { addTags: ['bulk'] });
    await s.waitFor(() => tagged() > 0, 10_000);
    Object.assign(eagle, { running: true, openLibraryPath: s.libPath });
    await s.host.api.refresh(); // the window-focus check sees Eagle
    await expect(edit).rejects.toThrow(/Eagle is open on this library/);
    const written = tagged();
    expect(written).toBeLessThan(ids.length);
    const [partial] = await s.host.api.listHistory();
    expect(partial).toMatchObject({ itemCount: written, undoable: true }); // what landed can be undone
  });
});

describe.skipIf(!sandboxAvailable)('undo', () => {
  it('an undo blocked by a later outside change writes nothing and stays undoable', async () => {
    const s = (sb = await openSandbox({ area: 'sync-safety' }));
    const [a] = s.itemIds;
    const { groupId } = await s.host.api.updateItems([a!], { star: 5 });
    s.writeAsEagle(a!, (rec) => (rec.star = 3)); // the partner changed the rating since
    await s.waitFor(
      () =>
        s.events.some(
          (e) => e.name === 'history' && (e.payload as { kind: string }).kind === 'external',
        ),
      8000,
    );
    const before = readFileSync(join(s.libPath, 'images', `${a}.info`, 'metadata.json'), 'utf8');
    const r = await s.host.api.undo(groupId!);
    expect(r).toMatchObject({ groupId: null, reverted: 0, conflicts: [{ id: a, field: 'star' }] });
    expect(readFileSync(join(s.libPath, 'images', `${a}.info`, 'metadata.json'), 'utf8')).toBe(
      before,
    );
    const mine = (await s.host.api.listHistory()).find((h) => h.groupId === groupId);
    expect(mine).toMatchObject({ undoable: true, undoneBy: null });
  });
});
