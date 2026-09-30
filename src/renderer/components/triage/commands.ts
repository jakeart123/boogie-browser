// Triage's keys and its palette entry. Registered by Triage.svelte (mounted once in App). While a
// session is open Triage is the keyboard mode (Session.svelte), so only these and the few app keys
// it keeps run; priority 20 wins over the kept ones they share (F, the digits).
import { registerCommands, type Command, type CommandContext } from '../../lib/commands.svelte';
import { contextMenu } from '../../lib/contextMenu.svelte';
import { library } from '../../lib/stores/library.svelte';
import { triage } from '../../lib/stores/triage.svelte';
import { ui } from '../../lib/stores/ui.svelte';
import { view } from '../../lib/stores/view.svelte';
import { viewer } from '../viewer/state.svelte';
import * as act from './actions';
import { FILE_KEYS, TAG_KEYS } from '../../lib/triageKeys';

const P = 20;
const G = 'Triage';

/** Nothing is above triage (a dialog, a picker, the palette, a menu). */
const clear = (c: CommandContext) =>
  c.region !== 'overlay' && !ui.dialog && !ui.picker && !contextMenu.open;
/** A session is open and its keys have the keyboard (not the folder/tag chooser). */
const live = (c: CommandContext) => !!triage.session && !triage.session.choosing && clear(c);
/** Keys that act on the item: not while editing keys, and not once everything is sorted. */
const acting = (c: CommandContext) =>
  live(c) && !triage.session!.editing && !triage.session!.finished;
/** Number and letter keys: act, or while editing keys, pick what the key does. */
const keyed = (c: CommandContext) =>
  live(c) && (triage.session!.editing || !triage.session!.finished);
/** Enter and Space press a focused button (Done, Fit, "Go through the skipped ones"). */
const notOnButton = () => !(document.activeElement instanceof HTMLButtonElement);

export function registerTriageCommands(): () => void {
  const files: Command[] = FILE_KEYS.map((k, slot) => ({
    id: `triage.file.${k}`,
    title: `File with key ${k}`,
    group: G,
    keys: [k],
    priority: P,
    hidden: true,
    when: keyed,
    run: () => void act.fileKey(slot),
  }));
  const tags: Command[] = TAG_KEYS.map((k, slot) => ({
    id: `triage.tag.${k}`,
    title: `Tag with key ${k}`,
    group: G,
    keys: [k],
    priority: P,
    hidden: true,
    when: keyed,
    run: () => void act.tagKey(slot),
  }));
  const tagAlls: Command[] = TAG_KEYS.map((k, slot) => ({
    id: `triage.tagAll.${k}`,
    title: `Tag every queued item with the same note, key ${k}`,
    group: G,
    keys: [`Shift+${k}`],
    priority: P,
    hidden: true,
    when: acting,
    run: () => act.tagAllKey(slot),
  }));
  // Shift+1-5 rates (the number keys file); Shift+0 clears.
  const ratings: Command[] = [0, 1, 2, 3, 4, 5].map((n) => ({
    id: `triage.rate.${n}`,
    title: n ? `Rate ${n} ${n === 1 ? 'star' : 'stars'}` : 'Clear rating',
    group: G,
    keys: [`Shift+${n}`],
    priority: P,
    hidden: true,
    when: acting,
    run: () => void act.rate(n),
  }));
  const each = (fn: Parameters<typeof viewer.eachStage>[0]) => () => viewer.eachStage(fn);

  return registerCommands([
    {
      id: 'triage.start',
      title: 'Triage this view',
      group: 'Items',
      icon: 'inbox',
      keys: ['Ctrl+Shift+T'],
      when: (c) =>
        clear(c) &&
        !!library.state &&
        !triage.session &&
        view.scope.kind !== 'trash' &&
        !!view.result?.ids.length,
      run: () => void triage.open(),
    },
    ...files,
    ...tags,
    ...tagAlls,
    ...ratings,
    {
      id: 'triage.other',
      title: 'File in another folder…',
      group: G,
      keys: ['0'],
      priority: P,
      when: acting,
      run: act.fileElsewhere,
    },
    {
      id: 'triage.tagWindow',
      title: 'Tag window',
      group: G,
      keys: ['T'],
      priority: P,
      when: acting,
      run: () => {
        const id = triage.session?.current;
        if (id) ui.openOverlay('tags', { ids: [id] });
      },
    },
    {
      id: 'triage.skip',
      repeat: true,
      title: 'Skip for now',
      group: G,
      keys: ['S'],
      priority: P,
      when: acting,
      run: () => void act.skip(),
    },
    {
      id: 'triage.skipSpace',
      repeat: true,
      title: 'Skip for now',
      group: G,
      keys: ['Space'],
      priority: P,
      hidden: true,
      when: (c) => acting(c) && notOnButton(),
      run: () => void act.skip(),
    },
    {
      id: 'triage.done',
      title: 'Done, next item',
      group: G,
      keys: ['Enter'],
      priority: P,
      when: (c) => acting(c) && notOnButton(),
      run: () => void act.done(),
    },
    {
      id: 'triage.trash',
      title: 'Move to trash',
      group: G,
      keys: ['X', 'Delete', 'Backspace'],
      priority: P,
      when: acting,
      run: () => void act.trash(),
    },
    {
      id: 'triage.undo',
      title: 'Undo the last triage key',
      group: G,
      keys: ['U', 'Z'],
      priority: P,
      when: (c) => live(c) && !triage.session!.editing,
      run: () => void act.undoLast(),
    },
    {
      id: 'triage.prev',
      repeat: true,
      title: 'Previous item',
      group: G,
      keys: ['ArrowLeft', 'ArrowUp'],
      priority: P,
      hidden: true,
      when: live,
      run: () => act.go(-1),
    },
    {
      id: 'triage.next',
      repeat: true,
      title: 'Next item',
      group: G,
      keys: ['ArrowRight', 'ArrowDown'],
      priority: P,
      hidden: true,
      when: live,
      run: () => act.go(1),
    },
    {
      id: 'triage.editKeys',
      title: 'Edit triage keys',
      group: G,
      icon: 'keyboard',
      priority: P,
      when: live,
      run: () => {
        if (triage.session) triage.session.editing = !triage.session.editing;
      },
    },
    {
      id: 'triage.fit',
      title: 'Fit to window',
      group: G,
      keys: ['Ctrl+9'],
      priority: P,
      when: live,
      run: each((s) => s.fit()),
    },
    {
      id: 'triage.actual',
      title: 'Actual size (100%)',
      group: G,
      keys: ['Ctrl+0'],
      priority: P,
      when: live,
      run: each((s) => s.actual()),
    },
    {
      id: 'triage.zoomIn',
      repeat: true,
      title: 'Zoom in',
      group: G,
      keys: ['Ctrl+=', 'Ctrl++', 'Ctrl+Shift++'],
      priority: P,
      hidden: true,
      when: live,
      run: each((s) => s.zoomBy(1.25)),
    },
    {
      id: 'triage.zoomOut',
      repeat: true,
      title: 'Zoom out',
      group: G,
      keys: ['Ctrl+-'],
      priority: P,
      hidden: true,
      when: live,
      run: each((s) => s.zoomBy(0.8)),
    },
    {
      // Esc also closes the chooser (its text field handles Esc itself while it has focus).
      id: 'triage.exit',
      title: 'Leave triage',
      group: G,
      icon: 'x',
      keys: ['Escape'],
      priority: P,
      when: (c) => !!triage.session && clear(c),
      run: () => {
        const s = triage.session;
        if (s?.choosing) s.choosing = null;
        else if (s?.editing) s.editing = false;
        else triage.close();
      },
    },
  ]);
}
