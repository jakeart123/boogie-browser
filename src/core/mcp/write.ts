// The one path every write tool takes: build the change list, then either show it (dry run,
// plan_id) or apply it. Keeping this in one place is what makes "changing writes are always
// plan-then-apply" and "bulk writes need a plan" true for every tool at once.
import type { CoreApi } from '../../shared/api';
import type { Item, LibraryState, MutationResult } from '../../shared/types';
import { type Change, displayChanges } from './changes';
import { UserError } from './errors';
import { type Call, iso } from './kit';
import { DIRECT_WRITE_LIMIT, hashOf, MAX_ITEMS_PER_APPLY } from './plans';

export interface Applied {
  groupId: string | null;
  changed: number;
  skipped?: { id: string; reason: string }[];
  warning?: string;
  /** Tool specific fields folded into the result (new folder id, imported ids). */
  extra?: Record<string, unknown>;
}

export interface Draft {
  /** One plain sentence: "Move 12 items to the trash". */
  summary: string;
  changes: Change[];
  /** Distinct items (or records) touched. Drives the 50 and 500 limits. */
  itemCount: number;
  /** Label for the status strip while applying: "Tagging 48 items". */
  activity: string;
  /** Said when there is nothing to do ("All 5 items already have those tags"). */
  emptyNote?: string;
  /** Anything else that should invalidate a plan when it changes (file sizes of imports). */
  digestExtra?: unknown;
  /** `progress(done)` updates the status strip; most writes are one call and ignore it. */
  apply(progress: (done: number) => void): Promise<Applied>;
}

export interface WriteMode {
  tool: string;
  /** The tool's arguments without plan_id and dry_run: a plan only applies to exactly these. */
  args: unknown;
  kind: 'additive' | 'changing';
  dryRun?: boolean;
  planId?: string;
}

export const fromMutation = (r: MutationResult, extra?: Record<string, unknown>): Applied => ({
  groupId: r.groupId,
  changed: r.changed,
  skipped: r.skipped.length ? r.skipped : undefined,
  warning: r.warning,
  extra,
});

/** Build the change list; the digest is what a plan must still match when it is applied. */
async function draftOf(build: () => Promise<Draft>): Promise<{ draft: Draft; digest: string }> {
  const draft = await build();
  if (draft.itemCount > MAX_ITEMS_PER_APPLY) {
    throw new UserError(
      `This would touch ${draft.itemCount} items and the limit is ${MAX_ITEMS_PER_APPLY} per apply. Split it into batches of ${MAX_ITEMS_PER_APPLY} or fewer.`,
    );
  }
  return { draft, digest: hashOf([draft.changes, draft.digestExtra ?? null]) };
}

const nothingToDo = (draft: Draft) => ({
  status: 'nothing_to_do',
  summary: draft.emptyNote ?? 'Nothing to change.',
  item_count: 0,
});

export async function runWrite(
  call: Call,
  lib: LibraryState,
  mode: WriteMode,
  build: () => Promise<Draft>,
): Promise<Record<string, unknown>> {
  const { plans } = call.state;
  const argsHash = hashOf(mode.args);
  const plan = mode.planId ? plans.check(mode.planId, mode.tool, argsHash, lib.ref.id) : null;

  const { draft, digest } = await draftOf(build);
  if (draft.changes.length === 0) return nothingToDo(draft);
  const needsPlan = mode.kind === 'changing' || draft.itemCount > DIRECT_WRITE_LIMIT;

  if (!plan && (needsPlan || mode.dryRun)) {
    const minted = plans.mint({ tool: mode.tool, argsHash, libraryId: lib.ref.id, digest });
    return {
      status: 'dry_run',
      summary: draft.summary,
      item_count: draft.itemCount,
      plan_id: minted.id,
      plan_expires_at: iso(minted.expiresAt),
      how_to_apply: `Nothing was changed. To apply exactly this, call ${mode.tool} again with the same arguments plus plan_id "${minted.id}" (valid 15 minutes).`,
      ...displayChanges(draft.changes),
    };
  }

  const activity = call.state.startActivity(call.actor.name, draft.activity, draft.itemCount);
  let applied: Applied;
  try {
    if (plan) {
      if (plan.digest !== digest) {
        throw new UserError(
          'The library changed since the dry run (these items were edited in the meantime). Nothing was applied. Call the tool again without plan_id to see the current change list.',
        );
      }
      if (!plans.take(plan.id)) throw new UserError('That plan was already applied.');
    }
    applied = await draft.apply(activity.progress);
  } finally {
    activity.end();
  }
  return {
    status: 'applied',
    summary: draft.summary,
    item_count: draft.itemCount,
    changed: applied.changed,
    group_id: applied.groupId,
    ...(applied.skipped ? { skipped: applied.skipped } : {}),
    ...(applied.warning ? { warning: applied.warning } : {}),
    ...(applied.groupId
      ? {
          undo: 'To revert this, call undo (with group_id, or with no arguments to undo your latest change).',
        }
      : {}),
    ...applied.extra,
  };
}

const CHUNK = 200;

/** Items by id in the order asked, plus the ids that no longer exist. */
export async function getItemsInOrder(
  api: CoreApi,
  ids: string[],
): Promise<{ items: Item[]; missing: string[] }> {
  const found = new Map<string, Item>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    for (const item of await api.getItems(ids.slice(i, i + CHUNK))) found.set(item.id, item);
  }
  return {
    items: ids.filter((id) => found.has(id)).map((id) => found.get(id)!),
    missing: ids.filter((id) => !found.has(id)),
  };
}

/** Like getItemsInOrder, but unknown ids are an error: writing to a guessed id must never half work. */
export async function fetchItems(api: CoreApi, ids: string[]): Promise<Item[]> {
  const { items, missing } = await getItemsInOrder(api, ids);
  if (missing.length) {
    throw new UserError(
      `Unknown item ids: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` and ${missing.length - 10} more` : ''}. Ids come from search_items and belong to that library.`,
    );
  }
  return items;
}
