<script lang="ts">
  // Import progress, and the question when files turn out to be in the library already.
  // Opened with { jobId } from the strip (a running import), the toast's Review button, or the command bar.
  import { untrack } from 'svelte';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import FileImage from '@lucide/svelte/icons/file-image';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import { api } from '../../lib/api';
  import { plural, quoted } from '../../lib/format';
  import { errorText, readOnlyTip as lockTip } from '../../lib/edit';
  import { currentFolderId } from '../../lib/files';
  import { items } from '../../lib/stores/items.svelte';
  import { library } from '../../lib/stores/library.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import type { ImportOptions } from '../../../shared/types';
  import { importResult, jobs, jobText } from '../status/jobs.svelte';
  import { onEscape } from './escape';
  import FolderSearch from './FolderSearch.svelte';
  import Modal from './Modal.svelte';

  let { props: incoming }: { props: Record<string, unknown> } = $props();
  // Read once: Dialogs.svelte mounts a fresh component for every openDialog call.
  const args = untrack(() => incoming);

  let jobId = $state<string | null>(typeof args.jobId === 'string' ? args.jobId : null);
  const job = $derived(jobId ? jobs.byId(jobId) : jobs.latestImport);
  const result = $derived(importResult(job));
  const dupes = $derived(result?.duplicates ?? []);
  const failed = $derived(result?.failed ?? []);
  // Added with a caveat (a "picture" that can't be read became an icon-only item).
  const warned = $derived(result?.warnings ?? []);
  const running = $derived(job?.state === 'running');
  const pct = $derived(
    job && job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : null,
  );

  // The options the import started with (tags, rating, notes, folder) carry over to a retry.
  // A plain copy: what goes to the app over IPC can't be a Svelte proxy.
  const startOpts = $derived(
    job?.options ? ($state.snapshot(job.options) as ImportOptions) : undefined,
  );
  // The folder for the retry is shown as a choice, starting from the one the import went to.
  let picked = $state<string | null | undefined>(undefined);
  const dest = $derived(picked !== undefined ? picked : (startOpts?.folderId ?? null));
  const destInfo = $derived(dest ? library.folder(dest) : undefined);
  const destName = $derived(destInfo?.node.name ?? null);
  let choosing = $state(false);
  $effect(() => {
    if (!choosing) return;
    return onEscape(() => ((choosing = false), true));
  });

  let busy = $state(false);
  let error = $state<string | null>(null);
  /** What the last retry asked for, so the summary can say "filed" instead of "added". */
  let retried = $state<'keep-both' | 'use-existing' | null>(null);

  // Ask for the thumbnails of the items the new files collided with.
  $effect(() => {
    if (dupes.length) items.ensure(dupes.slice(0, 200).map((d) => d.existingId));
  });

  const isUrl = (s: string) => /^(https?:|data:)/i.test(s);

  /** A friendly name for a path or link. */
  function shortName(source: string): string {
    if (source.startsWith('data:')) return 'Pasted image';
    const clean = source.split(/[?#]/)[0].replace(/\/+$/, '');
    const last = clean.slice(clean.lastIndexOf('/') + 1);
    try {
      return decodeURIComponent(last) || source;
    } catch {
      return last || source;
    }
  }

  async function again(mode: 'keep-both' | 'use-existing') {
    if (busy || !dupes.length) return;
    busy = true;
    error = null;
    try {
      const opts: ImportOptions = { ...(startOpts ?? {}), folderId: dest, onDuplicate: mode };
      const sources = dupes.map((d) => d.source);
      const paths = sources.filter((s) => !isUrl(s));
      let first: string | null = null;
      if (paths.length) first = (await api.importPaths(paths, opts)).jobId;
      for (const u of sources.filter(isUrl)) {
        const r = await api.importUrl(u, opts);
        first ??= r.jobId;
      }
      if (first) {
        retried = mode;
        jobId = first;
      }
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }

  async function addFiles() {
    error = null;
    try {
      const paths = await api.pickFiles();
      if (!paths.length) return;
      const r = await api.importPaths(paths, { folderId: currentFolderId() });
      retried = null;
      jobId = r.jobId;
    } catch (e) {
      error = errorText(e);
    }
  }

  function cancel() {
    if (job) void api.cancelJob(job.jobId).catch((e) => (error = errorText(e)));
  }

  const summary = $derived.by(() => {
    if (!result) return '';
    const n = result.added.length;
    const bits = [
      retried === 'use-existing' && destName
        ? `${plural(n, 'item')} filed in ${quoted(destName)}`
        : `${plural(n, 'item')} added`,
    ];
    if (dupes.length) bits.push(`${dupes.length.toLocaleString()} already in the library`);
    if (warned.length)
      bits.push(
        `${warned.length.toLocaleString()} only as ${warned.length === 1 ? 'an icon' : 'icons'}`,
      );
    if (failed.length) bits.push(`${failed.length.toLocaleString()} couldn’t be imported`);
    return bits.join(', ');
  });
  const readOnlyTip = $derived(library.readOnly ? lockTip() : undefined);
</script>

<Modal
  title="Import"
  subtitle={job && !running && (dupes.length || failed.length || warned.length)
    ? summary
    : undefined}
  width={620}
>
  {#if !job}
    <div class="dg-empty">
      <FileImage size={26} />
      Nothing is importing right now. Drop files on the grid, paste, or add files here.
    </div>
  {:else if running}
    <div class="run">
      <div class="dg-row">
        <LoaderCircle size={15} class="dg-spin" /><span>{jobText(job)}</span>
      </div>
      <div class="dg-prog" class:indet={pct === null}>
        <i style:width={pct === null ? undefined : `${pct}%`}></i>
      </div>
    </div>
  {:else if job.state === 'failed'}
    <p class="dg-err">The import failed. {job.error ?? ''}</p>
  {:else}
    {#if job.state === 'cancelled'}<p class="dg-hint" style="margin:6px 0">
        Import cancelled. What was already added stays.
      </p>{/if}
    {#if !dupes.length && !failed.length && !warned.length && result}
      <div class="dg-empty"><CircleCheck size={26} style="color:var(--ok)" />{summary}</div>
    {/if}

    {#if dupes.length}
      <div class="dg-section">
        <h3>Already in your library</h3>
        <p class="dg-hint" style="margin-bottom:8px">
          These files match items you already have, so they weren’t added again. You can skip them,
          import them anyway, or file the items you already have in a folder.
        </p>
        <div class="dest">
          <span class="dg-label">Folder for the last two choices</span>
          <button
            type="button"
            class="dg-select pickdest"
            aria-expanded={choosing}
            title={destInfo?.path.join(' › ')}
            onclick={() => (choosing = !choosing)}
            >{destInfo ? destInfo.path.join(' › ') : 'No folder'}</button
          >
          {#if choosing}
            <FolderSearch none="No folder" onpick={(id) => ((picked = id), (choosing = false))} />
          {/if}
        </div>
        <ul class="pairs">
          {#each dupes.slice(0, 200) as d (d.source + d.existingId)}
            {@const b = items.brief(d.existingId)}
            <li>
              <span class="newf" title={d.source}>{shortName(d.source)}</span>
              <span class="arrow">is the same as</span>
              <span class="old" title={b?.name}>
                <span class="th"
                  >{#if b}<img src={b.thumbUrl} alt="" loading="lazy" />{/if}</span
                >
                <span class="on">{b ? `${b.name}.${b.ext}` : 'An existing item'}</span>
              </span>
            </li>
          {/each}
        </ul>
        {#if dupes.length > 200}<p class="dg-hint">
            and {(dupes.length - 200).toLocaleString()} more
          </p>{/if}
      </div>
    {/if}

    {#if failed.length}
      <div class="dg-section">
        <h3>Couldn’t be imported</h3>
        <ul class="fails">
          {#each failed.slice(0, 100) as f (f.source)}
            <li>
              <span class="fn" title={f.source}>{shortName(f.source)}</span><span class="fr"
                >{f.reason}</span
              >
            </li>
          {/each}
        </ul>
        {#if failed.length > 100}<p class="dg-hint">
            and {(failed.length - 100).toLocaleString()} more
          </p>{/if}
      </div>
    {/if}

    {#if warned.length}
      <div class="dg-section">
        <h3>Added as icons only</h3>
        <ul class="fails">
          {#each warned.slice(0, 100) as w (w.source)}
            <li>
              <span class="fn" title={w.source}>{shortName(w.source)}</span><span class="fr warn"
                >{w.reason}</span
              >
            </li>
          {/each}
        </ul>
        {#if warned.length > 100}<p class="dg-hint">
            and {(warned.length - 100).toLocaleString()} more
          </p>{/if}
      </div>
    {/if}
  {/if}

  {#if error}<p class="dg-err" style="margin-top:10px">{error}</p>{/if}

  {#snippet footer()}
    {#if running}
      <span class="dg-sp"></span>
      <button class="dg-btn" onclick={cancel}>Cancel import</button>
      <button class="dg-btn" onclick={() => ui.closeDialog()}>Hide</button>
    {:else if dupes.length}
      <span class="dg-sp"></span>
      <button class="dg-btn" onclick={() => ui.closeDialog()}>Skip them</button>
      <button
        class="dg-btn"
        disabled={busy || library.readOnly}
        title={readOnlyTip ?? 'Add them again as new items'}
        onclick={() => again('keep-both')}>Import anyway</button
      >
      <button
        class="dg-btn pri"
        disabled={busy || library.readOnly || !destName}
        title={readOnlyTip ?? (destName ? undefined : 'Pick a folder above first')}
        onclick={() => again('use-existing')}
      >
        Add existing items to {destName ? quoted(destName) : 'a folder'}
      </button>
    {:else}
      <button class="dg-btn" disabled={library.readOnly} title={readOnlyTip} onclick={addFiles}
        >Add files…</button
      >
      <span class="dg-sp"></span>
      <button class="dg-btn pri" onclick={() => ui.closeDialog()}>Done</button>
    {/if}
  {/snippet}
</Modal>

<style>
  .run {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px 0 6px;
    font-size: 13px;
  }
  .dest {
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin: 0 0 10px;
  }
  .pickdest {
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pairs,
  .fails {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .pairs li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1.2fr);
    align-items: center;
    gap: 12px;
    padding: 7px 0;
    border-top: 1px solid var(--line);
    font-size: 12.5px;
  }
  .newf,
  .on {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .arrow {
    color: var(--fa);
    font-size: 11.5px;
    white-space: nowrap;
  }
  .old {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
  }
  .th {
    width: 40px;
    height: 40px;
    flex: none;
    border-radius: 5px;
    background: var(--thumb-bg);
    overflow: hidden;
  }
  .th img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .fails li {
    display: flex;
    gap: 12px;
    padding: 6px 0;
    border-top: 1px solid var(--line);
    font-size: 12.5px;
  }
  .fn {
    flex: 0 1 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fr {
    flex: 1;
    color: var(--err);
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .fr.warn {
    color: var(--warn);
  }
</style>
