<script lang="ts">
  import { view } from '../../lib/stores/view.svelte';
  import type { FilterSpec, RangeFilter } from '../../../shared/types';
  import {
    DATE_PRESETS,
    endOfDay,
    matchPreset,
    presetRange,
    startOfDay,
    type DateField,
  } from './chips';
  import { filterUi } from './filterUi.svelte';
  import Popover from './Popover.svelte';

  let field = $state<DateField>(filterUi.open?.field ?? 'importedAt');
  const range = $derived(view.filter[field]);
  const now = Date.now();
  const active = $derived(range ? matchPreset(range, now)?.id : undefined);

  const p2 = (n: number) => String(n).padStart(2, '0');
  const toInput = (ms?: number) => {
    if (ms === undefined) return '';
    const d = new Date(ms);
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  };
  const fromInput = (v: string, end: boolean): number | undefined => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (!m) return undefined;
    const t = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    return end ? endOfDay(t) : startOfDay(t);
  };

  function set(next: RangeFilter | undefined) {
    const empty = !next || (next.min === undefined && next.max === undefined);
    view.setFilter({ [field]: empty ? undefined : next } as Partial<FilterSpec>);
  }

  function toggleField(f: DateField) {
    field = f;
  }

  function custom(which: 'min' | 'max', v: string) {
    const next: RangeFilter = { ...(range ?? {}) };
    const ms = fromInput(v, which === 'max');
    if (ms === undefined) delete next[which];
    else next[which] = ms;
    set(next);
  }
</script>

<Popover kind="date" title="Filter by date" onclear={range ? () => set(undefined) : undefined}>
  <div class="seg" role="group" aria-label="Which date">
    <button aria-pressed={field === 'importedAt'} onclick={() => toggleField('importedAt')}
      >Imported</button
    >
    <button aria-pressed={field === 'modifiedAt'} onclick={() => toggleField('modifiedAt')}
      >Modified</button
    >
  </div>
  <div class="grid presets">
    {#each DATE_PRESETS as p, i (p.id)}
      <button
        class="tog"
        data-autofocus={i === 0 ? '' : undefined}
        aria-pressed={active === p.id}
        onclick={() => set(active === p.id ? undefined : presetRange(p.id, now))}
      >
        {p.label}
      </button>
    {/each}
  </div>
  <p class="sub">Custom range</p>
  <div class="lab">
    <label for="d-from">From</label><input
      id="d-from"
      class="inp"
      type="date"
      value={toInput(range?.min)}
      onchange={(e) => custom('min', e.currentTarget.value)}
    />
  </div>
  <div class="lab">
    <label for="d-to">To</label><input
      id="d-to"
      class="inp"
      type="date"
      value={toInput(range?.max)}
      onchange={(e) => custom('max', e.currentTarget.value)}
    />
  </div>
</Popover>

<style>
  .presets {
    margin-top: 10px;
  }
  .inp {
    color-scheme: dark;
  }
</style>
