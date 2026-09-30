<script lang="ts">
  // Triage mode, mounted once at the App root. Owns its keys (and the "Triage this view" entry in
  // the palette), and shows a session when `triage.open()` has started one.
  import { onMount, untrack } from 'svelte';
  import { on } from '../../lib/api';
  import { library } from '../../lib/stores/library.svelte';
  import { triage } from '../../lib/stores/triage.svelte';
  import Session from './Session.svelte';
  import { registerTriageCommands } from './commands';

  onMount(() => {
    const offKeys = registerTriageCommands();
    // Undone elsewhere (Ctrl+Z, the History tab): U must not try to undo it again. Redone
    // (Ctrl+Shift+Z): the step and its place in the queue come back.
    const offHistory = on('history', (e) => {
      if (e.kind === 'undo' && e.undoOf) triage.session?.undone(e.groupId, e.undoOf);
    });
    return () => (offKeys(), offHistory());
  });

  // Another library opened: the queue belongs to the old one.
  $effect(() => {
    const id = library.state?.ref.id;
    untrack(() => {
      if (triage.session && triage.session.libraryId !== id) triage.close();
    });
  });
</script>

{#if triage.session}
  <Session session={triage.session} />
{/if}
