<script lang="ts">
  // Settings. Every change saves right away through library.updateSettings.
  import { onDestroy } from 'svelte';
  import Check from '@lucide/svelte/icons/check';
  import Copy from '@lucide/svelte/icons/copy';
  import Plus from '@lucide/svelte/icons/plus';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import X from '@lucide/svelte/icons/x';
  import { api, inElectron } from '../../lib/api';
  import { library } from '../../lib/stores/library.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import { view } from '../../lib/stores/view.svelte';
  import type { AppSettings } from '../../../shared/types';
  import { errorText } from '../../lib/edit';
  import { LAYOUTS } from '../../lib/prefs';
  import Modal from './Modal.svelte';
  import { clampInt, extensionStatus, mcpCommand, mcpStatus } from './settings';

  const s = $derived(library.settings);
  const ports = $derived(library.status?.ports ?? null);

  let error = $state<string | null>(null);
  let saved = $state(false);
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(savedTimer));

  const DISPLAY: (keyof AppSettings)[] = [
    'layout',
    'thumbSize',
    'showNames',
    'showMeta',
    'showSubfolderContents',
  ];

  async function save(patch: Partial<AppSettings>): Promise<void> {
    error = null;
    try {
      await library.updateSettings(patch);
      // The grid keeps its own copy of the display choices; bring it along.
      if (
        library.settings &&
        Object.keys(patch).some((k) => DISPLAY.includes(k as keyof AppSettings))
      )
        view.applySettings(library.settings);
      saved = true;
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => (saved = false), 1600);
    } catch (e) {
      error = errorText(e);
    }
  }

  // Numbers: type freely, save (clamped) when the field is left.
  let portText = $state('');
  let thresholdText = $state('');
  let nameMaxText = $state('');
  $effect(() => {
    if (s) {
      portText = String(s.mcpPort);
      thresholdText = String(s.bulkConfirmThreshold);
      nameMaxText = String(s.windowsNameMaxChars);
    }
  });

  function commitNumber(
    text: string,
    key: 'mcpPort' | 'bulkConfirmThreshold' | 'windowsNameMaxChars',
    min: number,
    max: number,
  ) {
    if (!s) return;
    const n = clampInt(text, min, max);
    if (n === null || n === s[key]) {
      // Put the real value back if what was typed wasn't usable.
      if (key === 'mcpPort') portText = String(s[key]);
      else if (key === 'bulkConfirmThreshold') thresholdText = String(s[key]);
      else nameMaxText = String(s[key]);
      return;
    }
    void save({ [key]: n });
  }

  // Closing with Escape never blurs the field, so a number typed last would be lost without this.
  onDestroy(() => {
    commitNumber(portText, 'mcpPort', 1024, 65535);
    commitNumber(thresholdText, 'bulkConfirmThreshold', 1, 1_000_000);
    commitNumber(nameMaxText, 'windowsNameMaxChars', 20, 250);
  });

  // ── libraries Boogie may edit ──
  async function addRoot() {
    if (!s) return;
    try {
      const dir = await api.pickDirectory('Choose a folder Boogie may edit');
      if (dir && !s.writableRoots.includes(dir))
        await save({ writableRoots: [...s.writableRoots, dir] });
    } catch (e) {
      error = errorText(e);
    }
  }
  const removeRoot = (dir: string) =>
    s && save({ writableRoots: s.writableRoots.filter((r) => r !== dir) });

  // ── connect command ──
  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(copiedTimer));
  const command = $derived(mcpCommand(s?.mcpPort ?? 41597));
  async function copy() {
    try {
      if (inElectron) await api.copyText(command);
      else await navigator.clipboard.writeText(command);
      copied = true;
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => (copied = false), 1600);
    } catch (e) {
      ui.toast(`Couldn’t copy. ${errorText(e)}`, { kind: 'error' });
    }
  }
</script>

<Modal title="Settings" width={600}>
  {#if !s}
    <div class="dg-empty">Settings aren’t loaded yet.</div>
  {:else}
    <section class="dg-section">
      <h3>Browsing</h3>
      <div class="dg-field">
        <span class="dg-label">Default layout</span>
        <div class="dg-seg" role="group" aria-label="Default layout">
          {#each LAYOUTS as l (l.id)}
            <button
              class:on={s.layout === l.id}
              aria-pressed={s.layout === l.id}
              data-autofocus={s.layout === l.id ? '' : undefined}
              onclick={() => save({ layout: l.id })}>{l.label}</button
            >
          {/each}
        </div>
      </div>
      <div class="dg-field">
        <div class="dg-row" style="justify-content:space-between">
          <label class="dg-label" for="thumb">Thumbnail size</label>
          <span class="dg-hint">{s.thumbSize} px</span>
        </div>
        <input
          id="thumb"
          class="dg-range"
          type="range"
          min="80"
          max="400"
          step="10"
          value={s.thumbSize}
          onchange={(e) => save({ thumbSize: Number(e.currentTarget.value) })}
        />
      </div>
      <div class="dg-field">
        <label class="dg-check"
          ><input
            type="checkbox"
            checked={s.showNames}
            onchange={(e) => save({ showNames: e.currentTarget.checked })}
          />Show names under thumbnails</label
        >
        <label class="dg-check"
          ><input
            type="checkbox"
            checked={s.showMeta}
            onchange={(e) => save({ showMeta: e.currentTarget.checked })}
          />Show details (size, type) under thumbnails</label
        >
        <label class="dg-check">
          <input
            type="checkbox"
            checked={s.showSubfolderContents}
            onchange={(e) => save({ showSubfolderContents: e.currentTarget.checked })}
          />
          <span
            >Show items from subfolders<span class="dg-sub"
              >A folder also shows what’s inside the folders under it.</span
            ></span
          >
        </label>
      </div>
      <div class="dg-field">
        <label class="dg-label" for="dbl">Double-clicking an item</label>
        <select
          id="dbl"
          class="dg-select"
          value={s.doubleClickAction}
          onchange={(e) =>
            save({ doubleClickAction: e.currentTarget.value as AppSettings['doubleClickAction'] })}
        >
          <option value="detail">Opens the detail view</option>
          <option value="reference">Opens a floating reference window</option>
          <option value="open">Opens it in the default app</option>
        </select>
      </div>
    </section>

    <section class="dg-section">
      <h3>Connections</h3>
      <div class="dg-field">
        <label class="dg-check">
          <input
            type="checkbox"
            checked={s.eagleCompatApi}
            onchange={(e) => save({ eagleCompatApi: e.currentTarget.checked })}
          />
          <span
            >Eagle browser extension support<span class="dg-sub"
              >{extensionStatus(s.eagleCompatApi, ports)} Lets the Eagle extension in your browser save
              pictures here.</span
            ></span
          >
        </label>
      </div>
      <div class="dg-field">
        <label class="dg-check">
          <input
            type="checkbox"
            checked={s.mcpEnabled}
            onchange={(e) => save({ mcpEnabled: e.currentTarget.checked })}
          />
          <span
            >AI agent access (MCP)<span class="dg-sub"
              >{mcpStatus(s.mcpEnabled, ports)} Lets an AI agent like Claude read and organize this library.
              Every change it makes shows in History.</span
            ></span
          >
        </label>
      </div>
      {#if s.mcpEnabled}
        <div class="dg-field">
          <div class="dg-row">
            <label class="dg-label" for="port">Port</label>
            <input
              id="port"
              class="dg-input num"
              inputmode="numeric"
              bind:value={portText}
              onchange={() => commitNumber(portText, 'mcpPort', 1024, 65535)}
              onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
          </div>
        </div>
        <div class="dg-field">
          <span class="dg-label">Connect Claude Code with</span>
          <div class="dg-code">{command}</div>
          <div class="dg-row">
            <button class="dg-btn sm" onclick={copy}
              >{#if copied}<Check size={13} />Copied{:else}<Copy size={13} />Copy command{/if}</button
            >
          </div>
        </div>
      {/if}
    </section>

    <section class="dg-section">
      <h3>Libraries Boogie may edit</h3>
      <p class="dg-hint" style="margin-bottom:8px">
        Libraries inside these folders open for editing. Anywhere else opens read-only.
      </p>
      {#if s.writableRoots.length}
        <ul class="roots">
          {#each s.writableRoots as r (r)}
            <li>
              <span class="rp" title={r}>{r}</span><button
                class="dg-ib"
                aria-label="Stop allowing {r}"
                title="Remove"
                onclick={() => removeRoot(r)}><X size={14} /></button
              >
            </li>
          {/each}
        </ul>
      {:else}
        <p class="dg-hint">None yet. Every library opens read-only.</p>
      {/if}
      <div class="dg-row" style="margin-top:8px">
        <button class="dg-btn sm" onclick={addRoot}><Plus size={13} />Add folder…</button>
      </div>
      <div class="dg-note-box" style="margin-top:10px">
        <TriangleAlert size={14} />
        <span
          >Boogie changes the real library files inside these folders. If a library is shared over
          Dropbox, your partner sees every change. All changes can be undone from History.</span
        >
      </div>
    </section>

    <section class="dg-section">
      <h3>Safety limits</h3>
      <div class="dg-field">
        <div class="dg-row">
          <label class="dg-label" for="bulk" style="flex:1"
            >Ask before changing more than this many items at once</label
          >
          <input
            id="bulk"
            class="dg-input num"
            inputmode="numeric"
            bind:value={thresholdText}
            onchange={() => commitNumber(thresholdText, 'bulkConfirmThreshold', 1, 1_000_000)}
            onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        </div>
      </div>
      <div class="dg-field">
        <div class="dg-row">
          <label class="dg-label" for="namemax" style="flex:1"
            >Longest file name for new files (characters)</label
          >
          <input
            id="namemax"
            class="dg-input num"
            inputmode="numeric"
            bind:value={nameMaxText}
            onchange={() => commitNumber(nameMaxText, 'windowsNameMaxChars', 20, 250)}
            onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        </div>
        <p class="dg-hint">Keeps paths short enough for Eagle on Windows.</p>
      </div>
    </section>
  {/if}

  {#if error}<p class="dg-err" style="margin-top:12px">{error}</p>{/if}

  {#snippet footer()}
    <span class="dg-note">{saved ? 'Saved' : 'Changes save as you make them'}</span>
    <span class="dg-sp"></span>
    <button class="dg-btn pri" onclick={() => ui.closeDialog()}>Done</button>
  {/snippet}
</Modal>

<style>
  .roots {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .roots li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 4px 3px 10px;
    border-radius: 6px;
    background: var(--fld);
    border: 1px solid var(--line);
  }
  .rp {
    flex: 1;
    min-width: 0;
    font: 12px/1.5 var(--mono);
    color: var(--mu);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
