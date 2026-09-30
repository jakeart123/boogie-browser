<script lang="ts">
  // One rule in a smart folder: property, method, and whatever value controls that pair needs.
  import X from '@lucide/svelte/icons/x';
  import type { SmartRule } from '../../../shared/types';
  import FolderMulti from './FolderMulti.svelte';
  import {
    DURATION_UNITS,
    FILE_SIZE_UNITS,
    PROPERTIES,
    RATINGS,
    SHAPES,
    changeMethod,
    dateToInput,
    defaultRule,
    describeRule,
    inputToDate,
    methodsFor,
    propertyOf,
    ruleProblem,
    understood,
    withShape,
  } from './smart';
  import TagField from './TagField.svelte';

  let {
    rule = $bindable(),
    kept = false,
    tagNames,
    showErrors,
    ondelete,
    onedit,
    disabled = false,
  }: {
    rule: SmartRule;
    /** Made in Eagle and shown as it is (see smart.ts); `onedit` turns on the controls. */
    kept?: boolean;
    tagNames: string[];
    showErrors: boolean;
    ondelete: () => void;
    onedit?: () => void;
    disabled?: boolean;
  } = $props();

  const prop = $derived(propertyOf(rule.property));
  const kind = $derived(prop?.kind);
  const methods = $derived(methodsFor(rule.property));
  const problem = $derived(showErrors && !kept ? ruleProblem(rule) : null);
  const stars = $derived(typeof rule.value === 'string' ? rule.value : '');
  function toggleStar(n: string) {
    const set = new Set(stars.split('').filter((c) => /[1-5]/.test(c)));
    if (set.has(n)) set.delete(n);
    else set.add(n);
    rule.value = [...set].sort().reverse().join('');
  }
  const noValue = $derived(
    (kind === 'string' && (rule.method === 'empty' || rule.method === 'not-empty')) ||
      ((kind === 'tags' || kind === 'folders') &&
        (rule.method === 'empty' || rule.method === 'not-empty')) ||
      (kind === 'color' && rule.method === 'grayscale'),
  );

  const arr = $derived(Array.isArray(rule.value) ? (rule.value as unknown[]) : []);
  const num = (i: number): number | '' => {
    const v = arr[i];
    return typeof v === 'number' && Number.isFinite(v) ? v : '';
  };
  const strs = (): string[] =>
    Array.isArray(rule.value)
      ? (rule.value as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];

  function setNum(i: number, v: number) {
    const next = [...arr];
    while (next.length <= i) next.push(null);
    next[i] = Number.isFinite(v) ? v : null;
    rule.value = next;
  }
  function setDate(i: number, text: string) {
    const next = [...arr];
    while (next.length <= i) next.push(null);
    next[i] = inputToDate(text);
    rule.value = next;
  }
  const hexOf = (v: unknown) =>
    typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : '#0087EF';
</script>

<div class="rule" class:bad={!!problem}>
  {#if !prop || kept}
    <span class="odd">{describeRule(rule)}</span>
    <span class="dg-hint">Made in Eagle. Kept as it is.</span>
    {#if prop && understood(rule) && onedit && !disabled}<button
        type="button"
        class="dg-btn sm"
        onclick={onedit}>Edit</button
      >{/if}
  {:else}
    <select
      class="dg-select p"
      aria-label="Property"
      {disabled}
      value={rule.property}
      onchange={(e) => (rule = defaultRule(e.currentTarget.value))}
    >
      {#each PROPERTIES as p (p.id)}<option value={p.id}>{p.label}</option>{/each}
    </select>
    <select
      class="dg-select m"
      aria-label="Method"
      {disabled}
      value={rule.method}
      onchange={(e) => (rule = changeMethod(rule, e.currentTarget.value))}
    >
      {#each methods as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
    </select>

    {#if !noValue}
      {#if kind === 'string'}
        <input
          class="dg-input v"
          class:bad={!!problem}
          aria-label="Text to look for"
          placeholder={rule.method === 'regex' ? 'Pattern' : 'Text'}
          {disabled}
          value={typeof rule.value === 'string' ? rule.value : ''}
          oninput={(e) => (rule.value = e.currentTarget.value)}
        />
      {:else if kind === 'numeric'}
        <input
          class="dg-input num"
          class:bad={!!problem}
          type="number"
          aria-label="Number"
          {disabled}
          value={num(0)}
          oninput={(e) => setNum(0, e.currentTarget.valueAsNumber)}
        />
        {#if rule.method === 'between'}
          <span class="and">and</span>
          <input
            class="dg-input num"
            class:bad={!!problem}
            type="number"
            aria-label="Second number"
            {disabled}
            value={num(1)}
            oninput={(e) => setNum(1, e.currentTarget.valueAsNumber)}
          />
        {/if}
        {#if rule.property === 'fileSize'}
          <select
            class="dg-select u"
            aria-label="Unit"
            {disabled}
            value={rule.unit ?? 'mb'}
            onchange={(e) => (rule.unit = e.currentTarget.value)}
          >
            {#each FILE_SIZE_UNITS as u (u.id)}<option value={u.id}>{u.label}</option>{/each}
          </select>
        {:else if rule.property === 'duration'}
          <select
            class="dg-select u"
            aria-label="Unit"
            {disabled}
            value={rule.unit ?? 's'}
            onchange={(e) => (rule.unit = e.currentTarget.value)}
          >
            {#each DURATION_UNITS as u (u.id)}<option value={u.id}>{u.label}</option>{/each}
          </select>
        {:else}
          <span class="unit">pixels</span>
        {/if}
      {:else if kind === 'date'}
        {#if rule.method === 'within'}
          <input
            class="dg-input num"
            class:bad={!!problem}
            type="number"
            min="1"
            aria-label="Days"
            {disabled}
            value={num(0)}
            oninput={(e) => setNum(0, e.currentTarget.valueAsNumber)}
          />
          <span class="unit">days</span>
        {:else}
          <input
            class="dg-input d"
            class:bad={!!problem}
            type="date"
            aria-label="Date"
            {disabled}
            value={dateToInput(arr[0])}
            onchange={(e) => setDate(0, e.currentTarget.value)}
          />
          {#if rule.method === 'between'}
            <span class="and">and</span>
            <input
              class="dg-input d"
              class:bad={!!problem}
              type="date"
              aria-label="Second date"
              {disabled}
              value={dateToInput(arr[1])}
              onchange={(e) => setDate(1, e.currentTarget.value)}
            />
          {/if}
        {/if}
      {:else if kind === 'tags'}
        <div class="grow">
          <TagField
            bind:tags={() => strs(), (v) => (rule.value = v)}
            suggestions={tagNames}
            {disabled}
            label="Tags"
            placeholder="Add a tag"
          />
        </div>
      {:else if kind === 'folders'}
        <FolderMulti bind:ids={() => strs(), (v) => (rule.value = v)} {disabled} />
      {:else if kind === 'type'}
        <input
          class="dg-input v"
          class:bad={!!problem}
          list="smart-types"
          aria-label="Type"
          placeholder="jpg, video, pdf…"
          {disabled}
          value={typeof rule.value === 'string' ? rule.value : ''}
          oninput={(e) => (rule.value = e.currentTarget.value.trim().toLowerCase())}
        />
      {:else if kind === 'rating' && rule.method === 'contain'}
        <div class="dg-seg stars" role="group" aria-label="Ratings">
          {#each ['5', '4', '3', '2', '1'] as n (n)}
            <button
              type="button"
              class:on={stars.includes(n)}
              aria-pressed={stars.includes(n)}
              {disabled}
              onclick={() => toggleStar(n)}>{n}★</button
            >
          {/each}
        </div>
      {:else if kind === 'rating'}
        <select
          class="dg-select v"
          aria-label="Rating"
          {disabled}
          value={String(rule.value ?? '')}
          onchange={(e) => (rule.value = e.currentTarget.value)}
        >
          {#each RATINGS as r (r.id)}<option value={r.id}>{r.label}</option>{/each}
        </select>
      {:else if kind === 'shape'}
        <select
          class="dg-select v"
          aria-label="Shape"
          {disabled}
          value={String(rule.value ?? '')}
          onchange={(e) => (rule = withShape(rule, e.currentTarget.value))}
        >
          {#each SHAPES as s (s.id)}<option value={s.id}>{s.label}</option>{/each}
        </select>
        {#if rule.value === 'custom'}
          <input
            class="dg-input num"
            class:bad={!!problem}
            type="number"
            min="1"
            aria-label="Width"
            {disabled}
            value={typeof rule.width === 'number' ? rule.width : ''}
            oninput={(e) => (rule.width = e.currentTarget.valueAsNumber)}
          />
          <span class="and">:</span>
          <input
            class="dg-input num"
            class:bad={!!problem}
            type="number"
            min="1"
            aria-label="Height"
            {disabled}
            value={typeof rule.height === 'number' ? rule.height : ''}
            oninput={(e) => (rule.height = e.currentTarget.valueAsNumber)}
          />
        {/if}
      {:else if kind === 'color'}
        <input
          class="swatch"
          type="color"
          aria-label="Color"
          {disabled}
          value={hexOf(rule.value).toLowerCase()}
          oninput={(e) => (rule.value = e.currentTarget.value.toUpperCase())}
        />
        <input
          class="dg-input hex"
          class:bad={!!problem}
          aria-label="Color code"
          maxlength="7"
          {disabled}
          value={typeof rule.value === 'string' ? rule.value : ''}
          oninput={(e) => (rule.value = e.currentTarget.value.toUpperCase())}
        />
      {/if}
    {/if}
  {/if}
  <button
    class="dg-ib del"
    aria-label="Remove rule"
    title="Remove rule"
    {disabled}
    onclick={ondelete}><X size={14} /></button
  >
  {#if problem}<p class="dg-err pr">{problem}</p>{/if}
</div>

<style>
  .rule {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px 0;
  }
  /* The folder field grows downward when its search opens: keep the other controls at the top. */
  .rule:has(:global(.fm)) {
    align-items: flex-start;
  }
  .p {
    width: 132px;
  }
  .m {
    width: 158px;
  }
  .v {
    flex: 1;
    min-width: 120px;
    width: auto;
  }
  .u {
    width: 96px;
  }
  .d {
    width: 140px;
  }
  .hex {
    width: 92px;
    font-family: var(--mono);
    text-transform: uppercase;
  }
  .grow {
    flex: 1;
    min-width: 160px;
  }
  .and,
  .unit {
    font-size: 12px;
    color: var(--fa);
  }
  .odd {
    font: 12px/1.4 var(--mono);
    color: var(--mu);
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .swatch {
    width: 32px;
    height: 30px;
    padding: 2px;
    border-radius: 6px;
    background: var(--fld);
    border: 1px solid var(--line);
    cursor: pointer;
  }
  .del {
    margin-left: auto;
  }
  .pr {
    flex-basis: 100%;
    margin: 0;
  }
  .stars button {
    padding: 0 8px;
    font-variant-numeric: tabular-nums;
  }
</style>
