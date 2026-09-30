<script lang="ts">
  // Slideshow: full screen, black, one item at a time, advancing on a timer. Space pauses,
  // arrows step, + and - change the pace, Esc leaves (commands.ts has the keys).
  // Full screen uses the browser's own API rather than api.windowControl('fullscreen'): that one
  // is a blind toggle, and this one can say whether we are in full screen and when Esc left it.
  import { onMount } from 'svelte';
  import { items } from '../../lib/stores/items.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import ItemView from './ItemView.svelte';
  import { viewKind } from '../../lib/fileKinds';
  import { currentId, goTo } from './nav';
  import { viewer } from './state.svelte';
  import { useItem } from './useItem.svelte';

  const id = $derived(currentId());
  const cur = useItem(() => id);
  const item = $derived(cur.value);
  const index = $derived(ui.viewer?.index ?? 0);
  const total = $derived(ui.viewer?.ids.length ?? 0);
  const name = $derived(item?.name ?? (id ? items.brief(id)?.name : '') ?? '');
  // Video and audio play through; pictures wait out the interval.
  // (A video that can't play reports itself finished after a few seconds, see VideoPlayer.)
  const timed = $derived(!!item && !['video', 'audio'].includes(viewKind(item.ext)));

  let hud = $state(true);
  let hudTimer: ReturnType<typeof setTimeout> | undefined;
  function wake() {
    hud = true;
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => (hud = false), 2500);
  }

  function advance() {
    if (total < 2) return;
    goTo(index + 1 >= total ? 0 : index + 1);
  }

  $effect(() => {
    if (!timed || viewer.paused || total < 2) return;
    const t = setTimeout(advance, viewer.interval * 1000);
    return () => clearTimeout(t);
  });

  // A pause, a pace change or a step should show what happened.
  $effect(() => {
    void viewer.paused;
    void viewer.interval;
    void id;
    wake();
  });

  let host = $state<HTMLDivElement>();

  onMount(() => {
    const el = host;
    viewer.paused = false;
    // If the browser says no, the black overlay still covers the window.
    void el?.requestFullscreen?.().catch(() => {});
    // Esc (or anything else that leaves full screen) ends the slideshow too.
    const left = () => {
      if (!document.fullscreenElement) ui.viewer = null;
    };
    document.addEventListener('fullscreenchange', left);
    return () => {
      document.removeEventListener('fullscreenchange', left);
      clearTimeout(hudTimer);
      if (el && document.fullscreenElement === el) void document.exitFullscreen().catch(() => {});
    };
  });
</script>

<div
  class="present"
  class:idle={!hud}
  bind:this={host}
  role="dialog"
  tabindex="-1"
  aria-label="Slideshow"
  onpointermove={wake}
>
  {#key id}
    {#if item}<ItemView {item} variant="present" onended={advance} />{/if}
  {/key}

  {#if timed && !viewer.paused && total > 1}
    {#key `${id}|${viewer.interval}`}<div
        class="prog"
        style="animation-duration:{viewer.interval}s"
      ></div>{/key}
  {/if}

  <div class="hud" class:show={hud}>
    <span class="n">{name}</span>
    <span class="c">{index + 1} / {total.toLocaleString()}</span>
    <span class="s">{viewer.paused ? 'Paused' : `Every ${viewer.interval} s`}</span>
    <span class="h">Space pause · arrows step · + and - pace · Esc exit</span>
  </div>
</div>

<style>
  .present {
    position: fixed;
    inset: 0;
    z-index: 70;
    /* Slideshow black, everything inside that follows --thumb-bg goes black too. */
    --thumb-bg: #000;
    background: #000;
    animation: fade 150ms ease-out;
  }
  .present.idle {
    cursor: none;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  .prog {
    position: absolute;
    left: 0;
    bottom: 0;
    height: 2px;
    width: 100%;
    background: var(--fa);
    opacity: 0.6;
    transform-origin: left;
    animation-name: run;
    animation-timing-function: linear;
    animation-fill-mode: forwards;
    pointer-events: none;
  }
  @keyframes run {
    from {
      transform: scaleX(0);
    }
    to {
      transform: scaleX(1);
    }
  }
  .hud {
    position: absolute;
    left: 50%;
    bottom: 22px;
    transform: translateX(-50%);
    display: flex;
    align-items: baseline;
    gap: 14px;
    max-width: 90vw;
    padding: 8px 16px;
    border-radius: 999px;
    background: rgba(20, 21, 24, 0.82);
    color: var(--tx);
    font-size: 12.5px;
    white-space: nowrap;
    opacity: 0;
    transition: opacity 200ms ease-out;
    pointer-events: none;
  }
  .hud.show {
    opacity: 1;
  }
  .n {
    max-width: 38vw;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .c,
  .s {
    color: var(--mu);
    font-variant-numeric: tabular-nums;
  }
  .h {
    color: var(--fa);
    font-size: 11.5px;
  }
</style>
