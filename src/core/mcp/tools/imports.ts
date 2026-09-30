// Adding pictures: from a web address or from files on this computer.
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, sep } from 'node:path';
import { z } from 'zod';
import type { ImportOptions, ImportResult } from '../../../shared/types';
import { type Change } from '../changes';
import { UserError } from '../errors';
import { FolderIndex } from '../folders';
import {
  ADDITIVE_RULE,
  type Call,
  isPaused,
  openLibrary,
  type Tool,
  uniq,
  writableLibrary,
} from '../kit';
import { MAX_ITEMS_PER_APPLY } from '../plans';
import { dryRun, folderRef, itemIds, planId } from '../schemas';
import { type Applied, fetchItems, runWrite } from '../write';
import { importResultOut, WAIT_MS, waitForJob } from './jobs';

const importFields = {
  folder: folderRef.optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  rating: z.number().int().min(0).max(5).optional(),
  note: z.string().max(20_000).optional(),
  on_duplicate: z
    .enum(['skip', 'keep-both', 'use-existing'])
    .optional()
    .describe('Same file content already in the library. Default skip.'),
};

type ImportArgs = {
  folder?: string;
  tags?: string[];
  rating?: number;
  note?: string;
  on_duplicate?: 'skip' | 'keep-both' | 'use-existing';
};

function optionsFor(a: ImportArgs, folders: FolderIndex, url?: string): ImportOptions {
  return {
    folderId: a.folder ? folders.resolve(a.folder).id : undefined,
    tags: a.tags?.length ? uniq(a.tags) : undefined,
    star: a.rating,
    annotation: a.note,
    url,
    onDuplicate: a.on_duplicate ?? 'skip',
  };
}

const inside = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * Only plain files from outside every library and outside Boogie's own folders: importing from a
 * library would copy items between libraries behind the partner's back, and Boogie's config
 * folder holds the API token.
 */
async function checkImportPath(
  path: string,
  blocked: string[],
): Promise<{ path: string; size: number }> {
  if (!isAbsolute(path)) throw new UserError(`${path}: use an absolute path.`);
  const real = await realpath(path).catch(() => null);
  if (!real) throw new UserError(`${path}: file not found.`);
  const st = await stat(real);
  if (!st.isFile())
    throw new UserError(
      `${path}: not a regular file. Folders are not imported here; pass the file paths.`,
    );
  if (/\.library(\/|$)/i.test(real) || blocked.some((b) => inside(real, b))) {
    throw new UserError(
      `${path}: refused. Files inside an Eagle library or Boogie's own folders cannot be imported. Items already in a library can be copied with add_to_folders or moved by the app.`,
    );
  }
  return { path, size: st.size };
}

async function blockedRoots(call: Call, current: string): Promise<string[]> {
  const known = (await call.api.listLibraries()).map((l) => l.path);
  const p = call.host.paths;
  const secrets = ['.ssh', '.gnupg', '.aws'].map((d) => `${homedir()}${sep}${d}`);
  const roots = [current, ...known, p.config, p.cache, p.data, ...secrets];
  const real = await Promise.all(roots.map((r) => realpath(r).catch(() => r)));
  return uniq([...roots, ...real]);
}

/**
 * Wait for the import (or copy) job, then turn its result into what the agent sees. If the user
 * pauses the agent meanwhile, the job stops at its next file; what was added so far stays (and
 * undoes as one change).
 */
async function finishImport(call: Call, jobId: string, what = 'import'): Promise<Applied> {
  let stopped = false;
  const job = await waitForJob(call.api, jobId, WAIT_MS.imports, () => (stopped = isPaused(call)));
  if (job?.state === 'failed')
    throw new UserError(`The ${what} failed: ${job.error ?? 'no reason given'}.`);
  if (stopped) {
    const result = job?.result as ImportResult | undefined;
    const added = result?.added.length ?? 0;
    return {
      groupId: result?.groupId ?? null,
      changed: added,
      warning: `The user paused this agent, so the ${what} stopped part way: ${added === 1 ? '1 item was' : `${added} items were`} added, the rest were not. Stop here and try again after they resume it.`,
      extra: { job_id: jobId, job_state: job?.state ?? 'unknown', ...importResultOut(result) },
    };
  }
  if (!job || job.state === 'running') {
    return {
      groupId: null,
      changed: 0,
      extra: {
        job_id: jobId,
        job_state: job?.state ?? 'unknown',
        hint: `The ${what} is still going. Call job_status with this job_id to see when it is done and what was added.`,
      },
    };
  }
  const result = job.result as ImportResult | undefined;
  if (result && !result.added.length && result.failed.length && !result.duplicates.length) {
    const why = result.failed.map((f) => `${f.source}: ${f.reason}`).join('; ');
    throw new UserError(`Nothing was ${what === 'import' ? 'imported' : 'copied'}. ${why}`);
  }
  return {
    groupId: result?.groupId ?? null,
    changed: result?.added?.length ?? 0,
    extra: { job_id: jobId, job_state: job.state, ...importResultOut(result) },
  };
}

export function registerImportTools(tool: Tool): void {
  tool(
    'import_url',
    {
      title: 'Import from URL',
      description:
        'Download a picture or video from an http(s) address into the library (waits up to 60 s). Returns the new item id.',
      input: z.strictObject({
        url: z.string().trim().min(1).max(4000),
        name: z.string().trim().min(1).max(200).optional(),
        ...importFields,
        dry_run: dryRun,
        plan_id: planId,
      }),
      kind: 'additive',
      idempotent: false,
      openWorld: true,
    },
    async ({ url, name, dry_run, plan_id, ...rest }, call) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new UserError(`"${url}" is not a valid URL.`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        throw new UserError(
          'Only http and https addresses can be imported. For a file on this computer use import_file.',
        );
      const lib = await writableLibrary(call);
      const folders = new FolderIndex(lib.folders);
      const opts = optionsFor(rest, folders);
      return runWrite(
        call,
        lib,
        {
          tool: 'import_url',
          args: { url, name, ...rest },
          kind: 'additive',
          dryRun: dry_run,
          planId: plan_id,
        },
        async () => ({
          summary: `Download ${url} into the library${rest.folder ? ` (folder ${folders.resolve(rest.folder).path})` : ''}`,
          changes: [
            { id: url, name: name ?? url, field: 'import', before: null, after: 'new item' },
          ],
          itemCount: 1,
          activity: 'Importing from a URL',
          apply: async () => {
            const { jobId } = await call.api.importUrl(url, { ...opts, url, name });
            return finishImport(call, jobId);
          },
        }),
      );
    },
  );

  tool(
    'import_file',
    {
      title: 'Import files',
      description:
        "Copy files (absolute paths, not folders) into the library; the originals stay. Files inside a library or Boogie's own folders are refused. Waits up to 60 s." +
        ADDITIVE_RULE,
      input: z.strictObject({
        paths: z.array(z.string().min(1).max(4000)).min(1).max(MAX_ITEMS_PER_APPLY),
        source_url: z.string().max(4000).optional(),
        ...importFields,
        dry_run: dryRun,
        plan_id: planId,
      }),
      kind: 'additive',
      idempotent: false,
    },
    async ({ paths, source_url, dry_run, plan_id, ...rest }, call) => {
      const lib = await writableLibrary(call);
      const folders = new FolderIndex(lib.folders);
      const opts = optionsFor(rest, folders, source_url);
      const list = uniq(paths);
      return runWrite(
        call,
        lib,
        {
          tool: 'import_file',
          args: { paths: list, source_url, ...rest },
          kind: 'additive',
          dryRun: dry_run,
          planId: plan_id,
        },
        async () => {
          const blocked = await blockedRoots(call, lib.ref.path);
          const files = await Promise.all(list.map((p) => checkImportPath(p, blocked)));
          const changes: Change[] = files.map((f) => ({
            id: f.path,
            name: basename(f.path),
            field: 'import',
            before: null,
            after: `new item (${f.size} bytes)`,
          }));
          return {
            summary: `Import ${files.length === 1 ? '1 file' : `${files.length} files`} into the library${rest.folder ? ` (folder ${folders.resolve(rest.folder).path})` : ''}`,
            changes,
            itemCount: files.length,
            activity: `Importing ${files.length} files`,
            digestExtra: files,
            apply: async () => {
              const { jobId } = await call.api.importPaths(list, opts);
              return finishImport(call, jobId);
            },
          };
        },
      );
    },
  );

  tool(
    'copy_to_library',
    {
      title: 'Copy to another library',
      description:
        "Copy items (files and details, as new items) into another library from list_libraries; this library doesn't change. Waits up to 60 s." +
        ADDITIVE_RULE,
      input: z.strictObject({
        item_ids: itemIds,
        library: z.string().min(1).describe('Its path, as list_libraries shows it.'),
        folder: z.string().optional().describe('A folder in that library (id, path or name).'),
        dry_run: dryRun,
        plan_id: planId,
      }),
      kind: 'additive',
      idempotent: false,
    },
    async ({ item_ids, library, folder, dry_run, plan_id }, call) => {
      const lib = await openLibrary(call); // only the target is written to
      const target = (await call.api.listLibraries()).find(
        (l) => l.path === library || l.name.toLowerCase() === library.trim().toLowerCase(),
      );
      if (!target || !target.exists)
        throw new UserError(`No known library at "${library}". list_libraries shows them.`);
      if (target.path === lib.ref.path)
        throw new UserError('That is the open library. Use add_to_folders to file items here.');
      let folderId: string | null = null;
      let folderPath: string | null = null;
      if (folder) {
        if (!call.api.listLibraryFolders)
          throw new UserError("Folders of another library can't be read here; leave out folder.");
        const f = new FolderIndex(await call.api.listLibraryFolders(target.path)).resolve(folder);
        folderId = f.id;
        folderPath = f.path;
      }
      const ids = uniq(item_ids);
      const where = `library "${target.name}"${folderPath ? `, folder ${folderPath}` : ''}`;
      return runWrite(
        call,
        lib,
        {
          tool: 'copy_to_library',
          args: { item_ids: ids, library: target.path, folder: folderId },
          kind: 'additive',
          dryRun: dry_run,
          planId: plan_id,
        },
        async () => {
          const items = await fetchItems(call.api, ids);
          return {
            summary: `Copy ${items.length === 1 ? '1 item' : `${items.length} items`} into ${where}`,
            changes: items.map((it) => ({
              id: it.id,
              name: it.name,
              field: 'copy_to',
              before: null,
              after: where,
            })),
            itemCount: items.length,
            activity: `Copying ${items.length} items to ${target.name}`,
            apply: async () => {
              const { jobId } = await call.api.copyToLibrary(ids, target.path, { folderId });
              return finishImport(call, jobId, 'copy');
            },
          };
        },
      );
    },
  );
}
