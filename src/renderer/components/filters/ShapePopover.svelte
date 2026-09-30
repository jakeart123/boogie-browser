<script lang="ts">
  import { untrack } from 'svelte';
  import { view } from '../../lib/stores/view.svelte';
  import type { Shape } from '../../../shared/types';
  import { SHAPE_LABELS } from './chips';
  import Popover from './Popover.svelte';

  // Glyph sizes (w x h px) that hint at each shape.
  const SHAPES: { id: Shape; w: number; h: number }[] = [
    { id: 'square', w: 14, h: 14 },
    { id: 'portrait', w: 11, h: 16 },
    { id: 'panoramic-portrait', w: 7, h: 18 },
    { id: 'landscape', w: 16, h: 11 },
    { id: 'panoramic-landscape', w: 20, h: 7 },
  ];
  const PRESETS: [number, number][] = [
    [1, 1],
    [4, 3],
    [3, 2],
    [16, 9],
    [9, 16],
  ];

  const shapes = $derived(view.filter.shapes ?? []);
  const aspect = $derived(view.filter.aspect);
  const isPreset = (w: number, h: number) => !!aspect && aspect.w * h === aspect.h * w;
  // A ratio that isn't one of the presets starts in the custom boxes.
  const start = untrack(() => view.filter.aspect);
  const custom = !!start && !PRESETS.some(([w, h]) => start.w * h === start.h * w);
  let cw = $state(custom ? String(start!.w) : '');
  let ch = $state(custom ? String(start!.h) : '');

  function toggleShape(s: Shape) {
    const next = shapes.includes(s) ? shapes.filter((x) => x !== s) : [...shapes, s];
    view.setFilter({ shapes: next.length ? next : undefined });
  }

  function setAspect(w: number, h: number) {
    if (isPreset(w, h)) view.setFilter({ aspect: undefined });
    else view.setFilter({ aspect: { w, h } });
    cw = ch = '';
  }

  function applyCustom() {
    const w = parseFloat(cw);
    const h = parseFloat(ch);
    if (w > 0 && h > 0) view.setFilter({ aspect: { w, h } });
    else if (!cw && !ch) view.setFilter({ aspect: undefined });
  }
</script>

<Popover
  kind="shape"
  title="Filter by shape"
  onclear={shapes.length || aspect
    ? () => ((cw = ch = ''), view.setFilter({ shapes: undefined, aspect: undefined }))
    : undefined}
>
  <p class="sub">Shape</p>
  <div class="grid">
    {#each SHAPES as s, i (s.id)}
      <button
        class="tog"
        data-autofocus={i === 0 ? '' : undefined}
        aria-pressed={shapes.includes(s.id)}
        onclick={() => toggleShape(s.id)}
      >
        <span class="glyph" style="width:{s.w}px;height:{s.h}px"></span>{SHAPE_LABELS[s.id]}
      </button>
    {/each}
  </div>

  <p class="sub">Aspect ratio</p>
  <div class="grid">
    {#each PRESETS as [w, h] (`${w}:${h}`)}
      <button class="tog" aria-pressed={isPreset(w, h)} onclick={() => setAspect(w, h)}
        >{w}:{h}</button
      >
    {/each}
  </div>
  <div class="pair custom">
    <input
      class="inp"
      type="number"
      min="0"
      step="any"
      placeholder="Width"
      aria-label="Custom ratio width"
      bind:value={cw}
      oninput={applyCustom}
    />
    <span>:</span>
    <input
      class="inp"
      type="number"
      min="0"
      step="any"
      placeholder="Height"
      aria-label="Custom ratio height"
      bind:value={ch}
      oninput={applyCustom}
    />
  </div>
</Popover>

<style>
  .glyph {
    display: inline-block;
    border: 1.5px solid currentColor;
    border-radius: 2px;
    flex: none;
  }
  .tog {
    min-width: 0;
  }
  .custom {
    margin-top: 8px;
  }
</style>
