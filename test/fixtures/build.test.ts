// Builds the small test libraries in test/fixtures/libraries/ that the core tests use when the
// (gitignored, private) research/sandbox/templates are missing. Made with Boogie's own
// createLibrary and import of plain generated pictures: no real artwork, safe to publish.
// The three "sample" items keep the ids the tests know (and the sync tests' mtime.json ids).
//
// Rebuild (normally never needed; the output is committed):
//   BOOGIE_BUILD_FIXTURES=1 npx vitest run test/fixtures/build.test.ts
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createCoreHost } from '../../src/core/service';

const OUT = resolve('test/fixtures/libraries');
// Same ids, names and root file as the private sample copy, so the same tests pass on both.
const SAMPLE = [
  { id: 'LT24XY3DPJFLK', name: '0051', lm: 1768535137009, from: '#c8b890', to: '#4a3a24' },
  {
    id: 'MKG8VYYQTA5SW',
    name: "Shirley Fox prank at gerome's",
    lm: 1768535175732,
    from: '#e8ece4',
    to: '#383c38',
  },
  {
    id: 'MKGA0LUUPY9BM',
    name: "Julius M Price pranks at Gerome's",
    lm: 1768531649367,
    from: '#9c9286',
    to: '#46332e',
  },
];
const EMPTY_ROOT = {
  applicationVersion: '4.0.0',
  folders: [],
  smartFolders: [],
  quickAccess: [],
  tagsGroups: [],
  modificationTime: 1768529105282,
};
const SAMPLE_ROOT = {
  ...EMPTY_ROOT,
  folders: [
    {
      id: 'MCMAU0FCY6HY9',
      name: 'Class 2025',
      description: '',
      children: [],
      modificationTime: 1751481450411,
      tags: [],
      extendTags: [],
      pinyin: 'Class 2025',
      password: '',
      passwordTips: '',
      orderBy: 'NAME',
      sortIncrease: true,
    },
  ],
  modificationTime: 1768535326568,
};
const ART = ['red-navy', 'gold-olive', 'teal-white', 'plum-pink', 'gray-black', 'orange-brown'];
const ART_EXTS = ['jpg', 'jpeg']; // all jpg items, like the real sandbox subset the tests expect

it.skipIf(!process.env.BOOGIE_BUILD_FIXTURES)('build the fixture libraries', async () => {
  const work = mkdtempSync(join(resolve('.tmp'), 'fixtures-'));
  const pics = join(work, 'pics');
  mkdirSync(pics, { recursive: true });
  const config = join(work, 'home/config');
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ writableRoots: [OUT] }));
  const host = await createCoreHost({
    paths: {
      config,
      cache: join(work, 'home/cache'),
      data: join(work, 'home/data'),
      tmp: join(work, 'home/cache/tmp'),
    },
    deps: {
      eagleMonitor: { check: async () => ({ running: false, openLibraryPath: null }) },
      dropbox: { check: async () => ({ state: 'idle', detail: 'Up to date' }) },
    },
    discovery: { home: work, settingsFiles: [], dropboxDir: join(work, 'no-dropbox') },
  });
  const build = async (name: string, files: string[], tags: string[]) => {
    const lib = join(OUT, `${name}.library`);
    if (existsSync(lib)) rmSync(lib, { recursive: true }); // our own generated output
    mkdirSync(OUT, { recursive: true });
    await host.api.createLibrary(OUT, name);
    const { jobId } = await host.api.importPaths(files, { tags, onDuplicate: 'keep-both' });
    for (let i = 0; ; i++) {
      const job = (await host.api.listJobs()).find((j) => j.jobId === jobId);
      if (job && job.state !== 'running') break;
      if (i > 3000) throw new Error('import did not finish');
      await new Promise((r) => setTimeout(r, 20));
    }
    await host.api.closeLibrary();
    return lib;
  };

  // sample: three pictures big enough to get a thumbnail, tagged, in no folder, plus one folder.
  const sampleFiles = SAMPLE.map((j) => {
    const f = join(pics, `${j.name}.jpg`);
    execFileSync('magick', [
      '-size',
      '900x1100',
      `gradient:${j.from}-${j.to}`,
      '-quality',
      '70',
      f,
    ]);
    return f;
  });
  const sample = await build('sample', sampleFiles, ['Atelier Gerome']);
  // Its root and backups as Eagle left them (one folder; the backup from before it was made).
  writeFileSync(join(sample, 'metadata.json'), JSON.stringify(SAMPLE_ROOT));
  const backups = join(sample, 'backup');
  for (const f of readdirSync(backups)) rmSync(join(backups, f)); // ours, just made by createLibrary
  writeFileSync(join(backups, 'backup-2026-01-15 18.08.01.280.json'), JSON.stringify(EMPTY_ROOT));
  writeFileSync(join(backups, 'backup-2026-01-15 19.49.04.483.json'), JSON.stringify(SAMPLE_ROOT));
  const images = join(sample, 'images');
  for (const dir of readdirSync(images)) {
    const meta = join(images, dir, 'metadata.json');
    const rec = JSON.parse(readFileSync(meta, 'utf8'));
    const j = SAMPLE.find((x) => x.name === rec.name)!;
    rec.id = j.id;
    rec.lastModified = j.lm;
    if (j.id === SAMPLE[0]!.id) rec.order = { LSWHRPBU3BR11: '1708903185351.5' }; // a folder it no longer has
    writeFileSync(meta, JSON.stringify(rec));
    renameSync(join(images, dir), join(images, `${j.id}.info`));
  }
  writeFileSync(join(sample, 'mtime.json'), '{}'); // as in the real copy
  writeFileSync(
    join(sample, 'tags.json'),
    JSON.stringify({ historyTags: ['Atelier Gerome'], starredTags: [] }),
  );

  // art-archive: small untagged jpg pictures (shown without a thumbnail, like Eagle does).
  const artFiles = ART.flatMap((pair, i) =>
    ART_EXTS.map((ext, j) => {
      const f = join(pics, `${pair} ${i}${j ? ' b' : ''}.${ext}`);
      const size = `${64 + i * 8}x${48 + j * 16}`; // every picture different: no duplicates
      execFileSync('magick', ['-size', size, `gradient:${pair}`, f]);
      return f;
    }),
  );
  await build('art-archive', artFiles, []);
  await host.close();
  rmSync(work, { recursive: true, force: true }); // our own scratch under .tmp
  expect(readdirSync(join(OUT, 'art-archive.library', 'images')).length).toBe(artFiles.length);
});
