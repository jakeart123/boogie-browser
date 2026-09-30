<script lang="ts">
  import { folderIcon } from '../../lib/folderIcons';
  import { FOLDER_COLORS, type FolderColor } from '../../../shared/types';

  let {
    color = null,
    smart = false,
    icon = null,
  }: { color?: FolderColor | string | null; smart?: boolean; icon?: string | null } = $props();
  // iconColor can be "" (API-made folders) or a name we don't know: fall back to the neutral tint.
  const tint = $derived((color && FOLDER_COLORS[color as FolderColor]) || null);
  // One of Eagle's built-in folder icons, when the folder has one we can draw.
  const Icon = $derived(folderIcon(icon));
</script>

{#if Icon}
  <span class="glyph ic"
    ><Icon size={15} strokeWidth={2} color={tint ?? (smart ? 'var(--ag)' : 'var(--mu)')} /></span
  >
{:else if smart}
  <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true" style:color={tint ?? 'var(--ag)'}>
    <path
      d="M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z"
      fill="currentColor"
    />
    <path d="M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" fill="currentColor" />
  </svg>
{:else}
  <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true" style:color={tint ?? 'var(--mu)'}>
    <path
      d="M2.5 6.4A2.4 2.4 0 0 1 4.9 4h4.6c.5 0 1 .2 1.3.6l1.3 1.5h7a2.4 2.4 0 0 1 2.4 2.4v9.1a2.4 2.4 0 0 1-2.4 2.4H4.9a2.4 2.4 0 0 1-2.4-2.4z"
      fill="currentColor"
    />
  </svg>
{/if}

<style>
  .glyph {
    width: 16px;
    height: 16px;
    flex: none;
  }
  .ic {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
</style>
