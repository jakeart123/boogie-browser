<script lang="ts">
  // File types: groups and common extensions. Click includes, right-click excludes.
  import { view } from '../../lib/stores/view.svelte';
  import { TYPE_GROUPS, toggleIncluded } from './chips';
  import Popover from './Popover.svelte';

  const EXTS = [
    'jpg',
    'png',
    'webp',
    'gif',
    'psd',
    'tif',
    'pdf',
    'mp4',
    'mov',
    'heic',
    'avif',
    'svg',
  ];

  const include = $derived(view.filter.types?.include ?? []);
  const exclude = $derived(view.filter.types?.exclude ?? []);
  const stateOf = (id: string) =>
    include.includes(id) ? 'inc' : exclude.includes(id) ? 'exc' : 'off';

  function toggle(id: string, excluding: boolean) {
    const next = toggleIncluded(include, exclude, id, excluding);
    view.setFilter({
      types: next.include.length || next.exclude.length ? next : undefined,
    });
  }
</script>

<Popover
  kind="type"
  title="Filter by type"
  onclear={include.length || exclude.length
    ? () => view.setFilter({ types: undefined })
    : undefined}
>
  <p class="sub">Kind</p>
  <div class="grid">
    {#each TYPE_GROUPS as g, i (g.id)}
      <button
        class="tog"
        data-autofocus={i === 0 ? '' : undefined}
        data-state={stateOf(g.id)}
        aria-pressed={stateOf(g.id) === 'inc'}
        onclick={() => toggle(g.id, false)}
        oncontextmenu={(e) => (e.preventDefault(), toggle(g.id, true))}
      >
        {g.label}
      </button>
    {/each}
  </div>
  <p class="sub">Extension</p>
  <div class="grid">
    {#each EXTS as x (x)}
      <button
        class="tog"
        data-state={stateOf(x)}
        aria-pressed={stateOf(x) === 'inc'}
        onclick={() => toggle(x, false)}
        oncontextmenu={(e) => (e.preventDefault(), toggle(x, true))}
      >
        {x.toUpperCase()}
      </button>
    {/each}
  </div>
  <p class="hint">Click to include. Right-click to exclude.</p>
</Popover>
