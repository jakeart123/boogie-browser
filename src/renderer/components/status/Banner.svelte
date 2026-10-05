<script lang="ts">
  // Top of the main column, only when something needs saying: the library is read-only, Boogie's
  // background writes keep failing, Dropbox isn't syncing a shared library, or the library is
  // still being read for the first time.
  import CloudOff from '@lucide/svelte/icons/cloud-off';
  import Lock from '@lucide/svelte/icons/lock';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { api } from '../../lib/api';
  import { quoted } from '../../lib/format';
  import { library } from '../../lib/stores/library.svelte';
  import { errorText } from '../../lib/edit';
  import { ui } from '../../lib/stores/ui.svelte';
  import { PROTECTED_WRITES } from '../dialogs/settings';
  import { offlineWarning } from './strip';

  const st = $derived(library.state);
  const reason = $derived(
    st?.readOnly ? (st.readOnlyReason ?? 'This library is read-only.') : null,
  );
  // Why it's read-only, as the core says it in code: 'guard' (not in the editable places yet) and
  // 'protected' (allowed, but in Dropbox or on a drive, which has its own switch in Settings) can
  // both be allowed from here.
  const kind = $derived(st?.readOnly ? (st.readOnlyKind ?? null) : null);
  const eagleHere = $derived(
    !!st && !!library.status?.eagle.running && library.status.eagle.openLibraryPath === st.ref.path,
  );
  // Present only while Boogie's background writes keep failing (older cores never send it).
  const writeProblem = $derived(
    typeof library.status?.writeProblem === 'string' ? library.status.writeProblem.trim() : '',
  );
  // Shared library, Dropbox not syncing: edits now may clash with the partner's later. The core
  // reports a library outside Dropbox as idle ("Not in Dropbox"), so this never shows for those.
  const syncWarning = $derived(
    offlineWarning(
      library.status?.sync ?? null,
      !!library.current?.shared,
      !!st?.readOnly,
      library.current?.partnerName?.trim() || null,
    ),
  );
  const indexing = $derived(st?.indexing ?? null);
  const pct = $derived(
    indexing && indexing.total > 0
      ? Math.min(100, Math.round((indexing.done / indexing.total) * 100))
      : null,
  );

  let busy = $state(false);

  async function reopen(): Promise<void> {
    if (!st) return;
    busy = true;
    try {
      await library.open(st.ref.path);
      if (library.readOnly && library.state?.readOnlyReason === reason)
        ui.toast('Still read-only', { kind: 'info', ms: 2500 });
    } catch (e) {
      ui.toast(`Couldn’t open the library. ${errorText(e)}`, { kind: 'error' });
    } finally {
      busy = false;
    }
  }

  async function allowEditing(): Promise<void> {
    if (!st) return;
    const { path, name } = st.ref;
    const { ok } = await ui.confirmWith(
      'Allow editing this library?',
      `Boogie will change the real files in ${quoted(name)}. If it lives in Dropbox, your partner will see your changes in their Eagle. Every change can be undone from History.`,
      { confirmLabel: 'Allow editing' },
    );
    if (!ok) return;
    busy = true;
    try {
      const roots = library.settings?.writableRoots ?? (await api.getSettings()).writableRoots;
      if (!roots.includes(path)) await library.updateSettings({ writableRoots: [...roots, path] });
      await library.open(path);
      // In Dropbox or on a drive, the folder alone isn't enough: ask for that switch next.
      if (library.state?.readOnlyKind === 'protected') await allowProtected();
      else tellResult(name);
    } catch (e) {
      ui.toast(`Couldn’t turn editing on. ${errorText(e)}`, { kind: 'error' });
    } finally {
      busy = false;
    }
  }

  /** The Settings switch for Dropbox and external drives, with the same question Settings asks. */
  async function allowProtected(): Promise<void> {
    if (!st) return;
    const { name } = st.ref;
    const { confirmTitle, confirmBody, confirmLabel } = PROTECTED_WRITES;
    if (!(await ui.confirm(confirmTitle, confirmBody, confirmLabel))) return;
    busy = true;
    try {
      await library.updateSettings({ allowProtectedWrites: true });
      // The core reopened the library for editing while saving; take its answer now rather than
      // wait for the 'library' event.
      const now = await api.getLibraryState();
      if (now) library.state = now;
      tellResult(name);
    } catch (e) {
      ui.toast(`Couldn’t turn editing on. ${errorText(e)}`, { kind: 'error' });
    } finally {
      busy = false;
    }
  }

  function tellResult(name: string): void {
    if (!library.readOnly) ui.toast(`Editing is on for ${quoted(name)}`, { kind: 'ok' });
    else
      ui.toast(`Still read-only. ${library.state?.readOnlyReason ?? ''}`.trim(), { kind: 'warn' });
  }
</script>

{#if reason}
  <div class="bar warn" role="status">
    <Lock size={14} />
    <span class="msg">{reason}</span>
    {#if kind === 'guard'}
      <button class="act" disabled={busy} onclick={allowEditing}>Allow editing…</button>
    {:else if kind === 'protected'}
      <button class="act" disabled={busy} onclick={allowProtected}>Allow editing…</button>
    {:else if kind === 'eagle' || eagleHere}
      <button class="act" disabled={busy} onclick={reopen}>Check again</button>
    {:else if kind === 'user'}
      <button class="act" disabled={busy} onclick={reopen}>Open for editing</button>
    {/if}
  </div>
{/if}

{#if writeProblem && !reason}
  <!-- Background writes (mtime.json) keep failing: the partner's Eagle can't see your edits. -->
  <div class="bar warn" role="alert">
    <TriangleAlert size={14} />
    <span class="msg">{writeProblem}</span>
  </div>
{/if}

{#if syncWarning}
  <!-- Why (not running, waiting to be linked, paused) is in the status strip, in Dropbox's words. -->
  <div class="bar warn" role="alert">
    <CloudOff size={14} />
    <span class="msg">{syncWarning}</span>
  </div>
{/if}

{#if indexing}
  <div class="bar info" role="status">
    <LoaderCircle size={14} class="spin" />
    <span class="msg"
      >{#if indexing.total > 0}Reading library… {indexing.done.toLocaleString()} of {indexing.total.toLocaleString()}
        items{:else}Reading the library folder…{/if}</span
    >
    <span class="prog" class:indet={pct === null}
      ><i style:width={pct === null ? undefined : `${pct}%`}></i></span
    >
  </div>
{/if}

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 34px;
    padding: 5px 14px;
    font-size: 12.5px;
    border-bottom: 1px solid var(--line);
    flex: none;
  }
  .bar.warn {
    background: color-mix(in srgb, var(--warn) 11%, transparent);
    border-bottom-color: color-mix(in srgb, var(--warn) 32%, transparent);
    color: var(--tx);
  }
  .bar.warn > :global(svg) {
    color: var(--warn);
    flex: none;
  }
  .bar.info {
    background: var(--bls);
    color: var(--tx);
  }
  .bar.info > :global(svg) {
    color: var(--bl-soft);
    flex: none;
  }
  .msg {
    flex: 0 1 auto;
    min-width: 0;
  }
  .act {
    margin-left: auto;
    flex: none;
    height: 24px;
    padding: 0 10px;
    border-radius: 5px;
    border: 1px solid color-mix(in srgb, var(--warn) 50%, transparent);
    color: var(--warn);
    cursor: pointer;
    transition: background 100ms ease-out;
  }
  .act:hover:not(:disabled) {
    background: color-mix(in srgb, var(--warn) 16%, transparent);
  }
  .act:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .act:focus-visible {
    outline: 1px solid var(--bl-soft);
    outline-offset: 1px;
  }
  .prog {
    width: 160px;
    height: 4px;
    border-radius: 2px;
    background: var(--line);
    overflow: hidden;
    flex: none;
    margin-left: 6px;
  }
  .prog i {
    display: block;
    height: 100%;
    background: var(--bl);
    transition: width 150ms ease-out;
  }
  .prog.indet i {
    width: 40%;
    animation: slide 1.4s ease-in-out infinite alternate;
  }
  @keyframes slide {
    from {
      margin-left: 0;
    }
    to {
      margin-left: 60%;
    }
  }
  :global(.spin) {
    animation: spin 1.6s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
