<script lang="ts">
  // Search by color: pick a swatch or type a hex, choose how strict the match is and how much of
  // the image the color must cover. Applies live.
  import { view } from '../../lib/stores/view.svelte';
  import { COLOR_PRESETS, hexToRgb, rgbToHex, type RGB } from './colors';
  import Popover from './Popover.svelte';

  const cur = $derived(view.filter.color);
  let tolerance = $state<'similar' | 'close'>(view.filter.color?.tolerance ?? 'similar');
  let minRatio = $state(view.filter.color?.minRatio ?? 0);
  let hex = $state(view.filter.color ? rgbToHex(view.filter.color.rgb) : '');
  const parsed = $derived(hexToRgb(hex));

  function apply(rgb: RGB) {
    view.setFilter({ color: { rgb, tolerance, ...(minRatio > 0 ? { minRatio } : {}) } });
  }

  function pick(hexValue: string) {
    hex = hexValue;
    apply(hexToRgb(hexValue)!);
  }

  function setTolerance(t: 'similar' | 'close') {
    tolerance = t;
    if (cur) apply(cur.rgb);
  }

  function setCoverage(v: number) {
    minRatio = v;
    if (cur) apply(cur.rgb);
  }

  const currentHex = $derived(cur ? rgbToHex(cur.rgb) : '');
</script>

<Popover
  kind="color"
  title="Search by color"
  onclear={cur ? () => ((hex = ''), view.setFilter({ color: undefined })) : undefined}
>
  <div class="sw" role="group" aria-label="Preset colors">
    {#each COLOR_PRESETS as p (p.hex)}
      <button
        class="s"
        class:on={p.hex === currentHex}
        style="background:{p.hex}"
        title={p.name}
        aria-label={p.name}
        aria-pressed={p.hex === currentHex}
        onclick={() => pick(p.hex)}
      ></button>
    {/each}
  </div>

  <p class="sub">Hex</p>
  <div class="hexrow">
    <span class="prev" style={parsed ? `background:${rgbToHex(parsed)}` : ''}></span>
    <input
      class="inp"
      data-autofocus
      placeholder="#3a1a0d"
      aria-label="Hex color"
      bind:value={hex}
      oninput={() => parsed && apply(parsed)}
      onkeydown={(e) => e.key === 'Enter' && parsed && apply(parsed)}
    />
  </div>

  <p class="sub">Match</p>
  <div class="seg" role="group" aria-label="How close">
    <button aria-pressed={tolerance === 'similar'} onclick={() => setTolerance('similar')}
      >Similar</button
    >
    <button aria-pressed={tolerance === 'close'} onclick={() => setTolerance('close')}>Close</button
    >
  </div>

  <p class="sub">Minimum coverage <b>{minRatio ? `${minRatio}%+ of image` : 'any amount'}</b></p>
  <input
    class="range"
    type="range"
    min="0"
    max="100"
    step="5"
    aria-label="Minimum coverage"
    value={minRatio}
    oninput={(e) => setCoverage(+e.currentTarget.value)}
  />
</Popover>

<style>
  .sw {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 8px;
  }
  .s {
    aspect-ratio: 1;
    border-radius: 7px;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.14);
  }
  .s:hover {
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.14),
      0 0 0 2px var(--panel-line);
  }
  .s.on {
    box-shadow:
      0 0 0 2px var(--panel),
      0 0 0 4px var(--tx);
  }
  .hexrow {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .prev {
    width: 30px;
    height: 30px;
    flex: none;
    border-radius: 6px;
    background: var(--fld);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.14);
  }
  .sub b {
    float: right;
    font-weight: 500;
    letter-spacing: 0;
    text-transform: none;
    color: var(--mu);
  }
  .range {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 3px;
    border-radius: 3px;
    background: var(--chip-line);
    outline: 0;
    margin: 8px 0 4px;
  }
  .range::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--tx);
    border: 0;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
  }
  .range:focus-visible {
    outline: 2px solid var(--bl);
    outline-offset: 4px;
  }
</style>
