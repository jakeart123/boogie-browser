<script lang="ts">
  // Keyboard shortcuts (Ctrl+/ or ?): every command that has keys, straight from the command
  // registry, so the sheet can't drift from what the keys really do.
  import { commands } from '../../lib/commands.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import Modal from './Modal.svelte';

  /** Plumbing that every panel has (Escape closes it); not worth a line each. */
  const SKIP = new Set(['dialog.close', 'overlay.escape', 'filter.closePopover']);
  const PRETTY: Record<string, string> = {
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    Escape: 'Esc',
    Delete: 'Del',
    PageUp: 'Page Up',
    PageDown: 'Page Down',
    Space: 'Space',
  };

  /** Rows of one kind per key (rate 1, rate 2... file with 1, 2...) read as one line each. */
  const FAMILIES: { prefix: string; title: string; keys: string[] }[] = [
    { prefix: 'grid.rate.', title: 'Rate 1 to 5 stars (0 clears)', keys: ['0–5'] },
    { prefix: 'viewer.rate.', title: 'Rate 1 to 5 stars (0 clears)', keys: ['0–5'] },
    { prefix: 'grid.rateNext.', title: 'Rate and go to the next item', keys: ['Shift+1–5'] },
    { prefix: 'viewer.rateNext.', title: 'Rate and go to the next item', keys: ['Shift+1–5'] },
    { prefix: 'triage.file.', title: 'File with a number key', keys: ['1–9'] },
    { prefix: 'triage.tag.', title: 'Tag with a letter key (again takes it off)', keys: ['A–L'] },
    {
      prefix: 'triage.tagAll.',
      title: 'Tag every queued item with the same note',
      keys: ['Shift+A–L'],
    },
    { prefix: 'triage.rate.', title: 'Rate 1 to 5 stars (Shift+0 clears)', keys: ['Shift+0–5'] },
    { prefix: 'triage.skip', title: 'Skip for now', keys: ['S', 'Space'] },
  ];

  let query = $state('');

  const keyParts = (k: string) => {
    const parts = k.split('+');
    if (k.endsWith('+')) parts.splice(-2, 2, '+'); // "Ctrl++" and "+" end in the plus key itself
    return parts.map((p) => PRETTY[p] ?? p);
  };

  const sections = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const seen = new Set<string>();
    const groups = new Map<string, { title: string; keys: string[] }[]>();
    for (const c of commands.list) {
      if (!c.keys?.length || SKIP.has(c.id)) continue;
      const fam = FAMILIES.find((f) => c.id.startsWith(f.prefix));
      const { title, keys } = fam ?? { title: c.title, keys: c.keys };
      const sig = `${title}|${keys.join(',')}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      if (q && !title.toLowerCase().includes(q) && !keys.join(' ').toLowerCase().includes(q))
        continue;
      const g = c.group ?? 'Other';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push({ title, keys });
    }
    return [...groups].sort((a, b) => a[0].localeCompare(b[0]));
  });
</script>

<Modal title="Keyboard shortcuts" subtitle="Ctrl / or ? opens this list" width={760}>
  <input
    class="dg-input"
    placeholder="Find a shortcut"
    aria-label="Find a shortcut"
    bind:value={query}
  />
  <div class="cols">
    {#each sections as [group, rows] (group)}
      <section>
        <h3>{group}</h3>
        {#each rows as r (r.title + r.keys.join())}
          <div class="row">
            <span class="t">{r.title}</span>
            <span class="k">
              {#each r.keys as k, i (k)}
                {#if i > 0}<span class="or">or</span>{/if}
                {#each keyParts(k) as p, j (j)}<kbd>{p}</kbd>{/each}
              {/each}
            </span>
          </div>
        {/each}
      </section>
    {:else}
      <p class="none">No shortcut matches.</p>
    {/each}
  </div>
  {#snippet footer()}
    <span class="dg-sp"></span>
    <button class="dg-btn pri" onclick={() => ui.closeDialog()}>Done</button>
  {/snippet}
</Modal>

<style>
  .cols {
    margin-top: 12px;
    columns: 2 320px;
    column-gap: 24px;
  }
  section {
    break-inside: avoid;
    margin-bottom: 14px;
  }
  h3 {
    margin: 0 0 6px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fa);
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 3px 0;
    font-size: 12.5px;
  }
  .t {
    flex: 1;
    min-width: 0;
    color: var(--tx);
  }
  .k {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 3px;
    max-width: 55%;
  }
  .or {
    color: var(--fa);
    font-size: 11px;
    padding: 0 2px;
  }
  .none {
    color: var(--fa);
    font-size: 13px;
  }
</style>
