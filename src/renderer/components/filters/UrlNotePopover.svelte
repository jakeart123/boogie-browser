<script lang="ts">
  import { view } from '../../lib/stores/view.svelte';
  import Popover from './Popover.svelte';

  const f = $derived(view.filter);
  const tri = (v: boolean | undefined) => (v === undefined ? 'any' : v ? 'has' : 'none');
  const fromTri = (t: string) => (t === 'any' ? undefined : t === 'has');
  const active = $derived(
    f.hasUrl !== undefined || f.hasNote !== undefined || !!f.urlContains || !!f.noteContains,
  );
  let urlText = $state(view.filter.urlContains ?? '');
  let noteText = $state(view.filter.noteContains ?? '');
</script>

<Popover
  kind="urlnote"
  title="Source URL and notes"
  onclear={active
    ? () => (
        (urlText = noteText = ''),
        view.setFilter({
          hasUrl: undefined,
          hasNote: undefined,
          urlContains: undefined,
          noteContains: undefined,
        })
      )
    : undefined}
>
  <p class="sub">Source URL</p>
  <div class="seg" role="group" aria-label="Source URL">
    {#each [['any', 'Any'], ['has', 'Has one'], ['none', 'None']] as const as [t, label], i (t)}
      <button
        data-autofocus={i === 0 ? '' : undefined}
        aria-pressed={tri(f.hasUrl) === t}
        onclick={() => view.setFilter({ hasUrl: fromTri(t) })}>{label}</button
      >
    {/each}
  </div>
  <input
    class="inp field"
    placeholder="URL contains"
    aria-label="URL contains"
    bind:value={urlText}
    oninput={() => view.setFilter({ urlContains: urlText.trim() || undefined })}
  />

  <p class="sub">Note</p>
  <div class="seg" role="group" aria-label="Note">
    {#each [['any', 'Any'], ['has', 'Has one'], ['none', 'None']] as const as [t, label] (t)}
      <button
        aria-pressed={tri(f.hasNote) === t}
        onclick={() => view.setFilter({ hasNote: fromTri(t) })}>{label}</button
      >
    {/each}
  </div>
  <input
    class="inp field"
    placeholder="Note contains"
    aria-label="Note contains"
    bind:value={noteText}
    oninput={() => view.setFilter({ noteContains: noteText.trim() || undefined })}
  />
</Popover>

<style>
  .field {
    margin-top: 8px;
  }
</style>
