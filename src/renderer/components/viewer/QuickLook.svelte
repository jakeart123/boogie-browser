<script lang="ts">
  // Space-bar quick look: a centered panel over a dimmed window. Arrows step, Space or Esc
  // closes, Enter opens the detail view (commands.ts has the keys).
  import { items } from '../../lib/stores/items.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import ItemView from './ItemView.svelte';
  import { openItemMenu } from './menu';
  import { currentId } from './nav';
  import { useItem } from './useItem.svelte';

  const id = $derived(currentId());
  const cur = useItem(() => id);
  const item = $derived(cur.value);
  const name = $derived(item?.name ?? (id ? items.brief(id)?.name : '') ?? '');
  const dims = $derived(item?.width && item.height ? `${item.width} × ${item.height}` : '');
</script>

<div class="ql" role="dialog" aria-label="Quick look">
  <button
    type="button"
    class="scrim"
    aria-label="Close quick look"
    tabindex="-1"
    onclick={() => (ui.viewer = null)}
  ></button>
  <div class="panel">
    <div class="body" role="presentation" oncontextmenu={(e) => id && openItemMenu(e, id)}>
      {#key id}
        {#if item}<ItemView {item} variant="quicklook" />{:else if item === null}<p class="gone">
            This item isn’t available any more.
          </p>{/if}
      {/key}
    </div>
    <div class="cap" title={name}>
      <span class="n">{name}</span>
      {#if dims}<span class="d">{dims}</span>{/if}
    </div>
  </div>
</div>

<style>
  .ql {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: grid;
    place-items: center;
    animation: fade 120ms ease-out;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  .scrim {
    position: absolute;
    inset: 0;
    background: rgba(8, 9, 10, 0.72);
    cursor: default;
  }
  .panel {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 85vw;
    height: 85vh;
    border-radius: var(--radius-lg);
    background: var(--thumb-bg);
    border: 1px solid var(--panel-line);
    box-shadow: var(--shadow-pop);
    overflow: hidden;
  }
  .body {
    flex: 1;
    min-height: 0;
  }
  .cap {
    flex: none;
    display: flex;
    align-items: baseline;
    justify-content: center;
    gap: 10px;
    padding: 8px 16px 10px;
    border-top: 1px solid var(--line);
    background: var(--bg);
    font-size: 12.5px;
  }
  .n {
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .d {
    color: var(--fa);
    font-variant-numeric: tabular-nums;
  }
  .gone {
    display: grid;
    place-items: center;
    height: 100%;
    margin: 0;
    color: var(--fa);
  }
</style>
