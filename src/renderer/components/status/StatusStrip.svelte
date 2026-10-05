<script lang="ts">
  // The 32 px strip along the bottom: sync state, what the partner did last, running jobs, agents,
  // the History button and the ports tooltip. Reads library.status (kept fresh by on('status')).
  import { onMount } from 'svelte';
  import Bot from '@lucide/svelte/icons/bot';
  import Cloud from '@lucide/svelte/icons/cloud';
  import CloudAlert from '@lucide/svelte/icons/cloud-alert';
  import CloudOff from '@lucide/svelte/icons/cloud-off';
  import Clock from '@lucide/svelte/icons/clock';
  import Info from '@lucide/svelte/icons/info';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import Users from '@lucide/svelte/icons/users';
  import X from '@lucide/svelte/icons/x';
  import { api } from '../../lib/api';
  import { fail } from '../../lib/edit';
  import { plural, relativeTime } from '../../lib/format';
  import { library } from '../../lib/stores/library.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import { view } from '../../lib/stores/view.svelte';
  import type { JobProgress } from '../../../shared/types';
  import { history } from '../inspector/history.svelte';
  import { jobs, jobText } from './jobs.svelte';
  import { oldCopiesText, partnerText, portLines, syncText, externalText } from './strip';

  const status = $derived(library.status);
  const sync = $derived(status?.sync ?? null);
  const conflicts = $derived(sync?.conflicts.length ?? 0);
  const unreadable = $derived(status?.unreadableItems ?? 0);
  const external = $derived(status?.lastExternal ?? null);
  const agents = $derived(status?.agents ?? []);
  const running = $derived(jobs.running);
  const ports = $derived(portLines(status?.ports ?? null));
  // Dropbox's state only means something for a library that's shared over it.
  const shared = $derived(!!library.current?.shared);
  const partnerName = $derived(library.current?.partnerName?.trim() || null);
  const partner = $derived(partnerText(status?.partner, partnerName));
  const oldCopies = $derived(oldCopiesText(status?.partner, partnerName));

  // "5 min ago" needs a clock, but not a poll of the app.
  let now = $state(Date.now());
  onMount(() => {
    jobs.init();
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  function showExternal() {
    if (external?.itemIds.length) view.setScope({ kind: 'ids', ids: external.itemIds });
  }

  function openHistory() {
    ui.inspectorVisible = true;
    ui.inspectorTab = 'history';
  }

  /** History, scrolled to the changes that may have been overwritten ("Put my change back"). */
  function reviewOldCopies() {
    openHistory();
    history.revealStale++;
  }

  /** Imports and duplicate searches have a dialog with the details; clicking the job opens it. */
  const hasDialog = (j: JobProgress) => j.kind === 'import' || j.kind === 'dupes';
  const openJob = (j: JobProgress) =>
    ui.openDialog(j.kind === 'import' ? 'import' : 'duplicates', { jobId: j.jobId });

  const pct = (done: number, total: number) =>
    total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;

  function cancel(jobId: string) {
    void api.cancelJob(jobId).catch((e) => fail(e));
  }

  /** The agent stops between chunks; the next status shows it paused. */
  function togglePause(name: string, paused: boolean) {
    void api.setAgentPaused(name, !paused).catch((e) => fail(e));
  }
</script>

<div class="strip">
  {#if shared}
    <span class="grp sync" class:warn={sync?.state === 'offline' || sync?.state === 'unknown'}>
      {#if sync?.state === 'syncing'}
        <RefreshCw size={14} class="spin" />
      {:else if sync?.state === 'offline'}
        <CloudOff size={14} />
      {:else if sync?.state === 'idle'}
        <Cloud size={14} class="okc" />
      {:else}
        <CloudAlert size={14} />
      {/if}
      <span class="txt">{syncText(sync)}</span>
    </span>
  {/if}

  {#if partner}
    <span class="grp partner" title="Seen through the library’s shared files">
      <span class="dot" class:on={status?.partner?.active}></span><span class="txt">{partner}</span>
    </span>
  {/if}

  {#if conflicts}
    <button
      class="link amber"
      onclick={() => ui.openDialog('conflicts')}
      title="Boogie tidies and merges conflicted copies by itself. These need you."
    >
      <TriangleAlert size={13} />{plural(conflicts, 'conflicted copy', 'conflicted copies')} to review
    </button>
  {/if}

  {#if oldCopies}
    <span
      class="grp old"
      title={`Boogie can’t be sure it wasn’t ${partnerName ? `${partnerName}’s` : 'your partner’s'} own edit. Each one is in History: put your change back, or keep theirs.`}
    >
      <RotateCcw size={13} class="rmc" /><span class="txt">{oldCopies}</span>
      <button class="link" onclick={reviewOldCopies}>Review</button>
    </span>
  {/if}

  {#if unreadable}
    <span
      class="grp amber"
      title="Their metadata.json is half-synced or damaged. Boogie leaves them alone and reads them again when they change."
    >
      <TriangleAlert size={13} /><span class="txt"
        >{plural(unreadable, 'item')} couldn’t be read</span
      >
    </span>
  {/if}

  {#if external}
    <span class="vs"></span>
    <span class="grp ext">
      <span class="av" title={partnerName ?? 'Your partner'}
        >{#if partnerName}{partnerName.slice(0, 1).toUpperCase()}{:else}<Users
            size={11}
          />{/if}</span
      >
      <span class="txt"
        >{externalText(external, partnerName)}
        <span class="when">· {relativeTime(external.at, now)}</span></span
      >
      {#if external.itemIds.length}<button class="link" onclick={showExternal}>Show</button>{/if}
    </span>
  {/if}

  <span class="grow"></span>

  {#each running.slice(0, 2) as job (job.jobId)}
    {@const p = pct(job.done, job.total)}
    <span class="grp job" title={job.label}>
      {#if hasDialog(job)}
        <button class="jobtxt" title="Show details" onclick={() => openJob(job)}
          >{jobText(job)}</button
        >
      {:else}
        <span class="txt">{jobText(job)}</span>
      {/if}
      <span class="prog" class:indet={p === null}
        ><i style:width={p === null ? undefined : `${p}%`}></i></span
      >
      <button class="icon" aria-label="Cancel" title="Cancel" onclick={() => cancel(job.jobId)}
        ><X size={12} /></button
      >
    </span>
  {/each}
  {#if running.length > 2}<span class="muted">+{running.length - 2} more</span>{/if}

  {#each agents.slice(0, 2) as agent (agent.name)}
    {@const p = pct(agent.done, agent.total)}
    <span class="grp agent" title={`${agent.name}: ${agent.label}`}>
      <Bot size={14} class="agc" />
      <span class="txt">{agent.label}</span>
      {#if agent.total > 0}
        <span class="prog agp"><i style:width={`${p ?? 0}%`}></i></span>
        <span class="num">{agent.done.toLocaleString()} of {agent.total.toLocaleString()}</span>
      {/if}
      <button
        class="btn"
        title={agent.paused ? 'Let the agent carry on' : 'Stop the agent after its current step'}
        onclick={() => togglePause(agent.name, agent.paused)}
        >{agent.paused ? 'Resume' : 'Pause'}</button
      >
    </span>
  {/each}
  {#if agents.length > 2}<span class="muted">+{agents.length - 2} more</span>{/if}

  <button class="btn" onclick={openHistory}><Clock size={13} />History</button>

  <span class="tipwrap">
    <button class="icon" aria-label="Connections" aria-describedby="ports-tip"
      ><Info size={14} /></button
    >
    <span class="tip" id="ports-tip" role="tooltip">
      {#each ports as line (line)}<span>{line}</span>{/each}
    </span>
  </span>
</div>

<style>
  .strip {
    display: flex;
    align-items: center;
    gap: 14px;
    height: 100%;
    padding: 0 14px;
    font-size: 12px;
    color: var(--mu);
    white-space: nowrap;
  }
  .grp {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  /* Squeeze the middle first, then the agent text. The sync words and the buttons never shrink. */
  .grp.ext {
    flex: 0 3 auto;
  }
  /* Never squeeze it down to nothing: "Sam add…" still says who. */
  .grp.ext .txt {
    min-width: 9ch;
  }
  .grp.sync {
    flex: none;
  }
  .grp.partner {
    flex: 0 2 auto;
  }
  .partner .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: none;
    background: var(--fa);
  }
  .partner .dot.on {
    background: var(--ok);
  }
  .when {
    color: var(--fa);
  }
  .txt {
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .grow {
    flex: 1 1 0;
    min-width: 0;
  }
  .vs {
    width: 1px;
    height: 14px;
    background: var(--line);
    flex: none;
  }
  .grp.job,
  button,
  .tipwrap {
    flex: none;
  }
  .grp.agent {
    flex: 0 1 auto;
  }
  .grp.agent .txt {
    color: var(--ag);
  }
  :global(.okc) {
    color: var(--ok);
  }
  :global(.agc) {
    color: var(--ag);
  }
  :global(.rmc) {
    color: var(--rm);
    flex: none;
  }
  /* Worth more room than the last outside change: it waits for a decision. */
  .grp.old {
    flex: 0 1 auto;
    color: var(--tx);
  }
  .grp.warn {
    color: var(--warn);
  }
  :global(.spin) {
    animation: spin 1.6s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .av {
    width: 18px;
    height: 18px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--rm);
    color: var(--bg);
    font-size: 9.5px;
    font-weight: 600;
  }
  .link {
    color: var(--link);
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border-radius: 4px;
    cursor: pointer;
  }
  .link:hover {
    text-decoration: underline;
  }
  .link.amber,
  .grp.amber {
    color: var(--warn);
  }
  .jobtxt {
    color: inherit;
    border-radius: 4px;
    cursor: pointer;
  }
  .jobtxt:hover {
    color: var(--tx);
    text-decoration: underline;
  }
  .muted {
    color: var(--fa);
  }
  .num {
    color: var(--mu);
    font-variant-numeric: tabular-nums;
  }
  .prog {
    width: 90px;
    height: 4px;
    border-radius: 2px;
    background: var(--line);
    overflow: hidden;
    flex: none;
  }
  .prog i {
    display: block;
    height: 100%;
    background: var(--bl-soft);
    transition: width 150ms ease-out;
  }
  .prog.agp i {
    background: var(--ag);
  }
  .prog.indet i {
    width: 40%;
    animation: slide 1.4s ease-in-out infinite alternate;
  }
  @keyframes slide {
    from {
      margin-left: 0;
    }
    to {
      margin-left: 60%;
    }
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--tx);
    padding: 3px 8px;
    border-radius: 5px;
    border: 1px solid var(--panel-line);
    cursor: pointer;
    transition: background 100ms ease-out;
  }
  .btn:hover:not(:disabled) {
    background: var(--hov);
  }
  .btn:disabled {
    color: var(--fa);
    cursor: default;
  }
  .icon {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 4px;
    color: var(--mu);
    cursor: pointer;
  }
  .icon:hover {
    background: var(--hov);
    color: var(--tx);
  }
  button:focus-visible {
    outline: 1px solid var(--bl-soft);
    outline-offset: 1px;
  }
  .tipwrap {
    position: relative;
    display: flex;
  }
  .tip {
    display: none;
    position: absolute;
    right: 0;
    bottom: calc(100% + 8px);
    flex-direction: column;
    gap: 4px;
    padding: 8px 10px;
    min-width: 200px;
    border-radius: 8px;
    background: var(--panel);
    border: 1px solid var(--panel-line);
    box-shadow: var(--shadow-pop);
    color: var(--tx);
    font-size: 12px;
    z-index: 50;
  }
  .tipwrap:hover .tip,
  .tipwrap:focus-within .tip {
    display: flex;
  }
</style>
