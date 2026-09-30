<script lang="ts">
  // One history entry: who, what, when, and the buttons (Show them, Undo; for a change the
  // partner's Eagle may have written an old copy over: Put my change back, or Keep theirs).
  import Bot from '@lucide/svelte/icons/bot';
  import Cog from '@lucide/svelte/icons/cog';
  import UserIcon from '@lucide/svelte/icons/user';
  import Users from '@lucide/svelte/icons/users';
  import type { HistoryEntry } from '../../../shared/types';
  import { api } from '../../lib/api';
  import { fail, readOnlyTip, undo as undoGroup } from '../../lib/edit';
  import { chainRoot } from '../../lib/history';
  import { library } from '../../lib/stores/library.svelte';
  import { view } from '../../lib/stores/view.svelte';
  import { dateTime, relativeTime } from '../../lib/format';
  import { history } from './history.svelte';
  import { clock, initials, isRedo, rowParts, undoLabel } from './logic';

  let { entry, today }: { entry: HistoryEntry; today: boolean } = $props();

  const kind = $derived(entry.actor.kind);
  const undone = $derived(history.reversed.has(entry.groupId));
  const when = $derived(today ? relativeTime(entry.at, history.now) : clock(entry.at));
  let busy = $state(false);
  // The partner's Eagle may have saved an old copy of an item over your newer change (Dropbox
  // sync), or the partner changed it on purpose: the files can't tell, so you decide. "Put my change
  // back" undoes the entry; "Keep theirs" leaves their version and marks the entry resolved. Until
  // then the row is tinted and counted in the status strip.
  const stale = $derived(!!entry.staleOverwrite);
  const kept = $derived(!!entry.keptTheirs);
  const waiting = $derived(stale && !undone && !kept);
  const parts = $derived(rowParts(entry, history.entries));
  // A shared library without a partner name gets "Dropbox" as the actor: never call that a person.
  const partner = $derived(library.current?.partnerName?.trim() || null);
  // An outside change nobody is named for ("Outside Boogie", "Dropbox") gets the same people icon
  // as the status strip, not initials that read like a person ("OB").
  const anonymous = $derived(kind === 'external' && entry.actor.name !== partner);
  // Whose version stays: "Keep Sam’s", "Keep the other computer’s", or "Keep theirs". The entry
  // names its writer (the core knows the partner's name even when this window's list doesn't yet);
  // the core's stand-ins for "nobody named" aren't a name.
  const whose = $derived.by(() => {
    const who = entry.actor.name;
    if (who === 'Boogie on another computer') return 'the other computer’s';
    if (who && !['Your partner', 'Dropbox', 'Outside Boogie'].includes(who)) return `${who}’s`;
    return partner ? `${partner}’s` : null;
  });

  async function keepTheirs() {
    busy = true;
    try {
      await api.keepTheirs(entry.groupId);
      await history.refreshTop();
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
    }
  }

  async function undo() {
    busy = true;
    try {
      const redo = isRedo(entry, history.entries);
      const r = await undoGroup(
        entry.groupId,
        stale
          ? partner
            ? `${partner}’s old copy`
            : 'the old copy from your partner’s Eagle'
          : chainRoot(entry, history.entries).root.label,
        redo ? 'Redid' : 'Undid',
      );
      if (r?.reverted) await history.refreshTop();
    } finally {
      busy = false;
    }
  }
</script>

<div class="hev" class:undone class:stale={waiting}>
  <span class="av {kind}" aria-hidden="true">
    {#if kind === 'agent'}<Bot size={13} />{:else if kind === 'system'}<Cog
        size={13}
      />{:else if kind === 'user' && entry.actor.name === 'You'}<UserIcon
        size={13}
      />{:else if anonymous}<Users size={13} />{:else}{initials(entry.actor.name)}{/if}
  </span>
  <div>
    {#if parts.who}<span class="who">{parts.who}</span>{/if}{#if kind === 'agent'}<span class="ai-b"
        >agent</span
      >{/if}{parts.rest}
    <div class="meta">
      <span title={dateTime(entry.at)}>{when}</span>
      {#if entry.itemIds.length}
        <button type="button" onclick={() => view.setScope({ kind: 'ids', ids: entry.itemIds })}
          >Show them</button
        >
      {/if}
      {#if undone}
        <span class="was">{stale ? 'Your change is back' : 'Undone'}</span>
      {:else if kept}
        <span class="was">{whose ? `Kept ${whose} version` : 'Kept theirs'}</span>
      {:else if waiting}
        <button
          type="button"
          class="pri"
          disabled={busy || library.readOnly}
          title={readOnlyTip()}
          onclick={undo}>Put my change back</button
        >
        <button type="button" disabled={busy} onclick={keepTheirs}
          >{whose ? `Keep ${whose}` : 'Keep theirs'}</button
        >
      {:else if entry.undoable}
        <button
          type="button"
          disabled={busy || library.readOnly}
          title={readOnlyTip()}
          onclick={undo}>{undoLabel(entry, history.entries)}</button
        >
      {/if}
    </div>
  </div>
</div>

<style>
  .hev {
    display: grid;
    grid-template-columns: 24px 1fr;
    gap: 10px;
    padding: 10px 0;
    border-top: 1px solid var(--line);
    font-size: 12.5px;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .hev.undone {
    opacity: 0.55;
  }
  /* Waiting for you to decide: the partner's Eagle may have written an old copy over your change. */
  .hev.stale {
    margin: 0 -8px;
    padding: 10px 8px;
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--rm) 9%, transparent);
  }
  .av {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 10.5px;
    font-weight: 600;
    color: var(--bg);
    background: var(--bl-soft);
  }
  .av.external {
    background: var(--rm);
  }
  .av.agent {
    background: var(--ag);
  }
  .av.system {
    background: var(--chip-line);
    color: var(--mu);
  }
  .who {
    font-weight: 600;
  }
  .ai-b {
    font-size: 10px;
    font-weight: 600;
    color: var(--ag);
    border: 1px solid color-mix(in srgb, var(--ag) 40%, transparent);
    border-radius: 4px;
    padding: 0 4px;
    margin-left: 4px;
  }
  .meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 10px;
    margin-top: 4px;
    font-size: 11.5px;
    color: var(--fa);
  }
  .meta button {
    color: var(--link);
    font-size: 11.5px;
    cursor: pointer;
  }
  .meta button:disabled {
    color: var(--fa);
    cursor: default;
  }
  .meta button:not(:disabled):hover {
    text-decoration: underline;
  }
  .meta button.pri:not(:disabled) {
    font-weight: 600;
  }
</style>
