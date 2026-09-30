<script lang="ts">
  // The key legend along the bottom: what every number and letter does in this queue, with item
  // counts. A key lights up when the item on screen already has its folder or tag. Clicking a key
  // presses it; in "Edit keys" a press or click picks what the key does.
  import X from '@lucide/svelte/icons/x';
  import { library } from '../../lib/stores/library.svelte';
  import type { TriageSession } from '../../lib/stores/triage.svelte';
  import type { Item } from '../../../shared/types';
  import * as act from './actions';
  import { FILE_KEYS, TAG_KEYS } from '../../lib/triageKeys';

  let { session: s, item }: { session: TriageSession; item: Item | null | undefined } = $props();

  const moving = $derived(s.scope.kind === 'folder');
  const tagCount = $derived(new Map(library.tags.map((t) => [t.name, t.count])));

  const folderKeys = $derived(
    FILE_KEYS.map((k, slot) => {
      const id = s.keys.folders[slot];
      const f = id ? library.folder(id) : undefined;
      return {
        k,
        slot,
        name: f?.node.name ?? '',
        count: id ? library.counts?.folders[id]?.own : undefined,
        on: !!id && !!item?.folders.includes(id),
      };
    }),
  );
  const tagKeys = $derived(
    TAG_KEYS.map((k, slot) => {
      const t = s.keys.tags[slot];
      return {
        k,
        slot,
        name: t ?? '',
        count: t ? tagCount.get(t) : undefined,
        on: !!t && !!item?.tags.includes(t),
        same: !!t && !!s.sameClue[t],
      };
    }),
  );
</script>

<footer class="keys" class:editing={s.editing}>
  <div class="kh">
    {#if s.editing}
      <span
        ><b>Editing keys.</b> Press or click a key to choose its folder or tag. Esc when done.</span
      >
    {:else}
      <span
        ><b>Your keys.</b> A number {moving ? 'moves the item there' : 'files the item'} and goes on,
        a letter adds a tag (again takes it off), Shift+1 to 5 rates. Shift+letter tags every queued item
        with the same note.</span
      >
    {/if}
    <span
      >Keys are set per queue ·
      <button type="button" class="ek" onclick={() => (s.editing = !s.editing)}
        >{s.editing ? 'Done editing' : 'Edit keys'}</button
      ></span
    >
  </div>

  <div class="krl">{moving ? 'Move to' : 'File to'}<span>number keys</span></div>
  <div class="krow f">
    {#each folderKeys as key (key.k)}
      <div class="kwrap">
        <button
          type="button"
          class="key"
          class:on={key.on}
          class:unset={!key.name}
          title={key.name
            ? `${key.k}: ${key.name}`
            : `${key.k}: not set yet (press it to choose a folder)`}
          onclick={() => void act.fileKey(key.slot)}
        >
          <span class="lg">{key.k}</span>
          {#if key.count !== undefined}<span class="ct">{key.count.toLocaleString()}</span>{/if}
          <span class="nm">{key.name || 'Choose…'}</span>
        </button>
        {#if s.editing && key.name}<button
            type="button"
            class="clr"
            aria-label="Clear key {key.k}"
            title="Clear key {key.k}"
            onclick={() => act.assignKey('folder', key.slot, null)}><X size={12} /></button
          >{/if}
      </div>
    {/each}
    <button
      type="button"
      class="key dim"
      title="0: another folder, just this once"
      onclick={act.fileElsewhere}
    >
      <span class="lg">0</span><span class="nm">Other folder…</span>
    </button>
  </div>

  <div class="spec">
    <button type="button" class="key dim w" onclick={() => void act.skip()}
      ><span class="lg">S · Space</span><span class="nm">Skip for now</span></button
    >
    <button type="button" class="key dim" onclick={() => void act.undoLast()}
      ><span class="lg">U</span><span class="nm">Undo</span></button
    >
    <button type="button" class="key dim" onclick={() => void act.trash()}
      ><span class="lg">X · Del</span><span class="nm">Trash</span></button
    >
    <button type="button" class="key dim" onclick={() => void act.done()}
      ><span class="lg">Enter</span><span class="nm">Done, next</span></button
    >
  </div>

  <div class="krl">Tag with<span>letter keys</span></div>
  <div class="krow t">
    {#each tagKeys as key (key.k)}
      <div class="kwrap">
        <button
          type="button"
          class="key"
          class:on={key.on}
          class:sug={key.same && !key.on}
          class:unset={!key.name}
          title={key.name
            ? `${key.k}: ${key.name}`
            : `${key.k}: not set yet (press it to choose a tag)`}
          onclick={() => void act.tagKey(key.slot)}
        >
          <span class="lg">{key.k}</span>
          {#if key.count !== undefined}<span class="ct">{key.count.toLocaleString()}</span>{/if}
          <span class="nm">{key.name || 'Choose…'}</span>
        </button>
        {#if s.editing && key.name}<button
            type="button"
            class="clr"
            aria-label="Clear key {key.k}"
            title="Clear key {key.k}"
            onclick={() => act.assignKey('tag', key.slot, null)}><X size={12} /></button
          >{/if}
      </div>
    {/each}
  </div>
</footer>

<style>
  .keys {
    grid-area: keys;
    display: grid;
    grid-template-columns: 92px minmax(0, 1fr) 272px;
    grid-template-rows: auto auto auto;
    gap: 8px 14px;
    padding: 10px 18px 14px;
    background: var(--strip);
    border-top: 1px solid var(--line);
  }
  .kh {
    grid-column: 1 / -1;
    display: flex;
    justify-content: space-between;
    gap: 16px;
    font-size: 11.5px;
    color: var(--fa);
  }
  .kh b {
    color: var(--mu);
    font-weight: 500;
  }
  .kh > span:last-child {
    flex: none;
  }
  .ek {
    color: var(--link);
    font-size: 11.5px;
  }
  .ek:hover {
    text-decoration: underline;
  }
  .krl {
    display: flex;
    flex-direction: column;
    justify-content: center;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--mu);
    line-height: 1.35;
  }
  .krl span {
    font-size: 11px;
    font-weight: 400;
    letter-spacing: 0;
    text-transform: none;
    color: var(--fa);
  }
  .krow {
    display: grid;
    grid-template-columns: repeat(10, minmax(0, 1fr));
    gap: 6px;
  }
  .krow.t {
    grid-template-columns: repeat(8, minmax(0, 1fr));
  }
  .kwrap {
    position: relative;
    min-width: 0;
  }
  .key {
    position: relative;
    width: 100%;
    height: 50px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    min-width: 0;
    padding: 6px 8px;
    border-radius: 7px;
    background: var(--chip);
    border: 1px solid var(--chip-line);
    box-shadow: 0 2px 0 var(--line);
    color: var(--tx);
    text-align: left;
    transition: transform 80ms ease-out;
  }
  .key:hover {
    background: var(--hov);
  }
  .key:active {
    transform: translateY(1px);
    box-shadow: none;
  }
  .lg {
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
  }
  .ct {
    position: absolute;
    top: 6px;
    right: 8px;
    font-family: var(--mono);
    font-size: 10px;
    color: var(--fa);
  }
  .nm {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    font-weight: 500;
  }
  .key.unset .nm {
    color: var(--fa);
    font-weight: 400;
  }
  .key.on {
    background: var(--bls);
    border-color: var(--bl);
  }
  .key.on .nm {
    color: var(--bl-soft);
  }
  .key.sug {
    border-color: var(--bl);
  }
  .key.dim {
    background: var(--panel);
    border-color: var(--panel-line);
    color: var(--mu);
  }
  .editing .key:not(.dim) {
    border-style: dashed;
  }
  .clr {
    position: absolute;
    top: -6px;
    right: -6px;
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--panel);
    border: 1px solid var(--panel-line);
    color: var(--mu);
  }
  .clr:hover {
    color: var(--tx);
  }
  .spec {
    grid-row: 2 / 4;
    grid-column: 3;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    grid-template-rows: 1fr 1fr;
    gap: 6px;
  }
  .spec .key {
    height: auto;
  }
  .spec .w {
    grid-column: span 3;
  }
  .key:focus-visible,
  .ek:focus-visible,
  .clr:focus-visible {
    outline: 2px solid var(--bl);
    outline-offset: 1px;
  }
</style>
