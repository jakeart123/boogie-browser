// Jobs (imports, duplicate scans) and the duplicate tools built on them.
import { z } from 'zod';
import type { CoreApi } from '../../../shared/api';
import type { DuplicateGroup, ImportResult, JobProgress } from '../../../shared/types';
import { type Change, previewMerge } from '../changes';
import { UserError } from '../errors';
import { FolderIndex } from '../folders';
import { jobOut } from '../format';
import { openLibrary, plural, type Tool, TWO_STEP, uniq, writableLibrary } from '../kit';
import { MAX_ITEMS_PER_APPLY } from '../plans';
import { itemId, library, page, planId } from '../schemas';
import { fetchItems, fromMutation, runWrite } from '../write';

/** How long a tool call waits for a job before handing back a job id. Tests shorten it. */
export const WAIT_MS = { dupes: 60_000, imports: 60_000 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a job to leave "running", up to `ms`. Returns the last state seen, or null when the app
 * no longer lists the job (finished long ago). Uses performance.now so tests can freeze Date. When
 * `stop()` turns true (the user paused the agent) the job is cancelled; it then stops at its next
 * file, and that is waited for too.
 */
export async function waitForJob(
  api: CoreApi,
  jobId: string,
  ms: number,
  stop?: () => boolean,
): Promise<JobProgress | null> {
  let end = performance.now() + ms;
  let delay = 50;
  let cancelled = false;
  for (;;) {
    const job = (await api.listJobs()).find((j) => j.jobId === jobId) ?? null;
    if (!job || job.state !== 'running' || performance.now() >= end) return job;
    if (!cancelled && stop?.()) {
      cancelled = true;
      await api.cancelJob(jobId);
      end = Math.max(end, performance.now() + 30_000);
      delay = 50;
      continue;
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, 1000);
  }
}

const GROUPS_SHOWN = 25;
const MEMBERS_SHOWN = 20;

function dupGroupsOut(
  groups: DuplicateGroup[],
  offset: number,
  limit: number,
  folders: FolderIndex,
  currentLibraryId: string,
) {
  return groups.slice(offset, offset + limit).map((g) => ({
    key: g.key,
    kind: g.kind,
    suggested_keeper_id: g.suggestedKeeperId,
    members: g.members.slice(0, MEMBERS_SHOWN).map((m) => ({
      id: m.id,
      library: m.libraryName,
      name: m.name,
      ext: m.ext,
      size: m.size,
      width: m.width,
      height: m.height,
      rating: m.star,
      tags: m.tags,
      folders:
        m.libraryId === currentLibraryId
          ? m.folders.map((id) => folders.get(id)?.path ?? id)
          : m.folders,
      distance: m.distance,
    })),
    ...(g.members.length > MEMBERS_SHOWN ? { members_total: g.members.length } : {}),
  }));
}

export function registerJobTools(tool: Tool): void {
  tool(
    'find_duplicates',
    {
      title: 'Find duplicates',
      description:
        'Find duplicate items: exact (same file content, any name) or similar (near copies). Changes nothing. Waits up to 60 s, else returns a job_id for job_status. Groups come with a suggested keeper for merge_duplicates.',
      input: z.strictObject({
        library,
        mode: z.enum(['exact', 'similar']).optional().describe('Default exact.'),
        threshold: z
          .number()
          .int()
          .min(0)
          .max(64)
          .optional()
          .describe('similar: allowed difference, 0 to 64 (default 6).'),
        folder: z.string().optional().describe('Only inside this folder and its subfolders.'),
        other_libraries: z
          .array(z.string())
          .max(5)
          .optional()
          .describe('Library paths to compare against (reported, never merged).'),
        ...page,
      }),
      kind: 'read',
    },
    async ({ mode, threshold, folder, other_libraries, offset, limit }, call) => {
      const state = await openLibrary(call);
      const idx = new FolderIndex(state.folders);
      const scope = folder
        ? ({ kind: 'folder', id: idx.resolve(folder).id, includeSubfolders: true } as const)
        : undefined;
      const { jobId } = await call.api.findDuplicates({
        mode: mode ?? 'exact',
        threshold,
        otherLibraries: other_libraries,
        scope,
      });
      const job = await waitForJob(call.api, jobId, WAIT_MS.dupes);
      return jobResult(job, jobId, idx, state.ref.id, offset ?? 0, limit ?? GROUPS_SHOWN);
    },
  );

  tool(
    'job_status',
    {
      title: 'Job status',
      description:
        'State, progress and result of a find_duplicates or import job. offset and limit page through duplicate groups.',
      input: z.strictObject({ library, job_id: z.string().min(1), ...page }),
      kind: 'read',
    },
    async ({ job_id, offset, limit }, call) => {
      const state = await openLibrary(call);
      const job = (await call.api.listJobs()).find((j) => j.jobId === job_id) ?? null;
      return jobResult(
        job,
        job_id,
        new FolderIndex(state.folders),
        state.ref.id,
        offset ?? 0,
        limit ?? GROUPS_SHOWN,
      );
    },
  );

  tool(
    'merge_duplicates',
    {
      title: 'Merge duplicates',
      description:
        'Merge duplicate groups (this library only): each keeper gets the union of tags, folders and notes, the best rating and the first URL; the others go to the trash. All groups become one undoable change.' +
        TWO_STEP,
      input: z.strictObject({
        library,
        groups: z
          .array(
            z.strictObject({
              keeper_id: itemId,
              other_ids: z.array(itemId).min(1).max(50),
            }),
          )
          .min(1)
          .max(100),
        plan_id: planId,
      }),
      kind: 'changing',
    },
    async ({ groups, plan_id }, call) => {
      const lib = await writableLibrary(call);
      const all = groups.flatMap((g) => [g.keeper_id, ...g.other_ids]);
      if (uniq(all).length !== all.length)
        throw new UserError(
          'An item id appears more than once across the groups (or a keeper is also listed as a duplicate). Each item may be in one group only.',
        );
      return runWrite(
        call,
        lib,
        { tool: 'merge_duplicates', args: { groups }, kind: 'changing', planId: plan_id },
        async () => {
          if (all.length > MAX_ITEMS_PER_APPLY)
            throw new UserError(
              `That is ${all.length} items and the limit is ${MAX_ITEMS_PER_APPLY} per apply. Merge fewer groups per call.`,
            );
          const idx = new FolderIndex(lib.folders);
          const items = new Map((await fetchItems(call.api, all)).map((i) => [i.id, i]));
          const changes: Change[] = [];
          for (const g of groups) {
            const others = g.other_ids.map((id) => items.get(id)!);
            const merge = previewMerge(items.get(g.keeper_id)!, others, idx);
            changes.push(...merge.changes);
            for (const o of others)
              if (merge.trashIds.includes(o.id) && !o.isDeleted)
                changes.push({
                  id: o.id,
                  name: o.name,
                  field: 'in_trash',
                  before: false,
                  after: true,
                });
          }
          return {
            summary: `Merge ${plural(groups.length, 'group')} of duplicates and move ${plural(all.length - groups.length, 'duplicate')} to the trash`,
            changes,
            itemCount: all.length,
            activity: `Merging ${plural(groups.length, 'duplicate group')}`,
            emptyNote: 'Nothing to merge.',
            // One call, so the whole merge is one history entry and one undo.
            apply: async () =>
              fromMutation(
                await call.api.mergeDuplicates(
                  groups.map((g) => ({ keeperId: g.keeper_id, otherIds: g.other_ids })),
                ),
              ),
          };
        },
      );
    },
  );
}

/** Shared by find_duplicates and job_status: what an agent should see of a job. */
function jobResult(
  job: JobProgress | null,
  jobId: string,
  folders: FolderIndex,
  libraryId: string,
  offset: number,
  limit: number,
): Record<string, unknown> {
  if (!job)
    return {
      job_id: jobId,
      state: 'unknown',
      hint: 'The app no longer lists this job. It may have finished a while ago; check the library with search_items or history.',
    };
  const base = { ...jobOut(job) };
  if (job.state === 'running')
    return { ...base, hint: 'Still running. Call job_status with this job_id in a few seconds.' };
  if (job.state === 'failed')
    throw new UserError(`The ${job.kind} job failed: ${job.error ?? 'no reason given'}.`);
  if (job.state === 'cancelled') return { ...base, hint: 'The job was cancelled.' };
  if (job.kind === 'dupes') {
    const groups = (job.result as DuplicateGroup[] | undefined) ?? [];
    const shown = dupGroupsOut(groups, offset, limit, folders, libraryId);
    return {
      ...base,
      total_groups: groups.length,
      offset,
      returned: shown.length,
      groups: shown,
      hint: groups.length
        ? 'To merge, call merge_duplicates with the keeper and the other ids of a group (dry run first).'
        : 'No duplicates found.',
    };
  }
  if (job.kind === 'import')
    return { ...base, ...importResultOut(job.result as ImportResult | undefined) };
  return { ...base, ...(job.result !== undefined ? { result: job.result } : {}) };
}

export function importResultOut(r: ImportResult | undefined) {
  return {
    ...(r?.groupId ? { group_id: r.groupId } : {}),
    added: r?.added ?? [],
    duplicates: (r?.duplicates ?? []).map((d) => ({ source: d.source, existing_id: d.existingId })),
    failed: r?.failed ?? [],
    ...(r?.warnings?.length ? { warnings: r.warnings } : {}),
  };
}
