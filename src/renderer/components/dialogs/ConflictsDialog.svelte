<script lang="ts">
  // Dropbox conflicted copies that need a person. Boogie tidies the ones with nothing new in them
  // and merges what it can be sure of by itself (History shows both), so what is listed here is
  // either a copy with questions (what differs and couldn't be merged with certainty) or one Boogie
  // can't do anything with. Lists the live library.status.sync.conflicts, so it updates as they
  // appear or get settled.
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import Copy from '@lucide/svelte/icons/copy';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import { api, inElectron } from '../../lib/api';
  import { relativeTime } from '../../lib/format';
  import { library } from '../../lib/stores/library.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import type { ConflictFile, ConflictQuestion } from '../../../shared/types';
  import { canEdit, errorText, mutate, readOnlyTip, toastWithUndo } from '../../lib/edit';
  import {
    copyName,
    isBlank,
    removalNote,
    removes,
    settledText,
    settleLabel,
    splitQuestions,
    whyListed,
  } from './conflicts';
  import { splitPath } from './names';
  import Modal from './Modal.svelte';

  const files = $derived(library.status?.sync.conflicts ?? []);
  const root = $derived(library.state?.ref.path ?? '');

  const KIND: Record<ConflictFile['kind'], string> = {
    root: 'Folders, smart folders and tag groups',
    item: 'An item’s details',
    mtime: 'Change times',
    tags: 'Starred tags',
    thumbnail: 'A thumbnail',
    other: 'Another file',
  };

  const fullPath = (f: ConflictFile) => `${root.replace(/\/+$/, '')}/${f.path}`;

  async function reveal(f: ConflictFile) {
    try {
      if (f.itemId) await api.revealItem(f.itemId);
    } catch (e) {
      ui.toast(errorText(e), { kind: 'error' });
    }
  }

  // An item copy says which item it is by name, since its path is only an id.
  let names = $state<Record<string, string>>({});
  const asked = new Set<string>();
  $effect(() => {
    for (const f of files) {
      const id = f.itemId;
      if (!id || asked.has(id)) continue;
      asked.add(id);
      api
        .getItem(id)
        .then((item) => {
          if (item) names[id] = item.name;
        })
        .catch(() => undefined);
    }
  });

  // The answers: per copy, the question ids that take the copy's value. Everything else keeps the
  // library's, which is what each question starts as. Ids that stop being questions are ignored.
  let taken = $state<Record<string, string[]>>({});
  let settling = $state<string[]>([]);

  const takenFor = (f: ConflictFile): string[] =>
    (taken[f.path] ?? []).filter((id) => f.questions?.some((q) => q.id === id));
  const isTaken = (f: ConflictFile, id: string) => (taken[f.path] ?? []).includes(id);

  function choose(f: ConflictFile, id: string, fromCopy: boolean) {
    const rest = (taken[f.path] ?? []).filter((x) => x !== id);
    taken[f.path] = fromCopy ? [...rest, id] : rest;
  }

  // "Take all" never covers a removal: those are picked one at a time.
  function chooseAll(f: ConflictFile, fromCopy: boolean) {
    taken[f.path] = fromCopy ? (f.questions ?? []).filter((q) => !removes(q)).map((q) => q.id) : [];
  }

  // The block of "only in the library" questions is collapsed until you open it.
  let opened = $state<Record<string, boolean>>({});

  /** How many of the picked questions take something away from the library. */
  const removingCount = (f: ConflictFile): number =>
    (f.questions ?? []).filter((q) => removes(q) && isTaken(f, q.id)).length;

  async function settle(f: ConflictFile) {
    if (settling.includes(f.path) || !canEdit()) return;
    const ids = takenFor(f);
    settling = [...settling, f.path];
    const r = await mutate(() => api.resolveConflict(f.path, ids));
    settling = settling.filter((p) => p !== f.path);
    if (!r) return;
    delete taken[f.path];
    // What really was taken: a pick that couldn't be made (the core says why) isn't counted. With
    // nothing taken the library didn't change, so there is nothing for Undo to put back.
    toastWithUndo(settledText(r.changed), r.changed > 0 ? r.groupId : null);
  }

  async function copy(text: string) {
    try {
      if (inElectron) await api.copyText(text);
      else await navigator.clipboard.writeText(text);
      ui.toast('Path copied', { kind: 'ok', ms: 2000 });
    } catch (e) {
      ui.toast(`Couldn’t copy. ${errorText(e)}`, { kind: 'error' });
    }
  }
</script>

{#snippet row(f: ConflictFile, q: ConflictQuestion, busy: boolean)}
  {@const fromCopy = isTaken(f, q.id)}
  <div class="qrow" role="radiogroup" aria-label={q.label}>
    <span class="ql" title={q.label}>{q.label}</span>
    <label class="opt" class:on={!fromCopy}>
      <input
        type="radio"
        name={`${f.path}|${q.id}`}
        aria-label={`${q.label}, in the library now: ${q.live}`}
        checked={!fromCopy}
        disabled={busy || library.readOnly}
        onchange={() => choose(f, q.id, false)}
      />
      <span class="val" class:blank={isBlank(q.live)} title={q.live}>{q.live}</span>
    </label>
    <label class="opt" class:on={fromCopy}>
      <input
        type="radio"
        name={`${f.path}|${q.id}`}
        aria-label={`${q.label}, in the copy: ${q.copy}`}
        checked={fromCopy}
        disabled={busy || library.readOnly}
        onchange={() => choose(f, q.id, true)}
      />
      <span class="val" class:blank={isBlank(q.copy)} title={q.copy}>{q.copy}</span>
    </label>
  </div>
{/snippet}

<Modal title="Conflicted copies" width={680}>
  <p class="why">
    Dropbox makes a “conflicted copy” when two computers save the same file at almost the same
    moment. Boogie tidies copies with nothing new in them and merges what it can be sure of by
    itself, and History shows each one. What’s listed here needs you. Nothing is deleted: settled
    copies are kept in Boogie’s backup.
  </p>

  {#if files.length}
    <ul class="list">
      {#each files as f (f.path)}
        {@const qs = f.questions ?? []}
        {@const mine = takenFor(f)}
        {@const busy = settling.includes(f.path)}
        <li>
          <div class="top">
            <span class="dg-badge">{KIND[f.kind]}</span>
            {#if f.itemId && names[f.itemId]}
              <span class="item" title={names[f.itemId]}>{names[f.itemId]}</span>
            {/if}
            <span class="when">{relativeTime(f.detectedAt)}</span>
          </div>
          <div class="path" title={f.path}>{copyName(f.path)}</div>

          {#if qs.length}
            {@const split = splitQuestions(qs)}
            {@const bulk = qs.filter((q) => !removes(q))}
            {@const opens = !!opened[f.path]}
            <div class="qs">
              <div class="qrow qhead">
                <span>What differs</span><span>In the library now</span><span>In the copy</span>
              </div>
              {#each split.main as q (q.id)}
                {@render row(f, q, busy)}
              {/each}
              {#if split.removals.length}
                <button
                  class="rmhead"
                  aria-expanded={opens}
                  onclick={() => (opened[f.path] = !opens)}
                >
                  {#if opens}<ChevronDown size={14} />{:else}<ChevronRight size={14} />{/if}
                  <span class="rmt"
                    >{split.removals.length.toLocaleString()} in the library but not in the copy</span
                  >
                  <span class="rmh">Taking the copy removes these</span>
                </button>
                {#if opens}
                  {#each split.removals as q (q.id)}
                    {@render row(f, q, busy)}
                  {/each}
                {/if}
              {/if}
            </div>
            <div class="dg-row act">
              {#if bulk.length > 1}
                {@const all = bulk.every((q) => isTaken(f, q.id))}
                <button
                  class="dg-btn sm"
                  disabled={busy || library.readOnly}
                  onclick={() => chooseAll(f, !all)}
                  >{all
                    ? 'Keep all as they are'
                    : bulk.length < qs.length
                      ? 'Take all except removals'
                      : 'Take all from the copy'}</button
                >
              {/if}
              {#if f.itemId}
                <button class="dg-btn sm" onclick={() => reveal(f)}
                  ><FolderOpen size={13} />Reveal</button
                >
              {/if}
              <span class="sum"></span>
              <button
                class="dg-btn sm pri"
                disabled={busy || library.readOnly}
                title={readOnlyTip()}
                onclick={() => settle(f)}>{settleLabel(mine.length)}</button
              >
            </div>
            {#if removalNote(removingCount(f))}
              <p class="dg-hint rmnote">{removalNote(removingCount(f))}</p>
            {/if}
          {:else}
            <p class="dg-hint note">{whyListed(f, library.readOnly)}</p>
            <div class="dg-row" style="margin-top:6px">
              {#if f.itemId}
                <button class="dg-btn sm" onclick={() => reveal(f)}
                  ><FolderOpen size={13} />Reveal</button
                >
              {:else}
                <button class="dg-btn sm" onclick={() => copy(fullPath(f))}
                  ><Copy size={13} />Copy path</button
                >
                {@const sp = splitPath(fullPath(f), 40)}
                <span class="dg-hint dg-mid full" title={fullPath(f)}
                  ><span class="head">{sp.head}</span><span class="tail">{sp.tail}</span></span
                >
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <div class="dg-empty">
      <CircleCheck size={28} style="color:var(--ok)" />No conflicted copies need you.
    </div>
  {/if}

  {#snippet footer()}
    <span class="dg-sp"></span>
    <button class="dg-btn pri" onclick={() => ui.closeDialog()}>Done</button>
  {/snippet}
</Modal>

<style>
  .why {
    margin: 4px 0 14px;
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--mu);
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .list > li {
    padding: 10px 12px;
    border-radius: 9px;
    border: 1px solid var(--line);
    background: rgba(0, 0, 0, 0.1);
  }
  .top {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 5px;
    min-width: 0;
  }
  .item {
    min-width: 0;
    font-size: 12.5px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .when {
    margin-left: auto;
    flex: none;
    font-size: 11.5px;
    color: var(--fa);
  }
  .path {
    font: 11.5px/1.45 var(--mono);
    color: var(--mu);
    overflow-wrap: anywhere;
  }
  .note {
    margin-top: 6px;
  }
  .full {
    flex: 1;
    min-width: 0;
    font-family: var(--mono);
  }

  /* The questions: one row each, the library's value and the copy's side by side, one chosen. */
  .qs {
    margin-top: 10px;
    max-height: min(420px, 50vh);
    overflow-y: auto;
    border: 1px solid var(--line);
    border-radius: 7px;
    background: var(--fld);
  }
  .qrow {
    display: grid;
    grid-template-columns: minmax(96px, 0.7fr) minmax(0, 1fr) minmax(0, 1fr);
    gap: 6px;
    align-items: stretch;
    padding: 5px 6px 5px 10px;
    border-top: 1px solid var(--line);
  }
  .qrow:first-child {
    border-top: 0;
  }
  .qhead {
    position: sticky;
    top: 0;
    z-index: 1;
    padding-top: 6px;
    padding-bottom: 6px;
    background: var(--fld);
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--fa);
  }
  .qhead span:nth-child(n + 2) {
    padding-left: 29px;
  }
  .ql {
    align-self: center;
    font-size: 12px;
    color: var(--tx);
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .opt {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 6px 9px;
    min-width: 0;
    border-radius: 6px;
    border: 1px solid transparent;
    font-size: 12.5px;
    line-height: 1.4;
    cursor: pointer;
    transition:
      background 100ms ease-out,
      border-color 100ms ease-out;
  }
  .opt:hover {
    background: var(--hov);
  }
  .opt.on {
    background: var(--bls);
    border-color: color-mix(in srgb, var(--bl) 55%, transparent);
  }
  .opt input {
    margin: 2px 0 0;
    flex: none;
    accent-color: var(--bl);
  }
  /* A long value (a note) is cut at three lines; the whole text is in the tooltip. */
  .val {
    min-width: 0;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .val.blank {
    color: var(--fa);
  }
  .act {
    margin-top: 8px;
  }
  .sum {
    flex: 1;
  }
  .rmnote {
    margin-top: 6px;
    text-align: right;
  }
  /* The block of "only in the library" questions: one line until opened. */
  .rmhead {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 10px;
    border-top: 1px solid var(--line);
    background: transparent;
    color: var(--tx);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .rmhead:first-child {
    border-top: 0;
  }
  .rmhead:hover {
    background: var(--hov);
  }
  .rmhead :global(svg) {
    flex: none;
    color: var(--mu);
  }
  .rmt {
    flex: none;
    font-weight: 500;
  }
  .rmh {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fa);
  }
</style>
