<script lang="ts">
  // The one right-click menu. While it's open it has the keyboard: Up/Down move, Right or Enter
  // opens a submenu, Left or Escape backs out of one, Enter runs, Escape closes. Focus goes back
  // where it was when the menu closes.
  import { tick, untrack } from 'svelte';
  import { contextMenu, closeContextMenu, type MenuItem } from '../contextMenu.svelte';

  let sub = $state<{ index: number; items: MenuItem[] } | null>(null);
  let el = $state<HTMLDivElement | null>(null);
  let subEl = $state<HTMLDivElement | null>(null);
  let pos = $state({ x: 0, y: 0 });
  /** How far the open submenu moves up to stay on screen, and whether it opens to the left. */
  let subFit = $state({ dy: 0, left: false });

  // Keep the menu on screen.
  $effect(() => {
    const m = contextMenu.open;
    sub = null;
    if (!m || !el) return;
    const r = el.getBoundingClientRect();
    pos = {
      x: Math.max(8, Math.min(m.x, innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(m.y, innerHeight - r.height - 8)),
    };
  });

  // A tall submenu near the bottom moves up; one near the right edge opens to the left.
  $effect(() => {
    void sub;
    const s = subEl;
    if (!s) return;
    const r = s.getBoundingClientRect();
    const cur = untrack(() => subFit);
    const top = r.top - cur.dy;
    const bottom = r.bottom - cur.dy;
    const dy = Math.max(8 - top, Math.min(0, innerHeight - 8 - bottom));
    const parent = el?.getBoundingClientRect();
    const left = !!parent && parent.right + r.width - 4 > innerWidth - 8;
    if (dy !== cur.dy || left !== cur.left) subFit = { dy, left };
  });

  function openSub(i: number, item: MenuItem) {
    if (sub?.index === i) return;
    subFit = { dy: 0, left: false };
    sub = item.submenu && !item.disabled ? { index: i, items: item.submenu } : null;
  }

  function run(item: MenuItem) {
    if (item.disabled || item.separator || item.submenu) return;
    closeContextMenu();
    void item.run?.();
  }

  // Take the keyboard when a menu opens; give it back when it closes (unless whatever the menu
  // ran has put focus somewhere else, a dialog's field say).
  $effect(() => {
    if (!contextMenu.open) return;
    const before = untrack(() => document.activeElement);
    void tick().then(() => el?.focus({ preventScroll: true }));
    return () => {
      const now = document.activeElement;
      if (before instanceof HTMLElement && before.isConnected && (!now || now === document.body))
        before.focus({ preventScroll: true });
    };
  });

  const buttonsOf = (level: Element) => [
    ...level.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)'),
  ];

  async function enterSub(btn: HTMLButtonElement) {
    const i = Number(btn.dataset.i);
    const item = contextMenu.open?.items[i];
    if (!item?.submenu || item.disabled) return false;
    openSub(i, item);
    await tick();
    if (subEl) buttonsOf(subEl)[0]?.focus();
    return true;
  }

  function onkey(e: KeyboardEvent) {
    const active = document.activeElement;
    const level = (active instanceof Element && active.closest('.menu')) || el;
    if (!level) return;
    const inSub = level.classList.contains('submenu');
    const list = buttonsOf(level);
    const at = list.indexOf(active as HTMLButtonElement);
    const btn = at >= 0 ? list[at] : null;
    const go = (i: number) => list[(i + list.length) % list.length]?.focus();
    const back = () => {
      const parent = el?.querySelector<HTMLButtonElement>(
        `:scope > button[data-i="${sub?.index}"]`,
      );
      sub = null;
      parent?.focus();
    };
    switch (e.key) {
      case 'ArrowDown':
        go(at + 1);
        break;
      case 'ArrowUp':
        go(at < 0 ? -1 : at - 1);
        break;
      case 'Home':
        go(0);
        break;
      case 'End':
        go(-1);
        break;
      case 'ArrowRight':
        if (!inSub && btn) void enterSub(btn);
        break;
      case 'ArrowLeft':
        if (inSub) back();
        break;
      case 'Escape':
        if (!inSub) return; // the window handler closes the whole menu
        back();
        break;
      case 'Enter':
      case ' ':
        // A submenu opens; an action runs through the button's own click.
        if (!inSub && btn?.dataset.i && contextMenu.open?.items[Number(btn.dataset.i)]?.submenu)
          void enterSub(btn);
        else return;
        break;
      case 'Tab':
        break; // stays in the menu
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }
</script>

<svelte:window
  onkeydown={(e) => e.key === 'Escape' && contextMenu.open && closeContextMenu()}
  onblur={closeContextMenu}
/>

{#snippet row(item: MenuItem, onenter: () => void, i?: number)}
  <button
    role="menuitem"
    data-i={i}
    aria-haspopup={item.submenu ? 'menu' : undefined}
    class:danger={item.danger}
    disabled={item.disabled}
    title={item.title}
    onmouseenter={onenter}
    onclick={() => run(item)}
  >
    <span class="check">{item.checked ? '✓' : ''}</span>
    {#if item.swatch}<span class="swatch" style:background={item.swatch}></span>{/if}
    <span class="lb">{item.label}</span>
    {#if item.keys}<span class="k">{item.keys}</span>{/if}
    {#if item.submenu}<span class="k">›</span>{/if}
  </button>
{/snippet}

{#if contextMenu.open}
  <div
    class="scrim"
    role="presentation"
    onmousedown={closeContextMenu}
    oncontextmenu={(e) => (e.preventDefault(), closeContextMenu())}
  ></div>
  <div
    class="menu"
    role="menu"
    tabindex="-1"
    bind:this={el}
    style="left:{pos.x}px;top:{pos.y}px"
    onkeydown={onkey}
  >
    {#each contextMenu.open.items as item, i (i)}
      {#if item.separator}
        <div class="sep"></div>
      {:else}
        {@render row(item, () => openSub(i, item), i)}
        {#if sub && sub.index === i}
          <div
            class="menu submenu"
            class:left={subFit.left}
            role="menu"
            bind:this={subEl}
            style:transform="translateY({subFit.dy}px)"
          >
            {#each sub.items as s, j (j)}
              {#if s.separator}<div class="sep"></div>{:else}{@render row(s, () => {})}{/if}
            {/each}
          </div>
        {/if}
      {/if}
    {/each}
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 90;
  }
  .menu {
    position: fixed;
    z-index: 91;
    min-width: 200px;
    padding: 5px;
    border-radius: 9px;
    background: var(--panel);
    border: 1px solid var(--panel-line);
    box-shadow: var(--shadow-pop);
  }
  .submenu {
    position: absolute;
    left: calc(100% - 4px);
    margin-top: -34px;
  }
  .submenu.left {
    left: auto;
    right: calc(100% - 4px);
  }
  button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 28px;
    padding: 0 10px 0 6px;
    border-radius: 6px;
    font-size: 12.5px;
    text-align: left;
    position: relative;
  }
  .menu:focus {
    outline: none;
  }
  button:hover:not(:disabled),
  button:focus-visible {
    background: var(--bls);
    outline: none;
  }
  button:disabled {
    color: var(--fa);
  }
  .danger {
    color: var(--err);
  }
  .check {
    width: 14px;
    color: var(--link);
  }
  .swatch {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex: none;
    margin-left: -4px;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tx) 35%, transparent);
  }
  .lb {
    flex: 1;
    white-space: nowrap;
  }
  .k {
    /* Room between a long label and its key hint ("Shape and aspect ratio   Alt S"). */
    padding-left: 16px;
    color: var(--fa);
    font-size: 11.5px;
  }
  .sep {
    height: 1px;
    background: var(--panel-line);
    margin: 4px 6px;
  }
</style>
