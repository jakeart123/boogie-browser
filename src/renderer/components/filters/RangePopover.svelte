<script lang="ts">
  // Min/max number filters: file size (MB), dimensions (px) and duration (seconds).
  import { untrack } from 'svelte';
  import { view } from '../../lib/stores/view.svelte';
  import type { FilterSpec, RangeFilter } from '../../../shared/types';
  import Popover from './Popover.svelte';

  let { kind }: { kind: 'size' | 'dimensions' | 'duration' } = $props();

  interface Field {
    key: 'fileSize' | 'width' | 'height' | 'duration';
    label: string;
    unit: string;
    /** Stored value = shown value * scale (the size filter stores bytes, shows MB). */
    scale: number;
  }
  const CONFIG: Record<'size' | 'dimensions' | 'duration', { title: string; fields: Field[] }> = {
    size: {
      title: 'Filter by file size',
      fields: [{ key: 'fileSize', label: 'Size', unit: 'MB', scale: 1024 * 1024 }],
    },
    dimensions: {
      title: 'Filter by dimensions',
      fields: [
        { key: 'width', label: 'Width', unit: 'px', scale: 1 },
        { key: 'height', label: 'Height', unit: 'px', scale: 1 },
      ],
    },
    duration: {
      title: 'Filter by duration',
      fields: [{ key: 'duration', label: 'Length', unit: 'seconds', scale: 1 }],
    },
  };

  // Each popover is mounted fresh for its kind ({#key} in FilterBar), so `kind` never changes here.
  const cfg = untrack(() => CONFIG[kind]);
  const show = (v: number | undefined, scale: number) =>
    v === undefined ? '' : String(+(v / scale).toFixed(2));
  // Local text so typing "0." isn't rewritten under your fingers; the filter is the output only.
  const text = $state(
    Object.fromEntries(
      cfg.fields.map((f) => [
        f.key,
        {
          min: show(view.filter[f.key]?.min, f.scale),
          max: show(view.filter[f.key]?.max, f.scale),
        },
      ]),
    ),
  );
  const active = $derived(cfg.fields.some((f) => view.filter[f.key]));

  function push(f: Field) {
    const r: RangeFilter = {};
    const min = parseFloat(text[f.key].min);
    const max = parseFloat(text[f.key].max);
    if (Number.isFinite(min)) r.min = min * f.scale;
    if (Number.isFinite(max)) r.max = max * f.scale;
    view.setFilter({
      [f.key]: r.min === undefined && r.max === undefined ? undefined : r,
    } as Partial<FilterSpec>);
  }

  function clear() {
    for (const f of cfg.fields) text[f.key] = { min: '', max: '' };
    view.setFilter(
      Object.fromEntries(cfg.fields.map((f) => [f.key, undefined])) as Partial<FilterSpec>,
    );
  }
</script>

<Popover {kind} title={cfg.title} onclear={active ? clear : undefined}>
  {#each cfg.fields as f, i (f.key)}
    <p class="sub">{f.label} ({f.unit})</p>
    <div class="pair">
      <input
        class="inp"
        type="number"
        min="0"
        step="any"
        placeholder="Min"
        aria-label="{f.label} minimum"
        data-autofocus={i === 0 ? '' : undefined}
        bind:value={text[f.key].min}
        oninput={() => push(f)}
      />
      <span>to</span>
      <input
        class="inp"
        type="number"
        min="0"
        step="any"
        placeholder="Max"
        aria-label="{f.label} maximum"
        bind:value={text[f.key].max}
        oninput={() => push(f)}
      />
    </div>
  {/each}
  <p class="hint">Leave one side empty for no limit.</p>
</Popover>
