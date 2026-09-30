<script lang="ts">
  // Create or edit a smart folder: a name and groups of rules. Each group says "items that do
  // (or don't) match all (or any) of these rules"; a smart folder needs every group to hold.
  import { untrack } from 'svelte';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import Plus from '@lucide/svelte/icons/plus';
  import X from '@lucide/svelte/icons/x';
  import { api } from '../../lib/api';
  import { library } from '../../lib/stores/library.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import { view } from '../../lib/stores/view.svelte';
  import { errorText, readOnlyTip } from '../../lib/edit';
  import Modal from './Modal.svelte';
  import RuleRow from './RuleRow.svelte';
  import {
    MAX_GROUPS,
    MAX_RULES,
    TYPE_SUGGESTIONS,
    defaultRule,
    firstProblem,
    nextKey,
    toConditions,
    toModel,
    type UiGroup,
  } from './smart';
  import { quoted } from '../../lib/format';

  let { props: incoming }: { props: Record<string, unknown> } = $props();
  // Read once: Dialogs.svelte mounts a fresh component for every openDialog call.
  const args = untrack(() => incoming);

  const id = typeof args.id === 'string' ? args.id : null;
  const parentId = typeof args.parentId === 'string' ? args.parentId : null;
  const existing = id ? untrack(() => library.smartFolders.get(id)) : undefined;
  const missing = !!id && !existing;

  const blankGroup = (): UiGroup => ({
    k: nextKey(),
    match: 'AND',
    boolean: 'TRUE',
    rules: [{ k: nextKey(), rule: defaultRule('name') }],
    extra: {},
  });

  let name = $state(existing?.name ?? '');
  let groups = $state<UiGroup[]>(existing ? toModel(existing.conditions) : [blankGroup()]);
  let saving = $state(false);
  /** A failure from the app when saving. Problems with the form itself are worked out live below. */
  let error = $state<string | null>(null);
  /** Turns on once Save has been pressed, so a fresh form doesn't start out red. */
  let showErrors = $state(false);

  const readOnly = $derived(library.readOnly);
  const tagNames = $derived(library.tags.map((t) => t.name));
  const problem = $derived(firstProblem(groups));
  const ruleCount = $derived(groups.reduce((n, g) => n + g.rules.length, 0));
  const formError = $derived(
    !showErrors
      ? null
      : !name.trim()
        ? 'Give the smart folder a name.'
        : !id && !ruleCount
          ? 'Add at least one rule.'
          : problem,
  );
  const parentName = parentId ? (library.smartFolders.get(parentId)?.name ?? null) : null;

  const addRule = (g: UiGroup) =>
    g.rules.length < MAX_RULES && g.rules.push({ k: nextKey(), rule: defaultRule('name') });
  const addGroup = () => groups.length < MAX_GROUPS && groups.push(blankGroup());
  const removeRule = (g: UiGroup, k: number) => (g.rules = g.rules.filter((r) => r.k !== k));
  const removeGroup = (k: number) => (groups = groups.filter((g) => g.k !== k));

  async function save(e?: Event) {
    e?.preventDefault();
    if (saving || readOnly || missing) return;
    showErrors = true;
    if (formError) return;
    const n = name.trim();
    saving = true;
    error = null;
    try {
      const conditions = toConditions(groups);
      if (id) {
        const res = await api.updateSmartFolder(id, { name: n, conditions });
        if (res.warning) ui.toast(res.warning, { kind: 'warn' });
      } else {
        const res = await api.createSmartFolder(n, conditions, parentId);
        view.setScope({ kind: 'smartFolder', id: res.id });
      }
      ui.closeDialog();
    } catch (err) {
      error = errorText(err);
    } finally {
      saving = false;
    }
  }
</script>

<Modal
  title={id ? 'Edit smart folder' : 'New smart folder'}
  subtitle={parentName
    ? `Inside ${quoted(parentName)}. It only shows what that folder shows, narrowed by these rules.`
    : 'A saved search that keeps itself up to date.'}
  width={780}
  backdropClose={false}
>
  <datalist id="smart-types"
    >{#each TYPE_SUGGESTIONS as t (t)}<option value={t}></option>{/each}</datalist
  >

  {#if missing}
    <div class="dg-empty">This smart folder doesn’t exist any more.</div>
  {:else}
    <form id="smart-form" onsubmit={save}>
      <div class="dg-field">
        <label class="dg-label" for="sf-name">Name</label>
        <input
          id="sf-name"
          class="dg-input"
          bind:value={name}
          placeholder="For example: Five stars, wider than 2000 px"
          disabled={readOnly}
          autocomplete="off"
        />
      </div>

      <div class="dg-field">
        <span class="dg-label">Rules</span>
        {#each groups as g, gi (g.k)}
          {#if gi > 0}<div class="and-sep"><span>and</span></div>{/if}
          <fieldset class="group" disabled={readOnly}>
            <div class="ghead">
              <span>Items that</span>
              <select class="dg-select sel" aria-label="Do or do not match" bind:value={g.boolean}>
                <option value="TRUE">do</option>
                <option value="FALSE">do not</option>
              </select>
              <span>match</span>
              <select class="dg-select sel" aria-label="All or any" bind:value={g.match}>
                <option value="AND">all</option>
                <option value="OR">any</option>
              </select>
              <span>of these rules</span>
              <button
                type="button"
                class="dg-ib"
                style="margin-left:auto"
                aria-label="Remove group"
                title="Remove group"
                onclick={() => removeGroup(g.k)}><X size={14} /></button
              >
            </div>
            {#each g.rules as r (r.k)}
              <RuleRow
                bind:rule={r.rule}
                kept={r.kept}
                onedit={() => (r.kept = false)}
                {tagNames}
                {showErrors}
                disabled={readOnly}
                ondelete={() => removeRule(g, r.k)}
              />
            {/each}
            {#if !g.rules.length}<p class="dg-hint" style="margin:6px 0">
                No rules here, so this group matches everything.
              </p>{/if}
            <button
              type="button"
              class="dg-btn sm ghost"
              disabled={g.rules.length >= MAX_RULES}
              onclick={() => addRule(g)}><Plus size={13} />Add rule</button
            >
          </fieldset>
        {/each}
        <div class="dg-row" style="margin-top:8px">
          <button
            type="button"
            class="dg-btn sm"
            disabled={readOnly || groups.length >= MAX_GROUPS}
            onclick={addGroup}><Plus size={13} />Add another group</button
          >
          {#if groups.length > 1}<span class="dg-hint">Every group has to match.</span>{/if}
        </div>
      </div>

      {#if formError ?? error}<p class="dg-err" style="margin-top:12px">
          {formError ?? error}
        </p>{/if}
    </form>
  {/if}

  {#snippet footer()}
    <span class="dg-note">{readOnly ? readOnlyTip() : 'Save to see matches'}</span>
    <span class="dg-sp"></span>
    <button class="dg-btn" onclick={() => ui.closeDialog()}>Cancel</button>
    <button
      class="dg-btn pri"
      type="submit"
      form="smart-form"
      disabled={missing || saving || readOnly}
    >
      {#if saving}<LoaderCircle size={14} class="dg-spin" />{/if}{id ? 'Save' : 'Create'}
    </button>
  {/snippet}
</Modal>

<style>
  .group {
    margin: 0;
    padding: 8px 12px 10px;
    border-radius: 10px;
    border: 1px solid var(--line);
    background: rgba(0, 0, 0, 0.1);
    min-width: 0;
  }
  .ghead {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-bottom: 4px;
    font-size: 12.5px;
    color: var(--mu);
    border-bottom: 1px solid var(--line);
  }
  .sel {
    width: auto;
    min-width: 70px;
    height: 26px;
  }
  .and-sep {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 6px 0;
    color: var(--fa);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .and-sep::before,
  .and-sep::after {
    content: '';
    height: 1px;
    flex: 1;
    background: var(--line);
  }
</style>
