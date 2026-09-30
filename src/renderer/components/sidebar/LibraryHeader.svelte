<script lang="ts">
  import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
  import { library } from '../../lib/stores/library.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import { openMenuBelow, type MenuItem } from '../../lib/contextMenu.svelte';
  import { openKnownLibrary, openOtherLibrary } from './actions';

  let btn = $state<HTMLButtonElement | null>(null);

  const ref = $derived(library.state?.ref ?? null);
  const readOnly = $derived(!!library.state?.readOnly);
  // Dropbox's state is only shown for a library that's shared over it.
  const sync = $derived(library.current?.shared ? (library.status?.sync ?? null) : null);
  const syncWord = $derived(
    sync
      ? (
          { idle: 'Synced', syncing: 'Syncing', offline: 'Offline' } as Record<
            string,
            string | undefined
          >
        )[sync.state]
      : undefined,
  );
  const dotColor = $derived(
    readOnly
      ? 'var(--warn)'
      : ((
          { idle: 'var(--ok)', syncing: 'var(--bl-soft)', offline: 'var(--warn)' } as Record<
            string,
            string | undefined
          >
        )[sync?.state ?? ''] ?? 'var(--fa)'),
  );
  const itemCount = $derived(library.counts?.all ?? null);
  const tip = $derived(
    ref
      ? [ref.path, readOnly ? library.state?.readOnlyReason : sync?.detail]
          .filter(Boolean)
          .join('\n')
      : 'Open or create a library',
  );

  /** "Course Library - Main File" -> CL, "my test" -> MT, "Art" -> AR */
  function initials(name: string): string {
    const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const two = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2);
    return two.toUpperCase();
  }

  function openMenu() {
    if (!btn) return;
    const names = library.known.map((k) => k.name);
    const items: MenuItem[] = library.known.map((k) => ({
      // Two libraries with the same folder name need something to tell them apart.
      label:
        (names.filter((n) => n === k.name).length > 1
          ? `${k.name} (${k.path.split('/').slice(-2, -1)[0] ?? ''})`
          : k.name) + (k.exists ? '' : ' (missing)'),
      checked: k.path === ref?.path,
      disabled: !k.exists,
      run: () => (k.path === ref?.path ? undefined : openKnownLibrary(k.path)),
    }));
    if (items.length) items.push({ separator: true });
    items.push(
      { label: 'Open other library…', run: openOtherLibrary },
      { label: 'Create new library…', run: () => ui.openDialog('libraries', { mode: 'create' }) },
      { label: 'Manage libraries…', run: () => ui.openDialog('libraries') },
    );
    openMenuBelow(btn, items);
  }
</script>

<button class="lib" bind:this={btn} onclick={openMenu} aria-haspopup="menu" title={tip}>
  <span class="ico">{ref ? initials(ref.name) : '?'}</span>
  <span class="txt">
    <span class="nm">{ref?.name ?? 'No library open'}</span>
    {#if ref}
      <span class="sub">
        <span class="dot" style:background={dotColor}></span>
        {#if readOnly}<span class="ro">Read-only</span>{:else if syncWord}{syncWord}{/if}
        {#if itemCount !== null}{readOnly || syncWord ? ' · ' : ''}{itemCount.toLocaleString()}
          {itemCount === 1 ? 'item' : 'items'}{/if}
      </span>
    {/if}
  </span>
  <ChevronsUpDown size={14} />
</button>

<style>
  .lib {
    height: 48px;
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 0 12px 0 14px;
    border-bottom: 1px solid var(--line);
    text-align: left;
    transition: background 100ms ease-out;
  }
  .lib:hover {
    background: var(--hov);
  }
  .lib:focus-visible {
    outline: 1px solid var(--bl-soft);
    outline-offset: -2px;
  }
  .ico {
    width: 26px;
    height: 26px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: 7px;
    font-weight: 600;
    font-size: 11px;
    background: linear-gradient(135deg, var(--chip), var(--hov));
    border: 1px solid var(--chip-line);
    color: var(--tx);
  }
  .txt {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .nm {
    font-weight: 600;
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sub {
    font-size: 11px;
    color: var(--fa);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    margin-right: 5px;
    vertical-align: 1px;
  }
  .ro {
    color: var(--warn);
  }
  .lib > :global(svg) {
    color: var(--fa);
    flex: none;
  }
</style>
