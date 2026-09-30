<script lang="ts">
  // The duplicate finder. Three steps in one dialog: choose what to look for, watch the scan,
  // then go through the groups and merge (each merge can be undone).
  import { untrack } from 'svelte';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { api } from '../../lib/api';
  import { fileSize, plural, quoted } from '../../lib/format';
  import { library } from '../../lib/stores/library.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import { view } from '../../lib/stores/view.svelte';
  import type { DupeScanOptions, DuplicateGroup, Scope } from '../../../shared/types';
  import { jobs, jobText } from '../status/jobs.svelte';
  import {
    actionableGroups,
    groupsWith,
    keeperOf,
    removable,
    STRICTNESS,
    strictnessLabel,
    summaryLine,
    totals,
  } from './dupes';
  import DupeGroup from './DupeGroup.svelte';
  import { onEscape } from './escape';
  import { errorText, readOnlyTip, undo } from '../../lib/edit';
  import Modal from './Modal.svelte';

  let { props: incoming }: { props: Record<string, unknown> } = $props();
  // Read once: Dialogs.svelte mounts a fresh component for every openDialog call.
  const args = untrack(() => incoming);

  const libraryId = $derived(library.state?.ref.id ?? '');
  const limitIds = Array.isArray(args.ids) ? (args.ids as string[]) : null;

  // ── options ──
  let mode = $state<'exact' | 'similar'>('exact');
  let threshold = $state(STRICTNESS.initial);
  const folderScope = $derived(view.scope.kind === 'folder' ? view.scope : null);
  const folderLabel = $derived.by(() => {
    const name = folderScope ? library.folder(folderScope.id)?.node.name : undefined;
    return name ? quoted(name) : 'this folder';
  });
  let where = $state<'library' | 'folder' | 'selected'>(limitIds?.length ? 'selected' : 'library');
  const others = $derived(
    library.known.filter((k) => k.path !== library.state?.ref.path && k.exists),
  );
  let pickedOthers = $state<string[]>([]);
  let startError = $state<string | null>(null);
  let starting = $state(false);

  // ── the scan ──
  let jobId = $state<string | null>(typeof args.jobId === 'string' ? args.jobId : null);
  const job = $derived(jobs.byId(jobId));
  const phase = $derived<'options' | 'scanning' | 'results'>(
    !jobId
      ? 'options'
      : !job || job.state === 'running'
        ? 'scanning'
        : job.state === 'done'
          ? 'results'
          : 'options',
  );

  const allGroups = $derived.by(() => {
    if (phase !== 'results' || !Array.isArray(job?.result)) return [] as DuplicateGroup[];
    let g = actionableGroups(job.result as DuplicateGroup[], libraryId);
    if (limitIds?.length && where === 'selected') g = groupsWith(g, limitIds, libraryId);
    return g;
  });

  // ── the results ──
  let keepers = $state<Record<string, string>>({});
  let hidden = $state<string[]>([]);
  let showHidden = $state(false);
  let merged = $state<Record<string, { keptName: string; count: number; groupId: string | null }>>(
    {},
  );
  let merging = $state<string | null>(null);
  let limit = $state(40);
  let confirmAll = $state(false);
  /** How many groups "Merge all" is merging right now. */
  let bulk = $state<number | null>(null);

  const keeperFor = (g: DuplicateGroup) => keeperOf(g, keepers[g.key], libraryId);
  // Merged groups stay in the list as a one-line "Merged. Undo"; only groups still open count in the totals.
  const shown = $derived(allGroups.filter((g) => showHidden || !hidden.includes(g.key)));
  const live = $derived(allGroups.filter((g) => !merged[g.key] && !hidden.includes(g.key)));
  const sums = $derived(totals(live, keeperFor, libraryId));
  const exactLive = $derived(
    live.filter((g) => g.kind === 'exact' && removable(g, keeperFor(g), libraryId).length > 0),
  );
  const exactSums = $derived(totals(exactLive, keeperFor, libraryId));
  const blocked = $derived(
    library.readOnly ? (readOnlyTip() ?? null) : bulk ? 'Merging is running' : null,
  );
  const wasFiltered = $derived(!!limitIds?.length && where === 'selected');

  $effect(() => {
    if (!confirmAll) return;
    return onEscape(() => ((confirmAll = false), true));
  });

  function scopeFor(): Scope | undefined {
    if (where === 'folder' && folderScope)
      return {
        kind: 'folder',
        id: folderScope.id,
        includeSubfolders: folderScope.includeSubfolders,
      };
    return undefined; // 'selected' scans the whole library, then keeps groups that involve the selection
  }

  async function start() {
    if (starting) return;
    starting = true;
    startError = null;
    keepers = {};
    hidden = [];
    merged = {};
    limit = 40;
    try {
      const opts: DupeScanOptions = { mode, scope: scopeFor() };
      if (mode === 'similar') opts.threshold = threshold;
      if (pickedOthers.length) opts.otherLibraries = [...pickedOthers];
      const r = await api.findDuplicates(opts);
      jobId = r.jobId;
    } catch (e) {
      startError = errorText(e);
    } finally {
      starting = false;
    }
  }

  function stop() {
    if (jobId) void api.cancelJob(jobId).catch(() => undefined);
    jobId = null;
  }

  function again() {
    jobId = null;
    startError = null;
  }

  const pct = $derived(
    job && job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : null,
  );

  // ── merging ──
  /** Undo a merge (one group, or all of "Merge all": they share one history entry). */
  async function undoMerge(groupId: string, keys: string[]) {
    if (
      !(await undo(groupId, keys.length > 1 ? `Merged ${plural(keys.length, 'group')}` : undefined))
    )
      return;
    const rest = { ...merged };
    for (const k of keys) delete rest[k];
    merged = rest;
  }

  function undoOne(key: string) {
    const id = merged[key]?.groupId;
    if (!id) return;
    // Groups merged together by "Merge all" come back together.
    void undoMerge(
      id,
      Object.keys(merged).filter((k) => merged[k].groupId === id),
    );
  }

  async function mergeOne(g: DuplicateGroup) {
    if (blocked || merging) return;
    const keeper = keeperFor(g);
    const gone = removable(g, keeper, libraryId);
    if (!gone.length) return;
    merging = g.key;
    try {
      const res = await api.mergeDuplicates({ keeperId: keeper, otherIds: gone.map((m) => m.id) });
      if (res.warning) ui.toast(res.warning, { kind: 'warn' });
      const keptName = g.members.find((m) => m.id === keeper)?.name ?? 'the kept item';
      merged = { ...merged, [g.key]: { keptName, count: gone.length, groupId: res.groupId } };
      ui.toast(`Merged ${plural(gone.length + 1, 'copy', 'copies')} into one`, {
        kind: 'ok',
        action: res.groupId ? { label: 'Undo', run: () => undoOne(g.key) } : undefined,
      });
    } catch (e) {
      ui.toast(errorText(e), { kind: 'error' });
    } finally {
      merging = null;
    }
  }

  /** One call and one history entry for every group, so a single Undo brings them all back. */
  async function mergeAll() {
    const todo = exactLive;
    confirmAll = false;
    if (!todo.length || blocked) return;
    bulk = todo.length;
    const plans = todo.map((g) => {
      const keeper = keeperFor(g);
      return { g, keeper, gone: removable(g, keeper, libraryId) };
    });
    try {
      const res = await api.mergeDuplicates(
        plans.map((p) => ({ keeperId: p.keeper, otherIds: p.gone.map((m) => m.id) })),
      );
      if (res.warning) ui.toast(res.warning, { kind: 'warn' });
      const next = { ...merged };
      for (const p of plans)
        next[p.g.key] = {
          keptName: p.g.members.find((m) => m.id === p.keeper)?.name ?? 'the kept item',
          count: p.gone.length,
          groupId: res.groupId,
        };
      merged = next;
      const groupId = res.groupId;
      const keys = plans.map((p) => p.g.key);
      ui.toast(`Merged ${plural(plans.length, 'group')}`, {
        kind: 'ok',
        action: groupId
          ? { label: 'Undo all', run: () => void undoMerge(groupId, keys) }
          : undefined,
      });
    } catch (e) {
      ui.toast(errorText(e), { kind: 'error' });
    } finally {
      bulk = null;
    }
  }
</script>

<Modal
  title="Find duplicates"
  subtitle={phase === 'options'
    ? 'Look for copies of the same picture, even under different names.'
    : undefined}
  width={phase === 'results' ? 920 : 560}
>
  {#if phase === 'options'}
    <div class="dg-field" role="radiogroup" aria-label="What to look for">
      <span class="dg-label">Look for</span>
      <label class="card" class:on={mode === 'exact'}>
        <input type="radio" name="mode" value="exact" bind:group={mode} />
        <span
          ><b>Exact copies</b><span class="dg-sub"
            >The same file content, whatever the name. Fast and safe.</span
          ></span
        >
      </label>
      <label class="card" class:on={mode === 'similar'}>
        <input type="radio" name="mode" value="similar" bind:group={mode} />
        <span
          ><b>Similar images</b><span class="dg-sub"
            >The same picture at another size or quality. Slower.</span
          ></span
        >
      </label>
    </div>

    {#if mode === 'similar'}
      <div class="dg-field">
        <label class="dg-label" for="strict">Strictness</label>
        <input
          id="strict"
          class="dg-range"
          type="range"
          min={STRICTNESS.min}
          max={STRICTNESS.max}
          step="1"
          bind:value={threshold}
        />
        <div class="scale"><span>Stricter</span><span>Looser</span></div>
        <p class="dg-hint">{strictnessLabel(threshold)}</p>
      </div>
    {/if}

    <div class="dg-field" role="radiogroup" aria-label="Where to look">
      <span class="dg-label">Where</span>
      {#if limitIds?.length}
        <label class="dg-check"
          ><input type="radio" name="where" value="selected" bind:group={where} /><span
            >Copies of the {plural(limitIds.length, 'selected item')}<span class="dg-sub"
              >Searches the whole library</span
            ></span
          ></label
        >
      {/if}
      <label class="dg-check"
        ><input type="radio" name="where" value="library" bind:group={where} /><span
          >This library</span
        ></label
      >
      <label class="dg-check" class:off={!folderScope}>
        <input
          type="radio"
          name="where"
          value="folder"
          bind:group={where}
          disabled={!folderScope}
        />
        <span
          >{folderScope ? `Only ${folderLabel}` : 'Only the current folder'}{#if !folderScope}<span
              class="dg-sub">Open a folder first</span
            >{/if}</span
        >
      </label>
    </div>

    {#if others.length}
      <div class="dg-field">
        <span class="dg-label">Also compare with other libraries</span>
        {#each others as k (k.path)}
          <label class="dg-check">
            <input type="checkbox" value={k.path} bind:group={pickedOthers} />
            <span
              >{k.name}<span class="dg-sub">Opened read-only, nothing in it is changed</span></span
            >
          </label>
        {/each}
      </div>
    {/if}
    {#if startError}<p class="dg-err" style="margin-top:12px">{startError}</p>{/if}
    {#if job && (job.state === 'failed' || job.state === 'cancelled')}
      <p class="dg-err" style="margin-top:12px">
        {job.state === 'failed'
          ? `The search failed. ${job.error ?? ''}`
          : 'The search was cancelled.'}
      </p>
    {/if}
  {:else if phase === 'scanning'}
    <div class="scan">
      <div class="dg-row">
        <LoaderCircle size={15} class="dg-spin" /><span>{job ? jobText(job) : 'Starting…'}</span>
      </div>
      <div class="dg-prog" class:indet={pct === null}>
        <i style:width={pct === null ? undefined : `${pct}%`}></i>
      </div>
      <p class="dg-hint">
        You can close this and keep working. The finder will tell you when it’s done.
      </p>
    </div>
  {:else if !allGroups.length}
    <div class="dg-empty">
      <CircleCheck size={28} style="color:var(--ok)" />{wasFiltered
        ? 'No other copies of the selected items were found.'
        : 'No duplicates found.'}
    </div>
  {:else}
    <div class="bar">
      <span class="sum">{live.length ? summaryLine(sums) : 'Nothing left to merge'}</span>
      {#if hidden.length}
        <button class="dg-link" onclick={() => (showHidden = !showHidden)}
          >{showHidden ? 'Hide' : 'Show'} {hidden.length.toLocaleString()} hidden</button
        >
      {/if}
      <span class="grow"></span>
      {#if bulk}
        <span class="dg-row"
          ><LoaderCircle size={14} class="dg-spin" />Merging {plural(bulk, 'group')}…</span
        >
      {:else if exactLive.length}
        <button
          class="dg-btn sm"
          disabled={!!blocked}
          title={blocked ?? undefined}
          onclick={() => (confirmAll = true)}>Merge all exact groups</button
        >
      {/if}
    </div>
    {#if confirmAll}
      <div class="dg-note-box confirm" role="alertdialog" aria-label="Merge all exact groups">
        <TriangleAlert size={15} />
        <div class="cbody">
          <b>Merge {plural(exactLive.length, 'group')} of exact copies?</b>
          Each group keeps the item marked “Keep” and moves {plural(
            exactSums.extraCopies,
            'extra copy',
            'extra copies',
          )} to the trash, {fileSize(exactSums.bytes)} in all. Every merge can be undone.
          <div class="dg-row" style="margin-top:8px">
            <button class="dg-btn sm danger" onclick={mergeAll}
              >Merge {plural(exactLive.length, 'group')}</button
            >
            <button class="dg-btn sm" onclick={() => (confirmAll = false)}>Cancel</button>
          </div>
        </div>
      </div>
    {/if}

    <div class="groups">
      {#each shown.slice(0, limit) as g, i (g.key)}
        <DupeGroup
          group={g}
          n={i + 1}
          keeperId={keeperFor(g)}
          {libraryId}
          merged={merged[g.key] ?? null}
          merging={merging === g.key}
          {blocked}
          onkeeper={(id) => (keepers = { ...keepers, [g.key]: id })}
          onmerge={() => mergeOne(g)}
          onhide={() => (hidden = [...hidden, g.key])}
          onundo={() => undoOne(g.key)}
        />
      {/each}
      {#if shown.length > limit}
        <button class="dg-btn more" onclick={() => (limit += 60)}
          >Show {Math.min(60, shown.length - limit).toLocaleString()} more of {(
            shown.length - limit
          ).toLocaleString()} left</button
        >
      {/if}
      {#if !live.length}<div class="dg-empty">
          <CircleCheck size={28} style="color:var(--ok)" />All done. Nothing left to review.
        </div>{/if}
    </div>
  {/if}

  {#snippet footer()}
    {#if phase === 'options'}
      <span class="dg-sp"></span>
      <button class="dg-btn" onclick={() => ui.closeDialog()}>Cancel</button>
      <button class="dg-btn pri" disabled={starting} onclick={start}
        >{#if starting}<LoaderCircle size={14} class="dg-spin" />{/if}Find duplicates</button
      >
    {:else if phase === 'scanning'}
      <span class="dg-sp"></span>
      <button class="dg-btn" onclick={stop}>Stop</button>
      <button class="dg-btn" onclick={() => ui.closeDialog()}>Keep working</button>
    {:else}
      <button class="dg-btn" onclick={again}>New search</button>
      <span class="dg-sp"></span>
      <button class="dg-btn pri" onclick={() => ui.closeDialog()}>Done</button>
    {/if}
  {/snippet}
</Modal>

<style>
  .card {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 9px;
    border: 1px solid var(--line);
    cursor: pointer;
    font-size: 12.5px;
    transition: background 100ms ease-out;
  }
  .card:hover {
    background: var(--hov);
  }
  .card.on {
    border-color: color-mix(in srgb, var(--bl) 60%, transparent);
    background: color-mix(in srgb, var(--bl) 7%, transparent);
  }
  .card input {
    margin: 2px 0 0;
    accent-color: var(--bl);
  }
  .card b {
    font-weight: 600;
    display: block;
  }
  .card .dg-sub {
    display: block;
    color: var(--fa);
    margin-top: 1px;
  }
  .scale {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    color: var(--fa);
  }
  .scan {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 0 4px;
    font-size: 13px;
  }
  .bar {
    position: sticky;
    top: -4px;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 8px 0;
    margin-bottom: 6px;
    background: var(--panel);
    font-size: 12.5px;
  }
  .sum {
    font-weight: 600;
  }
  .grow {
    flex: 1;
  }
  .groups {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .more {
    align-self: center;
  }
  .confirm {
    margin-bottom: 10px;
  }
  .cbody {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
</style>
