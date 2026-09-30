<script lang="ts">
  import { library } from '../../lib/stores/library.svelte';
  import { view } from '../../lib/stores/view.svelte';
  import { openContextMenu } from '../../lib/contextMenu.svelte';
  import { api } from '../../lib/api';
  import { canEdit, mutate, readOnlyTip } from '../../lib/edit';
  import FolderGlyph from './FolderGlyph.svelte';
  import Section from './Section.svelte';
  import { openFolder, openSmartFolder, toggleQuickAccess } from './actions';

  interface Entry {
    type: 'folder' | 'smartFolder';
    id: string;
    name: string;
    color: string | null;
    icon: string | null;
    count: number | undefined;
  }

  // Entries can point at folders that no longer exist; those are skipped, not shown.
  const entries = $derived.by(() => {
    const out: Entry[] = [];
    for (const e of library.state?.quickAccess ?? []) {
      if (e.type === 'folder') {
        const f = library.folders.get(e.id)?.node;
        if (f)
          out.push({
            type: 'folder',
            id: f.id,
            name: f.name,
            color: f.iconColor,
            icon: f.icon,
            count: library.counts?.folders[f.id]?.[view.showSubfolderContents ? 'deep' : 'own'],
          });
      } else if (e.type === 'smartFolder') {
        const f = library.smartFolders.get(e.id);
        if (f)
          out.push({
            type: 'smartFolder',
            id: f.id,
            name: f.name,
            color: f.iconColor,
            icon: f.icon,
            count: library.counts?.smartFolders[f.id],
          });
      }
    }
    return out;
  });

  // Drag to reorder. Entries that point at missing folders keep their place in the file.
  const QA_MIME = 'application/x-boogie-quick-access';
  let dragKey = $state<string | null>(null);
  let over = $state<{ key: string; after: boolean } | null>(null);
  const keyOf = (e: { type: string; id: string }) => `${e.type}:${e.id}`;

  function dragOver(ev: DragEvent, e: Entry) {
    if (!dragKey || !ev.dataTransfer?.types.includes(QA_MIME)) return;
    ev.preventDefault();
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    over = { key: keyOf(e), after: ev.clientY > r.top + r.height / 2 };
  }

  function drop(ev: DragEvent) {
    ev.preventDefault();
    const from = dragKey;
    const to = over;
    dragKey = over = null;
    if (!from || !to || from === to.key || !canEdit()) return;
    const list = (library.state?.quickAccess ?? []).map((q) => ({ type: q.type, id: q.id }));
    const moving = list.find((q) => keyOf(q) === from);
    if (!moving) return;
    const rest = list.filter((q) => q !== moving);
    const at = rest.findIndex((q) => keyOf(q) === to.key);
    if (at < 0) return;
    rest.splice(to.after ? at + 1 : at, 0, moving);
    void mutate(() => api.setQuickAccess(rest));
  }

  const selected = (e: Entry) =>
    e.type === 'folder'
      ? view.scope.kind === 'folder' && view.scope.id === e.id
      : view.scope.kind === 'smartFolder' && view.scope.id === e.id;
</script>

{#if entries.length}
  <Section id="quick" title="Quick Access">
    {#each entries as e (e.type + e.id)}
      <button
        class="sb-row"
        class:sel={selected(e)}
        class:dz-before={over?.key === keyOf(e) && !over.after}
        class:dz-after={over?.key === keyOf(e) && over.after}
        title={e.name}
        draggable={!library.readOnly}
        ondragstart={(ev) => {
          dragKey = keyOf(e);
          ev.dataTransfer?.setData(QA_MIME, dragKey);
        }}
        ondragend={() => (dragKey = over = null)}
        ondragover={(ev) => dragOver(ev, e)}
        ondragleave={() => over?.key === keyOf(e) && (over = null)}
        ondrop={drop}
        onclick={() => (e.type === 'folder' ? openFolder(e.id) : openSmartFolder(e.id))}
        oncontextmenu={(ev) =>
          openContextMenu(ev, [
            {
              label: 'Remove from Quick Access',
              disabled: library.readOnly,
              title: readOnlyTip(),
              run: () => toggleQuickAccess(e.type, e.id),
            },
          ])}
      >
        <FolderGlyph color={e.color} icon={e.icon} smart={e.type === 'smartFolder'} />
        <span class="fn">{e.name}</span>
        {#if e.count}<span class="sb-ct">{e.count.toLocaleString()}</span>{/if}
      </button>
    {/each}
  </Section>
{/if}
