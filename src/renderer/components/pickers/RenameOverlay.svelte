<script lang="ts">
  // Rename (F2 on one item, Ctrl+R on several). One item: a name field. Several: Eagle's batch
  // rename with tokens, find/replace and a live preview of the first six results.
  import { onMount, untrack } from 'svelte';
  import { api } from '../../lib/api';
  import { canEdit, confirmBulk, editItems, fail, mutate, readOnlyTip } from '../../lib/edit';
  import { plural } from '../../lib/format';
  import { items } from '../../lib/stores/items.svelte';
  import { library } from '../../lib/stores/library.svelte';
  import Modal from './Modal.svelte';
  import { normalizeStart, regexError, renamePreview, type RenameSource } from './renameTemplate';

  let { ids, onclose }: { ids: string[]; onclose: () => void } = $props();

  // The overlay is keyed per opening (Pickers), so `ids` is fixed for this instance.
  const single = untrack(() => ids.length === 1);
  const PREVIEW = 6;

  // one item
  let name = $state('');
  let ext = $state('');
  let original = '';
  // several
  let template = $state('*');
  let start = $state(1);
  let find = $state('');
  let replace = $state('');
  let regex = $state(false);
  let sources = $state.raw<RenameSource[]>([]);
  let busy = $state(false);
  let loaded = $state(false);
  let nameEl = $state<HTMLInputElement | null>(null);
  let tplEl = $state<HTMLInputElement | null>(null);

  onMount(() => {
    void (async () => {
      try {
        if (single) {
          const [b] = await api.getBriefs(ids);
          if (b) {
            original = name = b.name;
            ext = b.ext;
          }
        } else {
          const fulls = await items.loadFulls(ids.slice(0, PREVIEW));
          sources = fulls.map((f) => ({ name: f.name, tags: f.tags, importedAt: f.importedAt }));
        }
      } catch (e) {
        fail(e);
        onclose();
      } finally {
        loaded = true;
        // The name is ready: select it all (the extension is shown outside the field, so it stays put).
        queueMicrotask(() => nameEl?.select());
      }
    })();
  });

  const badRegex = $derived(regex && find ? regexError(find) : null);
  const preview = $derived(
    renamePreview(sources, template, {
      start: normalizeStart(start),
      find,
      replace,
      regex,
      total: ids.length,
    }),
  );
  const clean = $derived(name.trim());
  const canApply = $derived(
    !busy &&
      loaded &&
      !library.readOnly &&
      (single ? clean !== '' : !badRegex && preview.every((p) => p !== '')),
  );

  async function apply() {
    if (!canApply || !canEdit()) return;
    if (single) {
      if (clean === original) return onclose();
      busy = true;
      const res = await editItems(ids, { name: clean }, { done: `Renamed to ${clean}` });
      busy = false;
      if (res) onclose();
      return;
    }
    if (!(await confirmBulk(ids.length, { what: `rename ${plural(ids.length, 'item')}` }))) return;
    busy = true;
    const res = await mutate(
      () =>
        api.renameItems(ids, template || '*', {
          start: normalizeStart(start),
          ...(find ? { find, replace, regex } : {}),
        }),
      `Renamed ${plural(ids.length, 'item')}`,
    );
    busy = false;
    if (res) onclose();
  }

  function insert(token: string) {
    const el = tplEl;
    if (!el) return;
    const s = el.selectionStart ?? template.length;
    const e = el.selectionEnd ?? s;
    template = template.slice(0, s) + token + template.slice(e);
    queueMicrotask(() => {
      el.focus();
      el.setSelectionRange(s + token.length, s + token.length);
    });
  }

  const onEnter = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void apply();
    }
  };

  const TOKENS = [
    ['*', 'Original name'],
    ['%N', 'Number'],
    ['%D', 'Date added'],
    ['%T', 'Tags'],
  ] as const;
</script>

<Modal {onclose} label={single ? 'Rename item' : 'Rename items'} width={single ? 480 : 600}>
  <div class="head"><h2>{single ? 'Rename' : `Rename ${plural(ids.length, 'item')}`}</h2></div>
  {#if library.readOnly}<p class="ro">{readOnlyTip()}</p>{/if}

  {#if single}
    <div class="body">
      <div class="namerow">
        <input
          data-autofocus
          bind:this={nameEl}
          aria-label="Name"
          bind:value={name}
          onkeydown={onEnter}
          spellcheck="false"
          autocomplete="off"
        />
        {#if ext}<span class="ext">.{ext}</span>{/if}
      </div>
    </div>
  {:else}
    <div class="body">
      <label class="f" for="rn-tpl">New name</label>
      <input
        id="rn-tpl"
        class="inp"
        data-autofocus
        bind:this={tplEl}
        bind:value={template}
        onkeydown={onEnter}
        spellcheck="false"
        autocomplete="off"
      />
      <div class="toks">
        {#each TOKENS as [tok, label] (tok)}
          <button class="tok" title={label} onclick={() => insert(tok)}
            ><code>{tok}</code>{label}</button
          >
        {/each}
      </div>

      <div class="cols">
        <div>
          <label class="f" for="rn-start">Start number</label>
          <input
            id="rn-start"
            class="inp"
            type="number"
            min="0"
            bind:value={start}
            onkeydown={onEnter}
          />
        </div>
        <div>
          <label class="f" for="rn-find">Find</label>
          <input
            id="rn-find"
            class="inp"
            class:bad={badRegex}
            bind:value={find}
            onkeydown={onEnter}
            spellcheck="false"
            autocomplete="off"
          />
        </div>
        <div>
          <label class="f" for="rn-rep">Replace with</label>
          <input
            id="rn-rep"
            class="inp"
            bind:value={replace}
            onkeydown={onEnter}
            spellcheck="false"
            autocomplete="off"
          />
        </div>
      </div>
      <label class="rx"
        ><input type="checkbox" bind:checked={regex} /> Find is a regular expression</label
      >
      {#if badRegex}<p class="err">Not a valid pattern: {badRegex}</p>{/if}

      <p class="f pv">Preview</p>
      <div class="table" role="table" aria-label="Preview of the new names">
        {#each sources as s, i (i)}
          <div class="tr" role="row">
            <span class="o" role="cell">{s.name}</span>
            <span class="arrow" aria-hidden="true">→</span>
            <span class="n" class:empty={preview[i] === ''} role="cell"
              >{preview[i] === '' ? '(empty name)' : preview[i]}</span
            >
          </div>
        {:else}
          <p class="hint">{loaded ? 'Nothing to preview.' : 'Loading…'}</p>
        {/each}
        {#if ids.length > PREVIEW}<p class="hint">
            and {(ids.length - PREVIEW).toLocaleString()} more
          </p>{/if}
      </div>
    </div>
  {/if}

  <div class="foot">
    <span class="k">Enter to rename, Esc to cancel</span>
    <button class="btn" onclick={onclose}>Cancel</button>
    <button class="btn pri" disabled={!canApply} onclick={apply}
      >{single ? 'Rename' : `Rename ${plural(ids.length, 'item')}`}</button
    >
  </div>
</Modal>

<style>
  .head {
    padding: 16px 18px 4px;
  }
  h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }
  .body {
    padding: 10px 18px 6px;
    overflow: auto;
    min-height: 0;
  }
  .namerow {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .namerow input,
  .inp {
    height: 34px;
    min-width: 0;
    width: 100%;
    padding: 0 10px;
    border-radius: 7px;
    background: var(--fld);
    border: 1px solid var(--chip-line);
    outline: none;
    font-size: 13.5px;
  }
  .namerow input:focus,
  .inp:focus {
    border-color: var(--bl);
  }
  .inp.bad {
    border-color: var(--err);
  }
  .ext {
    color: var(--fa);
    font-size: 13.5px;
  }
  .f {
    display: block;
    margin: 12px 0 5px;
    font-size: 11.5px;
    font-weight: 600;
    color: var(--fa);
  }
  .f:first-child {
    margin-top: 2px;
  }
  .toks {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }
  .tok {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 26px;
    padding: 0 10px 0 6px;
    border-radius: 6px;
    background: var(--chip);
    border: 1px solid var(--chip-line);
    font-size: 12px;
    color: var(--mu);
  }
  .tok:hover {
    color: var(--tx);
    border-color: var(--mu);
  }
  .tok code {
    font: 600 11.5px var(--mono);
    color: var(--link);
    min-width: 18px;
    text-align: center;
  }
  .cols {
    display: grid;
    grid-template-columns: 110px 1fr 1fr;
    gap: 10px;
  }
  .rx {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
    font-size: 12px;
    color: var(--mu);
  }
  .err {
    margin: 6px 0 0;
    font-size: 11.5px;
    color: var(--err);
  }
  .pv {
    margin-top: 16px;
  }
  .table {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 4px 0;
    background: var(--fld);
  }
  .tr {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 20px minmax(0, 1fr);
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 12px;
    font-size: 12.5px;
  }
  .tr .o {
    color: var(--fa);
  }
  .tr .arrow {
    color: var(--fa);
    text-align: center;
  }
  .tr span:not(.arrow) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tr .empty {
    color: var(--err);
  }
  .hint {
    margin: 4px 12px;
    font-size: 11.5px;
    color: var(--fa);
  }
  .ro {
    margin: 6px 18px 0;
    font-size: 12px;
    color: var(--warn);
  }
  .foot {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 18px;
    border-top: 1px solid var(--line);
    flex: none;
  }
  .k {
    margin-right: auto;
    font-size: 11.5px;
    color: var(--fa);
  }
  .btn {
    height: 30px;
    padding: 0 14px;
    border-radius: 7px;
    background: var(--chip);
    font-size: 12.5px;
  }
  .btn:hover:not(:disabled) {
    background: var(--chip-line);
  }
  .btn.pri {
    background: var(--bl);
    color: var(--tx);
    font-weight: 500;
  }
  .btn.pri:hover:not(:disabled) {
    background: var(--bl-soft);
  }
  .btn:disabled {
    opacity: 0.45;
  }
  button:focus-visible {
    outline: 2px solid var(--bl);
    outline-offset: 1px;
  }
</style>
