// The MCP tools against the REAL core (adapter, index, journal, importer) on a sandbox library
// copy, through real HTTP. Dry runs are checked against what the app then actually writes.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoreApi } from '../../shared/api';
import type { AgentActivity, JobProgress } from '../../shared/types';
import type { CoreHost } from '../contracts';
import { sandboxAvailable } from '../service/testSandbox';
import { McpState, stateFor } from './kit';
import { type Harness, startHarness } from './testing/harness';
import { WAIT_MS, waitForJob } from './tools/jobs';

let h: Harness | null = null;
afterEach(async () => {
  WAIT_MS.dupes = 60_000;
  await h?.stop();
  h = null;
});
const start = async (opts?: Parameters<typeof startHarness>[0]) => (h = await startHarness(opts));
const copiesOf = (x: Harness) => x.ids.filter((id) => id.startsWith('MCPCOPY')).sort();

describe.skipIf(!sandboxAvailable)('MCP tools on the real core', () => {
  it('lists every tool with honest hints, and the list stays small', async () => {
    const x = await start();
    const { json } = await x.client.post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools: any[] = json.result.tools;
    const byName = new Map(tools.map((t) => [t.name, t]));
    const read = [
      'library_info',
      'list_libraries',
      'search_items',
      'get_item',
      'get_items',
      'get_thumbnail',
      'list_folders',
      'list_tags',
      'list_smart_folders',
      'history',
      'find_duplicates',
      'job_status',
    ];
    const additive = [
      'add_tags',
      'set_rating',
      'set_note',
      'set_url',
      'add_to_folders',
      'create_folder',
      'update_folder',
      'import_url',
      'import_file',
      'copy_to_library',
      'star_tags',
      'save_tag_group',
      'save_smart_folder',
      'save_filter',
    ];
    const changing = [
      'remove_tags',
      'remove_from_folders',
      'rename_items',
      'rename_item',
      'move_to_trash',
      'restore_items',
      'rename_tag',
      'delete_tag',
      'move_folder',
      'rename_folder',
      'delete_folder',
      'delete_tag_group',
      'delete_smart_folder',
      'merge_duplicates',
      'undo',
    ];
    expect(tools.map((t) => t.name).sort()).toEqual([...read, ...additive, ...changing].sort());
    for (const n of read) expect(byName.get(n).annotations.readOnlyHint, n).toBe(true);
    for (const n of additive)
      expect(byName.get(n).annotations, n).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
      });
    for (const n of changing)
      expect(byName.get(n).annotations, n).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
    expect(byName.get('import_url').annotations.openWorldHint).toBe(true);
    for (const n of changing.filter((n) => n !== 'undo'))
      expect(byName.get(n).inputSchema.properties.plan_id, n).toBeDefined();
    // Every agent session pays for this list: 48 KB before the round-2 trim, 20.9 KB for 34 tools,
    // 27.5 KB for 42 (round 4: smart folders, tag groups, starred tags, saved filters, copy),
    // 28.7 KB once every tool took a `library` argument.
    expect(Buffer.byteLength(JSON.stringify(json.result))).toBeLessThan(29_000);
  });

  it('search_items finds real items by folder (subfolders included), tags, rating and type', async () => {
    const x = await start();
    const [a, b, c] = x.sample;
    const { api } = x.host;
    await api.updateItems([a], {
      addFolders: [x.folders.atelier],
      addTags: ['study'],
      star: 3,
      annotation: 'x'.repeat(400),
    });
    await api.updateItems([b], { addFolders: [x.folders.gerome], addTags: ['study', 'hands'] });
    await api.updateItems([c], { addFolders: [x.folders.refs], addTags: ['poster'] });

    const r = await x.client.call('search_items', { tags: ['study'], folders: ['Atelier'] });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.total).toBe(2); // Gerome sits inside Atelier
    const itemA = r.data.items.find((i: any) => i.id === a);
    expect(itemA).toMatchObject({
      rating: 3,
      folders: [{ id: x.folders.atelier, name: 'Atelier' }],
    });
    expect(itemA.tags).toEqual(expect.arrayContaining(['study', 'Atelier'])); // the folder's auto-tag
    expect(itemA.note.length).toBe(303); // cut to 300 characters plus "..."
    const full = await x.client.call('get_items', { ids: [a] });
    expect(full.data.items[0].note.length).toBe(400);

    const count = async (args: Record<string, unknown>) =>
      (await x.client.call('search_items', args)).data.total;
    expect(await count({ folders: ['Atelier'], include_subfolders: false })).toBe(1);
    expect(await count({ folders: ['Atelier'], rating: [3, 4, 5] })).toBe(1);
    expect(await count({ types: ['image'] })).toBe(x.ids.length);
    expect(await count({ types: ['image', '-jpg'] })).toBe(0); // every sandbox item is a jpg

    const page = await x.client.call('search_items', { limit: 2, offset: 1 });
    expect(page.data).toMatchObject({ returned: 2, offset: 1, has_more: true, total: 11 });
    const bad = await x.client.call('search_items', { imported_after: 'last tuesday' });
    expect(bad.text).toMatch(/not a date/);
    // Strict inputs: a typo can never silently widen a search.
    expect((await x.client.call('search_items', { tagz: ['x'] })).isError).toBe(true);
  });

  it('move_to_trash is plan-then-apply: the dry run writes nothing, a plan applies once, and a stale or expired plan is refused', async () => {
    const x = await start();
    const [a, b, c] = x.ids;
    const { api } = x.host;
    await api.trashItems([b]);

    const dry = await x.client.call('move_to_trash', { item_ids: [a, b] });
    expect(dry.data.status).toBe('dry_run');
    expect(dry.data.plan_id).toMatch(/^plan_[0-9a-f]{24}$/);
    expect(dry.data.changes.map((ch: any) => ch.id)).toEqual([a]); // b is already in the trash
    expect(x.sb.read(a).isDeleted).toBe(false);

    const wrongArgs = await x.client.call('move_to_trash', {
      item_ids: [a],
      plan_id: dry.data.plan_id,
    });
    expect(wrongArgs.text).toMatch(/arguments differ/);
    const wrongTool = await x.client.call('restore_items', {
      item_ids: [a, b],
      plan_id: dry.data.plan_id,
    });
    expect(wrongTool.text).toMatch(/made for move_to_trash/);
    const unknown = await x.client.call('move_to_trash', { item_ids: [a], plan_id: 'plan_0' });
    expect(unknown.text).toMatch(/unknown, expired/);

    const done = await x.client.call('move_to_trash', {
      item_ids: [a, b],
      plan_id: dry.data.plan_id,
    });
    expect(done.data).toMatchObject({ status: 'applied', changed: 1 });
    expect(done.data.group_id).toBeTruthy();
    expect(x.sb.read(a).isDeleted).toBe(true);
    const again = await x.client.call('move_to_trash', {
      item_ids: [a, b],
      plan_id: dry.data.plan_id,
    });
    expect(again.isError).toBe(true);

    // The user edits the item after the dry run: the change list the agent saw is no longer the truth.
    await api.updateItems([c], { addTags: ['x'] });
    const dry2 = await x.client.call('remove_tags', { item_ids: [c], tags: ['x'] });
    await api.updateItems([c], { addTags: ['y'] });
    const stale = await x.client.call('remove_tags', {
      item_ids: [c],
      tags: ['x'],
      plan_id: dry2.data.plan_id,
    });
    expect(stale.text).toMatch(/library changed since the dry run/);
    expect(x.sb.read(c).tags).toContain('x');

    const dry3 = await x.client.call('restore_items', { item_ids: [a] });
    const state = stateFor(x.host);
    state.now = () => Date.now() + 16 * 60_000; // plans last 15 minutes
    const late = await x.client.call('restore_items', {
      item_ids: [a],
      plan_id: dry3.data.plan_id,
    });
    state.now = () => Date.now();
    expect(late.text).toMatch(/expired/);
    expect(x.sb.read(a).isDeleted).toBe(true);
  });

  it('additive writes apply directly up to 50 items, need a plan above that, and preview exactly what gets written', async () => {
    const x = await start({ copies: 60 });
    const copies = copiesOf(x);
    expect(copies).toHaveLength(60);

    const small = await x.client.call('add_tags', { item_ids: copies.slice(0, 3), tags: ['new'] });
    expect(small.data).toMatchObject({ status: 'applied', changed: 3 });
    expect(x.sb.read(copies[0]).tags).toContain('new');
    const repeat = await x.client.call('add_tags', { item_ids: copies.slice(0, 3), tags: ['new'] });
    expect(repeat.data.status).toBe('nothing_to_do');

    const big = await x.client.call('add_tags', { item_ids: copies, tags: ['bulk'] });
    expect(big.data).toMatchObject({ status: 'dry_run', item_count: 60 });
    expect(x.sb.read(copies[59]).tags).not.toContain('bulk');
    const applied = await x.client.call('add_tags', {
      item_ids: copies,
      tags: ['bulk'],
      plan_id: big.data.plan_id,
    });
    expect(applied.data).toMatchObject({ status: 'applied', changed: 60 });
    expect(x.sb.read(copies[59]).tags).toContain('bulk');

    const tooMany = await x.client.call('add_tags', {
      item_ids: Array.from({ length: 501 }, (_, i) => `ID${i}`),
      tags: ['x'],
    });
    expect(tooMany.isError).toBe(true);
    expect(tooMany.text).toMatch(/500/);

    // The preview of a folder add (with its and its parent's auto-tags) is what lands on disk.
    const one = copies[10];
    const preview = await x.client.call('add_to_folders', {
      item_ids: [one],
      folders: ['Atelier / Gerome'],
      dry_run: true,
    });
    const rows = Object.fromEntries(preview.data.changes.map((ch: any) => [ch.field, ch.after]));
    expect(rows.folders).toEqual(['Atelier / Gerome']);
    expect(rows.tags).toEqual(expect.arrayContaining(['Atelier', 'Gerome']));
    await x.client.call('add_to_folders', { item_ids: [one], folders: ['Atelier / Gerome'] });
    expect(x.sb.read(one).tags).toEqual(rows.tags);
    expect(x.sb.read(one).folders).toEqual([x.folders.gerome]);

    const unknown = await x.client.call('add_tags', { item_ids: [one, 'NOPE'], tags: ['x'] });
    expect(unknown.text).toMatch(/Unknown item ids: NOPE/);
    const typo = await x.client.call('add_to_folders', { item_ids: [one], folders: ['Ateler'] });
    expect(typo.text).toMatch(/No folder matches "Ateler".*Atelier/);
  });

  it('rename_items: the dry run shows exactly the names the app then writes', async () => {
    const x = await start();
    const [a, b] = x.sample;
    const args = {
      item_ids: [b, a],
      template: 'Study %N - *',
      start: 9,
      find: '\\s+',
      replace: ' ',
      regex: true,
    };
    const dry = await x.client.call('rename_items', args);
    expect(dry.data.status, dry.text).toBe('dry_run');
    const planned = dry.data.changes.map((ch: any) => [ch.id, ch.after]);
    expect(planned.map((p: string[]) => p[1].slice(0, 9))).toEqual(['Study 09 ', 'Study 10 ']);
    await x.client.call('rename_items', { ...args, plan_id: dry.data.plan_id });
    expect(planned).toEqual([
      [b, x.sb.read(b).name],
      [a, x.sb.read(a).name],
    ]);
    const bad = await x.client.call('rename_items', {
      item_ids: [a],
      template: '*',
      find: '(',
      regex: true,
    });
    expect(bad.text).toMatch(/not a valid search pattern/);
  });

  it('merge_duplicates previews the merged keeper exactly, trashes the others, and is ONE undoable change', async () => {
    const x = await start({ copies: 4 });
    const [k1, o1, k2, o2] = copiesOf(x);
    const { api } = x.host;
    await api.updateItems([k1], {
      addTags: ['a'],
      addFolders: [x.folders.refs],
      star: 2,
      annotation: 'mine',
    });
    await api.updateItems([o1], {
      addTags: ['b'],
      addFolders: [x.folders.gerome],
      star: 5,
      url: 'https://o1.test/',
      annotation: ' mine ',
    });
    await api.updateItems([o2], { annotation: 'theirs' });
    const groups = [
      { keeper_id: k1, other_ids: [o1] },
      { keeper_id: k2, other_ids: [o2] },
    ];
    const dry = await x.client.call('merge_duplicates', { groups });
    expect(dry.data.status, dry.text).toBe('dry_run');
    const after = (id: string, field: string) =>
      dry.data.changes.find((ch: any) => ch.id === id && ch.field === field)?.after;
    expect(after(k1, 'tags')).toEqual(expect.arrayContaining(['a', 'b', 'Atelier', 'Gerome']));
    expect(
      dry.data.changes.filter((ch: any) => ch.field === 'in_trash').map((ch: any) => ch.id),
    ).toEqual([o1, o2]);
    const historyBefore = (await api.listHistory()).length;

    const done = await x.client.call('merge_duplicates', { groups, plan_id: dry.data.plan_id });
    expect(done.data.status, done.text).toBe('applied');
    const keeper = x.sb.read(k1);
    expect(keeper.tags).toEqual(after(k1, 'tags'));
    expect(keeper.star).toBe(after(k1, 'rating'));
    expect(keeper.url).toBe(after(k1, 'url'));
    expect(after(k1, 'note')).toBeUndefined(); // " mine " is the keeper's own note again
    expect(keeper.annotation).toBe('mine');
    expect(x.sb.read(k2).annotation).toBe(after(k2, 'note'));
    expect([x.sb.read(o1).isDeleted, x.sb.read(o2).isDeleted]).toEqual([true, true]);
    const history = await api.listHistory();
    expect(history.length - historyBefore).toBe(1);
    expect(history[0]).toMatchObject({ kind: 'merge', groupId: done.data.group_id });

    const undone = await x.client.call('undo', {});
    expect(undone.data.undone_group_id).toBe(done.data.group_id);
    expect([x.sb.read(o1).isDeleted, x.sb.read(o2).isDeleted]).toEqual([false, false]);
    expect(x.sb.read(k1).tags).not.toContain('b');

    const dup = await x.client.call('merge_duplicates', {
      groups: [{ keeper_id: k1, other_ids: [k1] }],
    });
    expect(dup.text).toMatch(/more than once/);
  });

  it('find_duplicates finds real copies, and a slow scan hands back a job id for job_status', async () => {
    const x = await start({ copies: 2 });
    const quick = await x.client.call('find_duplicates', {});
    expect(quick.data, quick.text).toMatchObject({ state: 'done', total_groups: 1 });
    const ids = quick.data.groups[0].members.map((m: any) => m.id);
    expect(ids).toEqual(expect.arrayContaining(copiesOf(x)));
    expect(ids).toHaveLength(3); // the original and its two copies

    WAIT_MS.dupes = 0;
    const slow = await x.client.call('find_duplicates', { mode: 'similar' });
    expect(slow.data.state).toBe('running');
    expect(slow.data.hint).toMatch(/job_status/);
    let later = slow;
    for (let i = 0; i < 200 && later.data.state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      later = await x.client.call('job_status', { job_id: slow.data.job_id });
    }
    expect(later.data.state).toBe('done');
    expect(later.data.total_groups).toBeGreaterThanOrEqual(1);
  });

  it("undo defaults to this agent's latest change and never touches the user's or another agent's", async () => {
    const x = await start();
    const [a, b, c] = x.ids;
    const bot = { era: 'modern' as const, client: 'Bot' };
    await x.client.call('add_tags', { item_ids: [a], tags: ['x'] }, bot);
    await x.client.call(
      'add_tags',
      { item_ids: [b], tags: ['y'] },
      { era: 'modern', client: 'Other' },
    );
    const r = await x.client.call('undo', {}, bot);
    expect(r.data).toMatchObject({ reverted: 1, conflicts: [] });
    expect(x.sb.read(a).tags).not.toContain('x');
    expect(x.sb.read(b).tags).toContain('y');
    expect((await x.client.call('undo', {}, bot)).text).toMatch(/no change by Bot/);

    const mine = await x.host.api.updateItems([c], { addTags: ['z'] });
    const refused = await x.client.call('undo', { group_id: mine.groupId }, bot);
    expect(refused.text).toMatch(/not by an agent/);
    expect(x.sb.read(c).tags).toContain('z');
  });

  it('attributes writes to the client name or User-Agent, cleans hostile names, and shows activity in the status strip', async () => {
    const x = await start();
    const [a, b, c] = x.ids;
    const activity = vi.spyOn(x.host, 'setAgentActivity');
    await x.client.call(
      'set_rating',
      { item_ids: [a], rating: 5 },
      { era: 'modern', client: 'Claude Code' },
    );
    await x.client.call(
      'set_rating',
      { item_ids: [b], rating: 4 },
      { userAgent: 'claude-code/2.1.0 (cli)' },
    );
    await x.client.call('set_rating', { item_ids: [c], rating: 1 });
    const actors = (await x.host.api.listHistory({ limit: 3 })).map((e) => e.actor);
    expect(actors).toEqual([
      { kind: 'agent', name: 'Agent (MCP)' },
      { kind: 'agent', name: 'Claude Code (MCP)' }, // what Claude Code's User-Agent says
      { kind: 'agent', name: 'Claude Code (MCP)' },
    ]);
    // 2026-07-28 clients: the human title wins over the machine name.
    await x.client.call(
      'set_rating',
      { item_ids: [c], rating: 2 },
      { era: 'modern', client: 'claude-code', title: 'Claude Code' },
    );
    expect((await x.host.api.listHistory({ limit: 1 }))[0].actor.name).toBe('Claude Code (MCP)');
    expect(activity.mock.calls[0][0]).toEqual([
      { name: 'Claude Code (MCP)', label: 'Rating 1 item', done: 0, total: 1, paused: false },
    ]);
    expect(activity.mock.calls.at(-1)![0]).toEqual([]);

    await x.client.call(
      'set_rating',
      { item_ids: [a], rating: 2 },
      { era: 'modern', client: 'Evil\nYou (user) '.padEnd(100, 'x') },
    );
    const hostile = (await x.host.api.listHistory({ limit: 1 }))[0].actor.name;
    expect(hostile).not.toMatch(/[\n\r]/);
    expect(hostile.length).toBeLessThanOrEqual(40 + ' (MCP)'.length);
  });

  it('refuses every write on a read-only library, with the reason', async () => {
    const x = await start({ writable: false });
    for (const [tool, args] of [
      ['add_tags', { item_ids: [x.ids[0]], tags: ['x'] }],
      ['move_to_trash', { item_ids: [x.ids[0]] }],
      ['create_folder', { name: 'New' }],
      ['undo', {}],
    ] as const) {
      const r = await x.client.call(tool, args);
      expect(r.isError, tool).toBe(true);
      expect(r.text, tool).toMatch(/read-only.*Editing is off/);
    }
    const info = await x.client.call('library_info');
    expect(info.data).toMatchObject({
      read_only: true,
      shared_with_partner: true,
      partner: 'Sam',
    });
  });

  it('import_file refuses library files, secrets and folders, and imports a plain file with its group id', async () => {
    const x = await start();
    const images = join(x.sb.libPath, 'images');
    const infoDir = join(images, readdirSync(images)[0]);
    const inLibrary = join(
      infoDir,
      readdirSync(infoDir).find((f) => f !== 'metadata.json')!,
    );
    const link = join(x.sb.dir, 'innocent.png');
    symlinkSync(x.tokenFile, link);
    const folder = join(x.sb.dir, 'a folder');
    mkdirSync(folder);
    for (const p of [inLibrary, x.tokenFile, link]) {
      const r = await x.client.call('import_file', { paths: [p] });
      expect(r.text, p).toMatch(/refused/);
    }
    expect((await x.client.call('import_file', { paths: [folder] })).text).toMatch(
      /not a regular file/,
    );
    expect((await x.client.call('import_file', { paths: ['relative.png'] })).text).toMatch(
      /absolute/,
    );

    const ok = join(x.sb.dir, 'fine.png');
    execFileSync('vips', ['black', ok, '64', '48']);
    const good = await x.client.call('import_file', {
      paths: [ok],
      tags: ['imported'],
      folder: 'Refs',
    });
    expect(good.data.status, good.text).toBe('applied');
    expect(good.data.added).toHaveLength(1);
    expect(good.data.group_id).toBeTruthy(); // ImportResult.groupId from the app
    const item = await x.host.api.getItem(good.data.added[0]);
    expect(item).toMatchObject({ name: 'fine', folders: [x.folders.refs] });
    expect(item?.tags).toContain('imported');
  });

  it('import_url takes only http(s) addresses and downloads one into the library', async () => {
    const x = await start();
    expect((await x.client.call('import_url', { url: 'file:///etc/passwd' })).text).toMatch(
      /Only http and https/,
    );
    expect((await x.client.call('import_url', { url: 'not a url' })).text).toMatch(
      /not a valid URL/,
    );

    const png = join(x.sb.dir, 'served.png');
    execFileSync('vips', ['black', png, '80', '60']);
    const bytes = readFileSync(png);
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': bytes.length });
      res.end(bytes);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/pose.png`;
    try {
      const got = await x.client.call('import_url', { url, name: 'Pose' });
      expect(got.data.status, got.text).toBe('applied');
      expect(got.data.group_id).toBeTruthy();
      const item = await x.host.api.getItem(got.data.added[0]);
      expect(item).toMatchObject({ name: 'Pose', url });
    } finally {
      server.close();
    }
  });

  it('get_thumbnail sends the WebP thumbnail as is, and shrinks a picture over 1 MB to a JPEG', async () => {
    const x = await start();
    const first = x.sample[0];
    const small = await x.client.call('get_thumbnail', { id: first });
    const image = small.content.find((ch: any) => ch.type === 'image');
    expect(image.mimeType).toBe('image/webp');

    // Our own copy: swap in a huge thumbnail file.
    const thumb = join(
      x.sb.libPath,
      'images',
      `${first}.info`,
      `${x.sb.read(first).name}_thumbnail.png`,
    );
    execFileSync('vips', ['gaussnoise', thumb, '3000', '3000', '--sigma', '80']);
    const big = await x.client.call('get_thumbnail', { id: first });
    const shrunk = big.content.find((ch: any) => ch.type === 'image');
    expect(shrunk.mimeType).toBe('image/jpeg');
    const data = Buffer.from(shrunk.data, 'base64');
    expect(data.length).toBeLessThanOrEqual(1_000_000);
    expect(data[0]).toBe(0xff);
  });

  it('a record whose ext points outside its folder never leads the agent to a file there', async () => {
    const x = await start();
    const [a] = x.sample;
    const rec = x.sb.read(a);
    const dir = join(x.sb.libPath, 'images', `${a}.info`);
    // Where "<name>.jpg/../../../../outside" lands: next to the library.
    const outside = join(x.sb.libPath, '..', 'outside');
    execFileSync('vips', ['black', `${outside}.png`, '7', '7']);
    execFileSync('mv', [`${outside}.png`, outside]);
    rmSync(join(dir, `${rec.name}_thumbnail.png`)); // no thumbnail: the original is sent instead
    writeFileSync(
      join(dir, 'metadata.json'),
      JSON.stringify({ ...rec, ext: 'jpg/../../../../outside' }),
    );
    await x.host.api.refresh({ full: true });

    expect((await x.client.call('get_item', { id: a })).data.item.file_path).toBeNull();
    const thumb = await x.client.call('get_thumbnail', { id: a });
    const image = thumb.content.find((ch: any) => ch.type === 'image');
    expect(image.mimeType).toBe('image/jpeg'); // the real original, not the PNG outside
  });

  it('the read tools answer on a real library, and the remaining write tools preview without writing', async () => {
    const x = await start();
    const [a, b] = x.sample;
    const { api } = x.host;
    await api.updateItems([a], { addFolders: [x.folders.refs], annotation: 'first note' });
    await api.trashItems([b]);

    const ok = async (tool: string, args: Record<string, unknown> = {}) => {
      const r = await x.client.call(tool, args);
      expect(r.isError, `${tool}: ${r.text}`).toBe(false);
      return r.data;
    };
    const info = await ok('library_info');
    expect(info).toMatchObject({ shared_with_partner: true, partner: 'Sam' });
    expect(info.counts).toMatchObject({ items: 10, in_trash: 1 });
    expect(info.top_level_folders.map((f: any) => f.name)).toEqual(
      expect.arrayContaining(['Atelier', 'Refs']),
    );
    expect((await ok('list_libraries')).libraries[0]).toMatchObject({
      open_in_app: true,
      partner: 'Sam',
    });
    expect((await ok('list_folders')).folders.map((f: any) => f.path)).toContain(
      'Atelier / Gerome',
    );
    expect((await ok('list_folders', { parent: 'Atelier', max_depth: 0 })).folders).toHaveLength(1);
    expect((await ok('list_tags', { query: 'gerome' })).tags[0]).toMatchObject({
      name: 'Atelier Gerome',
    });
    await ok('list_smart_folders');
    expect((await ok('history', { limit: 2 })).entries).toHaveLength(2);
    const item = (await ok('get_item', { id: a })).item;
    expect(item).toMatchObject({ id: a, note: 'first note', in_trash: false });
    expect(existsSync(item.file_path)).toBe(true);
    expect((await ok('get_items', { ids: [a, 'ZZZ'] })).missing).toEqual(['ZZZ']);
    expect((await ok('job_status', { job_id: 'nope' })).state).toBe('unknown');
    expect((await x.client.call('get_item', { id: 'ZZZ' })).text).toMatch(/No item with id ZZZ/);

    const historyBefore = (await api.listHistory()).length;
    const dry = async (tool: string, args: Record<string, unknown>) => {
      const r = await x.client.call(tool, args);
      expect(r.isError, `${tool}: ${r.text}`).toBe(false);
      expect(r.data.status, tool).toBe('dry_run');
      return r.data.changes;
    };
    expect((await dry('set_note', { item_ids: [a], note: 'new', dry_run: true }))[0]).toMatchObject(
      { field: 'note', before: 'first note', after: 'new' },
    );
    await dry('set_url', { item_ids: [a], url: 'https://x.test/a', dry_run: true });
    await dry('set_rating', { item_ids: [a], rating: 5, dry_run: true });
    expect(
      (await dry('remove_from_folders', { item_ids: [a], folders: ['Refs'] }))[0],
    ).toMatchObject({ field: 'folders', before: ['Refs'], after: [] });
    await dry('restore_items', { item_ids: [b] });
    await dry('rename_folder', { folder: 'Refs', name: 'References' });
    await dry('rename_item', { id: a, name: 'Renamed' });
    await dry('delete_tag', { name: 'Atelier Gerome' });
    await dry('rename_tag', { from: 'Atelier Gerome', to: 'Gerome' });
    await dry('move_folder', { folder: 'Refs', new_parent: 'Atelier', position: 0 });
    const del = await dry('delete_folder', { folder: 'Refs', delete_contents: true });
    expect(del.find((ch: any) => ch.field === 'in_trash')?.id).toBe(a);
    expect((await x.client.call('create_folder', { name: 'refs' })).data.status).toBe(
      'nothing_to_do',
    );
    expect(
      (await x.client.call('move_folder', { folder: 'Atelier', new_parent: 'Atelier / Gerome' }))
        .text,
    ).toMatch(/cannot move into itself/);
    expect((await x.client.call('rename_item', { id: a, name: 'a/b' })).text).toMatch(/slashes/);
    expect((await x.client.call('set_url', { item_ids: [a], url: 'nope' })).text).toMatch(
      /not a valid URL/,
    );
    expect((await api.listHistory()).length).toBe(historyBefore); // previews wrote nothing
  });

  it('refuses every write while the user has paused the agent, a renamed client too, and holds nothing back', async () => {
    const x = await start();
    const [a] = x.ids;
    const bot = { era: 'modern' as const, client: 'Bot' };
    const activity = vi.spyOn(x.host, 'setAgentActivity');
    const added = await x.client.call('add_tags', { item_ids: [a], tags: ['before'] }, bot);
    expect(added.data.status).toBe('applied');
    await x.host.api.setAgentPaused('Bot (MCP)', true);

    type Opts = Parameters<typeof x.client.call>[2];
    const refused = async (tool: string, args: Record<string, unknown>, opts: Opts = bot) => {
      const r = await x.client.call(tool, args, opts);
      expect([r.isError, r.text], tool).toEqual([true, expect.stringMatching(/paused/)]);
    };
    await refused('add_tags', { item_ids: [a], tags: ['later'] });
    await refused('undo', {});
    // Same program (User-Agent), new name: still paused.
    await refused('add_tags', { item_ids: [a], tags: ['later'] }, { ...bot, title: 'Bot 2' });
    // Reads still work, and the strip keeps the agent, paused, so the user can resume it.
    expect((await x.client.call('library_info', {}, bot)).isError).toBe(false);
    expect(activity).toHaveBeenLastCalledWith([
      expect.objectContaining({ name: 'Bot (MCP)', paused: true }),
    ]);
    // Another program isn't held up.
    const other = await x.client.call(
      'add_tags',
      { item_ids: [a], tags: ['other'] },
      { era: 'modern', client: 'Other', userAgent: 'other-agent/1.0' },
    );
    expect(other.data.status).toBe('applied');
    // Only the app's user can resume an agent.
    await expect(
      x.host.as({ kind: 'agent', name: 'Bot (MCP)' }).setAgentPaused('Bot (MCP)', false),
    ).rejects.toThrow(/Only you/);

    await x.host.api.setAgentPaused('Bot (MCP)', false);
    await vi.waitFor(() => expect(activity).toHaveBeenLastCalledWith([]), { timeout: 3000 });
    expect(x.sb.read(a).tags).toContain('before'); // the refused undo never ran
    expect(x.sb.read(a).tags).not.toContain('later'); // and nothing ran on resume
    const after = await x.client.call('add_tags', { item_ids: [a], tags: ['later'] }, bot);
    expect(after.data.status).toBe('applied');
  });

  it('smart folders, tag groups and folder details: saved as asked, bad rules refused, deletes are two-step', async () => {
    const x = await start();
    const [a, b] = x.sample;
    const { api } = x.host;
    await api.updateItems([a], { addTags: ['hands'], star: 5 });
    const ok = async (tool: string, args: Record<string, unknown>) => {
      const r = await x.client.call(tool, args);
      expect(r.isError, `${tool}: ${r.text}`).toBe(false);
      return r.data;
    };
    const root = () => JSON.parse(readFileSync(join(x.sb.libPath, 'metadata.json'), 'utf8'));

    // update_folder
    const upd = await ok('update_folder', {
      folder: 'Refs',
      description: 'Reference shots',
      color: 'blue',
      auto_tags: ['ref'],
    });
    expect(upd.status).toBe('applied');
    expect(root().folders.find((f: any) => f.name === 'Refs')).toMatchObject({
      description: 'Reference shots',
      iconColor: 'blue',
      tags: ['ref'],
    });
    expect((await ok('update_folder', { folder: 'Refs', color: 'blue' })).status).toBe(
      'nothing_to_do',
    );

    // smart folders
    const conditions = [
      { match: 'AND', rules: [{ property: 'rating', method: 'equal', value: '5' }] },
    ];
    const made = await ok('save_smart_folder', { name: 'Best', conditions, color: 'red' });
    expect(made.status).toBe('applied');
    const sf = root().smartFolders[0];
    expect(sf).toMatchObject({ id: made.smart_folder_id, name: 'Best', iconColor: 'red' });
    expect(sf.conditions).toEqual([{ ...conditions[0], boolean: 'TRUE' }]);
    expect(
      (await ok('search_items', { smart_folder: 'Best' })).items.map((i: any) => i.id),
    ).toEqual([a]);
    const bad = await x.client.call('save_smart_folder', {
      name: 'Bad',
      conditions: [{ rules: [{ property: 'tags', method: 'contain', value: 'x' }] }],
    });
    expect([bad.isError, bad.text]).toEqual([
      true,
      expect.stringMatching(/tags takes the methods/),
    ]);
    await ok('save_smart_folder', { smart_folder: 'Best', name: 'Five stars' });
    expect(root().smartFolders[0].name).toBe('Five stars');
    const del = await ok('delete_smart_folder', { smart_folder: 'Five stars' });
    expect(del.status).toBe('dry_run');
    expect(root().smartFolders).toHaveLength(1);
    await ok('delete_smart_folder', { smart_folder: 'Five stars', plan_id: del.plan_id });
    expect(root().smartFolders).toEqual([]);

    // tag groups, with the shared-library warning
    const group = await ok('save_tag_group', { name: 'Anatomy', tags: ['hands'] });
    expect(group.warning).toMatch(/Sam's computer/);
    await ok('save_tag_group', { group: 'Anatomy', add_tags: ['feet'], color: 'green' });
    expect(root().tagsGroups[0]).toMatchObject({
      id: group.tag_group_id,
      name: 'Anatomy',
      tags: ['hands', 'feet'],
      color: 'green',
    });
    const listed = await ok('list_tags', {});
    expect(listed.tag_groups).toEqual([
      { id: group.tag_group_id, name: 'Anatomy', tag_count: 2, color: 'green' },
    ]);
    expect(listed.tags.find((t: any) => t.name === 'hands').groups).toEqual(['Anatomy']);
    const gone = await ok('delete_tag_group', { group: 'Anatomy' });
    await ok('delete_tag_group', { group: 'Anatomy', plan_id: gone.plan_id });
    expect(root().tagsGroups).toEqual([]);
    expect(x.sb.read(a).tags).toContain('hands'); // the tag stays on the item
    void b;
  });

  it('starred tags, saved filters and copying to another library', async () => {
    const x = await start();
    const [a, b] = x.sample;
    const { api } = x.host;
    await api.updateItems([a], { addTags: ['hands'], star: 4 });
    const ok = async (tool: string, args: Record<string, unknown>) => {
      const r = await x.client.call(tool, args);
      expect(r.isError, `${tool}: ${r.text}`).toBe(false);
      return r.data;
    };
    const libFile = (name: string) => JSON.parse(readFileSync(join(x.sb.libPath, name), 'utf8'));

    expect((await ok('star_tags', { tags: ['hands'] })).status).toBe('applied');
    expect(libFile('tags.json').starredTags).toEqual(['hands']);
    expect((await ok('list_tags', { starred_only: true })).tags).toEqual([
      expect.objectContaining({ name: 'hands', starred: true }),
    ]);
    expect((await ok('star_tags', { tags: ['hands'] })).status).toBe('nothing_to_do');

    const saved = await ok('save_filter', {
      name: 'Good hands',
      filter: { tags: ['hands'], rating: [4, 5] },
    });
    expect(saved.status).toBe('applied');
    expect(libFile('saved-filters.json').map((f: any) => f.name)).toEqual(['Good hands']);
    const listed = (await ok('list_smart_folders', {})).saved_filters;
    expect(listed[0]).toMatchObject({ name: 'Good hands', index: 0 });
    expect(
      (await ok('search_items', { saved_filter: 'good hands' })).items.map((i: any) => i.id),
    ).toEqual([a]);
    const typo = await x.client.call('save_filter', { name: 'x', filter: { tagz: ['a'] } });
    expect(typo.isError).toBe(true);

    // Another library the app knows: an emptied copy of sample (same root, no items).
    const other = join(x.sb.dir, 'Other.library');
    execFileSync('cp', ['-r', '--reflink=auto', x.sb.libPath, other]);
    rmSync(join(other, 'images'), { recursive: true });
    mkdirSync(join(other, 'images'));
    writeFileSync(join(other, 'mtime.json'), '{"all":0}');
    await api.addLibrary(other);
    const before = readdirSync(join(other, 'images')).length;
    const copied = await ok('copy_to_library', { item_ids: [a, b], to_library: other });
    expect(copied.status, JSON.stringify(copied)).toBe('applied');
    expect(copied.added).toHaveLength(2);
    expect(readdirSync(join(other, 'images'))).toHaveLength(before + 2);
    expect(
      (await x.client.call('copy_to_library', { item_ids: [a], to_library: x.sb.libPath })).text,
    ).toMatch(/the same/);
  });

  it("works on the library it names, never the one the user is looking at, and keeps the user's view out of it", async () => {
    const x = await start();
    const [a, b] = x.sample;
    const { api } = x.host;
    const main = x.sb.libPath;
    const other = join(x.sb.dir, 'Other.library');
    execFileSync('cp', ['-r', '--reflink=auto', main, other]);
    rmSync(join(other, 'images'), { recursive: true });
    mkdirSync(join(other, 'images'));
    writeFileSync(join(other, 'mtime.json'), '{"all":0}');
    await api.addLibrary(other);
    const seen: string[] = [];
    x.host.on('library', (s) => seen.push(s.ref.path));
    const ok = async (tool: string, args: Record<string, unknown>) => {
      const r = await x.client.call(tool, args);
      expect(r.isError, `${tool}: ${r.text}`).toBe(false);
      return r.data;
    };

    // The user is on main; the agent works in Other, which opens in the background only.
    await ok('create_folder', { library: other, name: 'Agent picks' });
    const copied = await ok('copy_to_library', { item_ids: [a], to_library: 'Other' });
    expect(copied.added).toHaveLength(1);
    expect((await api.getLibraryState())?.ref.path).toBe(main);
    expect(seen).not.toContain(other);
    // The copy went through Other's open session: one History entry, nothing logged as outside.
    const otherHistory = (await ok('history', { library: other })).entries;
    expect(otherHistory.map((e: any) => e.label)).not.toContainEqual(
      expect.stringMatching(/outside/i),
    );
    expect(otherHistory).toHaveLength(2);

    // The user switches to Other: an agent naming main still writes to main.
    await api.openLibrary(other);
    expect((await api.getLibraryState())?.folders.map((f) => f.name)).toContain('Agent picks');
    await ok('add_tags', { library: main, item_ids: [b], tags: ['agent-tag'] });
    expect(x.sb.read(b).tags).toContain('agent-tag');
    expect((await api.getLibraryState())?.ref.path).toBe(other);
    // And back: Other stays usable for the agent after the user leaves it.
    await api.openLibrary(main);
    expect((await ok('library_info', { library: other })).counts.items).toBe(1);
  });
});

it('a pause cancels the import an agent is waiting on, then waits for it to stop', async () => {
  let state: JobProgress['state'] = 'running';
  const cancelJob = vi.fn(async () => void setTimeout(() => (state = 'cancelled'), 100));
  const api = {
    listJobs: async () => [{ jobId: 'j', state }],
    cancelJob,
  } as unknown as CoreApi;
  let paused = false;
  setTimeout(() => (paused = true), 60);
  const job = await waitForJob(api, 'j', 60_000, () => paused);
  expect(cancelJob).toHaveBeenCalledOnce();
  expect(job?.state).toBe('cancelled');
});

it('shows one strip entry per agent, even while it runs calls in parallel (the strip keys by name)', () => {
  const shown: AgentActivity[][] = [];
  const host = {
    setAgentActivity: (list: AgentActivity[]) => shown.push(list),
    isAgentPaused: () => false,
  } as unknown as CoreHost;
  const state = new McpState(host);
  const first = state.startActivity('Bot (MCP)', 'Tagging 2 items', 2);
  state.startActivity('Bot (MCP)', 'Tagging 3 items', 3);
  expect(shown.at(-1)).toEqual([expect.objectContaining({ name: 'Bot (MCP)', total: 5 })]);
  first.end();
  expect(shown.at(-1)).toEqual([expect.objectContaining({ name: 'Bot (MCP)', total: 3 })]);
});
