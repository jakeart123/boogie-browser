<script lang="ts">
  // Dropbox conflicted copies: what they are, and where to find them. Lists the live
  // library.status.sync.conflicts, so it updates as they appear or get cleaned up.
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import Copy from '@lucide/svelte/icons/copy';
  import GitCompare from '@lucide/svelte/icons/git-compare';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import { api, inElectron } from '../../lib/api';
  import { relativeTime } from '../../lib/format';
  import { library } from '../../lib/stores/library.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import type { ConflictFile, RootConflictPlan } from '../../../shared/types';
  import { canEdit, errorText, mutate, readOnlyTip, toastWithUndo } from '../../lib/edit';
  import { plural } from '../../lib/format';
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

  // A conflicted copy of the root file (folders, smart folders): what differs, and bring back
  // the picked changes. The copy itself is never edited or deleted.
  let plan = $state<{ path: string; data: RootConflictPlan | null; error: string | null } | null>(
    null,
  );
  let picked = $state<string[]>([]);
  let applying = $state(false);

  async function review(f: ConflictFile) {
    plan = { path: f.path, data: null, error: null };
    picked = [];
    try {
      const data = await api.planRootConflict(f.path);
      if (plan?.path !== f.path) return;
      // Nothing is ticked: you pick each change you want back yourself.
      plan = { ...plan, data };
    } catch (e) {
      if (plan?.path === f.path) plan = { ...plan, error: errorText(e) };
    }
  }

  async function bringBack() {
    if (!plan?.data || !picked.length || applying || !canEdit()) return;
    applying = true;
    const r = await mutate(() => api.applyRootConflict(plan!.path, [...picked]));
    applying = false;
    if (!r) return;
    if (r.changed)
      toastWithUndo(`Brought back ${plural(r.changed, 'change')} from the copy`, r.groupId);
    await review({ path: plan.path, kind: 'root', itemId: null, detectedAt: 0 });
  }

  const toggle = (id: string) =>
    (picked = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);

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

<Modal title="Conflicted copies" width={620}>
  <p class="why">
    Dropbox makes a “conflicted copy” when two computers save the same file at almost the same
    moment. Eagle ignores these copies, so nothing you see changes. For a copy of the folder list,
    Compare shows what differs and brings back what you pick. Boogie never changes the copy: when
    you’re sure you don’t need it, delete it in your file manager.
  </p>

  {#if files.length}
    <ul class="list">
      {#each files as f (f.path)}
        <li>
          <div class="top">
            <span class="dg-badge">{KIND[f.kind]}</span>
            <span class="when">{relativeTime(f.detectedAt)}</span>
          </div>
          <div class="path" title={f.path}>{f.path}</div>
          <div class="dg-row" style="margin-top:6px">
            {#if f.itemId}
              <button class="dg-btn sm" onclick={() => reveal(f)}
                ><FolderOpen size={13} />Reveal</button
              >
            {:else}
              {#if f.kind === 'root'}
                <button class="dg-btn sm" onclick={() => review(f)}
                  ><GitCompare size={13} />Compare</button
                >
              {/if}
              <button class="dg-btn sm" onclick={() => copy(fullPath(f))}
                ><Copy size={13} />Copy path</button
              >
              {@const sp = splitPath(fullPath(f), 40)}
              <span class="dg-hint dg-mid full" title={fullPath(f)}
                ><span class="head">{sp.head}</span><span class="tail">{sp.tail}</span></span
              >
            {/if}
          </div>
          {#if plan?.path === f.path}
            <div class="plan">
              {#if plan.error}
                <p class="dg-err">{plan.error}</p>
              {:else if !plan.data}
                <p class="dg-hint">Comparing with the library…</p>
              {:else if !plan.data.changes.length}
                <p class="dg-hint">
                  Nothing differs from the library. The copy can go (delete it in your file
                  manager).
                </p>
              {:else}
                <p class="dg-hint">
                  Tick what to bring back from the copy. Everything else stays as it is now.
                </p>
                <ul class="changes">
                  {#each plan.data.changes as c (c.id + c.change)}
                    <li>
                      <label class="dg-check">
                        <input
                          type="checkbox"
                          checked={picked.includes(c.id)}
                          onchange={() => toggle(c.id)}
                        /><span>{c.label}</span>
                      </label>
                    </li>
                  {/each}
                </ul>
                <div class="dg-row" style="margin-top:8px">
                  <button
                    class="dg-btn sm"
                    onclick={() =>
                      (picked =
                        picked.length === plan!.data!.changes.length
                          ? []
                          : plan!.data!.changes.map((c) => c.id))}
                    >{picked.length === plan.data.changes.length
                      ? 'Select none'
                      : 'Select all'}</button
                  >
                  <span style="flex:1"></span>
                  <button
                    class="dg-btn sm pri"
                    disabled={!picked.length || applying || library.readOnly}
                    title={readOnlyTip()}
                    onclick={bringBack}>Bring back {picked.length || ''}</button
                  >
                </div>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <div class="dg-empty">
      <CircleCheck size={28} style="color:var(--ok)" />No conflicted copies. Everything is in sync.
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
  }
  .when {
    margin-left: auto;
    font-size: 11.5px;
    color: var(--fa);
  }
  .path {
    font: 12px/1.45 var(--mono);
    color: var(--tx);
    overflow-wrap: anywhere;
  }
  .plan {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--line);
  }
  .changes {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    max-height: 240px;
    overflow: auto;
  }
  .changes .dg-check {
    margin: 3px 0;
  }
  .full {
    flex: 1;
    min-width: 0;
    font-family: var(--mono);
  }
</style>
