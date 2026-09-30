// The viewer's keys and palette entries. Registered once by Viewer.svelte. Every command is
// active only while the viewer is open (and no dialog, picker or menu is above it) and has
// priority 10, so it wins over the grid's keys for the same key.
import { registerCommands, type Command, type CommandContext } from '../../lib/commands.svelte';
import { contextMenu } from '../../lib/contextMenu.svelte';
import { selection } from '../../lib/stores/selection.svelte';
import { ui } from '../../lib/stores/ui.svelte';
import { view } from '../../lib/stores/view.svelte';
import { copyItems, openDefault, openSource } from '../../lib/files';
import * as act from './actions';
import { currentId, goTo, step } from './nav';
import { viewer, type Player } from './state.svelte';

type Mode = 'detail' | 'quicklook' | 'compare' | 'present';

// Keys are off while an overlay (the palette, a picker) has the keyboard. The palette judges its
// list from the region under it and runs a command after it has closed, so it still offers these.
const free = (c: CommandContext) =>
  c.region !== 'overlay' && !ui.dialog && !ui.picker && !contextMenu.open;
const isOpen = (c: CommandContext) => !!ui.viewer && free(c);
const inMode =
  (...modes: Mode[]) =>
  (c: CommandContext) =>
    isOpen(c) && modes.includes(ui.viewer!.mode);
const hasPlayer =
  (fn: keyof Player, ...modes: Mode[]) =>
  (c: CommandContext) =>
    inMode(...modes)(c) && !!viewer.player?.[fn];

/**
 * Esc: leave full screen first (a full-screen video, or the slideshow, which then ends itself when
 * the browser reports full screen is over), and only then close the viewer.
 */
export function closeViewer(): void {
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => {});
    return;
  }
  ui.viewer = null;
}

/** F5: slideshow from the item you are on (in the viewer) or the primary item (in the grid). */
export function startPresent(): void {
  const v = ui.viewer;
  if (v?.mode === 'present') return closeViewer();
  if (v && v.mode !== 'compare') {
    ui.viewer = { mode: 'present', ids: v.ids, index: v.index };
    return;
  }
  const ids = view.result?.ids;
  if (!ids?.length) return void ui.toast('Nothing to show', { kind: 'info' });
  const at = selection.primary ? ids.indexOf(selection.primary) : -1;
  ui.viewer = { mode: 'present', ids, index: Math.max(0, at) };
}

const G = 'Viewer';

export function registerViewerCommands(): () => void {
  const P = 10;
  const nav: Mode[] = ['detail', 'quicklook', 'present'];
  const zoomable: Mode[] = ['detail', 'quicklook', 'compare'];
  const looks: Mode[] = ['detail', 'quicklook', 'compare', 'present'];
  const each = (fn: Parameters<typeof viewer.eachStage>[0]) => () => viewer.eachStage(fn);

  // Item keys work on the item on screen, in the detail view and quick look. Not in the slideshow:
  // its full-screen layer hides the toasts, so an edit there would be silent.
  const onItem = inMode('detail', 'quicklook');
  const withId = (fn: (id: string) => unknown) => () => {
    const id = currentId();
    if (id) void fn(id);
  };
  const isVideo = (c: CommandContext) => onItem(c) && viewer.player?.kind === 'video';

  const ratings: Command[] = [0, 1, 2, 3, 4, 5].flatMap((n): Command[] => {
    const title = n === 0 ? 'Clear rating' : `Rate ${n} ${n === 1 ? 'star' : 'stars'}`;
    const rateIt: Command = {
      id: `viewer.rate.${n}`,
      title,
      group: 'Rating',
      keys: [String(n)],
      priority: P,
      when: onItem,
      run: withId((id) => act.rate(id, n)),
    };
    if (!n) return [rateIt];
    return [
      rateIt,
      {
        id: `viewer.rateNext.${n}`,
        title: `${title} and go to next`,
        group: 'Rating',
        keys: [`Shift+${n}`],
        priority: P,
        hidden: true,
        when: onItem,
        run: withId((id) => (act.rate(id, n), step(1))),
      },
    ];
  });

  const itemCmds: Command[] = [
    {
      id: 'viewer.copy',
      title: 'Copy',
      group: 'Items',
      icon: 'copy',
      keys: ['Ctrl+C'],
      priority: P,
      when: onItem,
      run: withId((id) => copyItems([id])),
    },
    {
      id: 'viewer.openSource',
      title: 'Open source URL',
      group: 'Items',
      icon: 'link',
      keys: ['Ctrl+Shift+O'],
      priority: P,
      when: onItem,
      run: withId(openSource),
    },
    {
      id: 'viewer.trash',
      title: 'Move to trash',
      group: 'Items',
      icon: 'trash-2',
      keys: ['Delete'],
      priority: P,
      when: onItem,
      run: withId(act.trashOrDelete),
    },
    {
      id: 'viewer.removeFromFolder',
      title: 'Remove from this folder',
      group: 'Items',
      keys: ['Ctrl+Delete'],
      priority: P,
      when: (c) => onItem(c) && act.inFolderView(),
      run: withId(act.removeFromFolder),
    },
    {
      id: 'viewer.copyFrame',
      title: 'Copy this frame',
      group: G,
      keys: ['Shift+C'],
      priority: P,
      when: isVideo,
      run: () => viewer.player?.copyFrame?.(),
    },
    {
      id: 'viewer.saveFrame',
      title: 'Save this frame…',
      group: G,
      keys: ['Shift+S'],
      priority: P,
      when: isVideo,
      run: () => viewer.player?.saveFrame?.(),
    },
    {
      id: 'viewer.frameThumbnail',
      title: 'Use this frame as the thumbnail',
      group: G,
      icon: 'image',
      priority: P,
      when: isVideo,
      run: () => viewer.player?.frameAsThumbnail?.(),
    },
  ];

  const cmds: Command[] = [
    {
      id: 'viewer.close',
      title: 'Close viewer',
      group: G,
      keys: ['Escape'],
      priority: P,
      hidden: true,
      when: isOpen,
      run: closeViewer,
    },
    {
      id: 'viewer.prev',
      repeat: true,
      title: 'Previous item',
      group: G,
      keys: ['ArrowLeft', 'A'],
      priority: P,
      hidden: true,
      when: inMode(...nav),
      run: () => void step(-1),
    },
    {
      id: 'viewer.next',
      repeat: true,
      title: 'Next item',
      group: G,
      keys: ['ArrowRight', 'D'],
      priority: P,
      hidden: true,
      when: inMode(...nav),
      run: () => void step(1),
    },
    {
      id: 'viewer.first',
      title: 'First item',
      group: G,
      keys: ['Home'],
      priority: P,
      hidden: true,
      when: inMode('detail', 'quicklook'),
      run: () => goTo(0),
    },
    {
      id: 'viewer.last',
      title: 'Last item',
      group: G,
      keys: ['End'],
      priority: P,
      hidden: true,
      when: inMode('detail', 'quicklook'),
      run: () => goTo((ui.viewer?.ids.length ?? 1) - 1),
    },
    {
      id: 'viewer.detail',
      title: 'Open in detail view',
      group: G,
      keys: ['Enter'],
      priority: P,
      hidden: true,
      when: inMode('quicklook'),
      run: () => void (ui.viewer && (ui.viewer = { ...ui.viewer, mode: 'detail' })),
    },
    {
      id: 'viewer.quicklookClose',
      title: 'Close quick look',
      group: G,
      keys: ['Space'],
      priority: P,
      hidden: true,
      when: inMode('quicklook'),
      run: closeViewer,
    },

    {
      id: 'viewer.zoomIn',
      repeat: true,
      title: 'Zoom in',
      group: G,
      keys: ['Ctrl+=', 'Ctrl++', 'Ctrl+Shift++'],
      priority: P,
      when: inMode(...zoomable),
      run: each((s) => s.zoomBy(1.25)),
    },
    {
      id: 'viewer.zoomOut',
      repeat: true,
      title: 'Zoom out',
      group: G,
      keys: ['Ctrl+-'],
      priority: P,
      when: inMode(...zoomable),
      run: each((s) => s.zoomBy(0.8)),
    },
    {
      id: 'viewer.actual',
      title: 'Actual size (100%)',
      group: G,
      keys: ['Ctrl+0'],
      priority: P,
      when: inMode(...zoomable),
      run: each((s) => s.actual()),
    },
    {
      id: 'viewer.fit',
      title: 'Fit to window',
      group: G,
      keys: ['Ctrl+9'],
      priority: P,
      when: inMode(...zoomable),
      run: each((s) => s.fit()),
    },

    {
      id: 'viewer.flip',
      title: 'Flip horizontally',
      group: G,
      keys: ['Shift+H', 'Shift+F'],
      priority: P,
      when: inMode(...looks),
      run: () => (viewer.flip = !viewer.flip),
    },
    {
      id: 'viewer.gray',
      title: 'Grayscale',
      group: G,
      keys: ['Ctrl+Alt+G'],
      priority: P,
      when: inMode(...looks),
      run: () => (viewer.gray = !viewer.gray),
    },
    {
      id: 'viewer.rotate',
      title: 'Rotate the view 90 degrees',
      group: G,
      keys: ['Shift+R'],
      priority: P,
      when: inMode(...looks),
      run: () => viewer.turn(),
    },
    {
      id: 'viewer.background',
      title: 'Change viewer background',
      group: G,
      keys: ['B'],
      priority: P,
      when: inMode(...zoomable),
      run: () => viewer.cycleBg(),
    },

    {
      id: 'viewer.reference',
      title: 'Open in reference window',
      group: G,
      keys: ['Ctrl+O'],
      priority: P,
      when: inMode('detail', 'quicklook'),
      run: withId(act.openReferenceHere),
    },
    {
      id: 'viewer.openDefault',
      title: 'Open with default app',
      group: G,
      keys: ['Shift+Enter'],
      priority: P,
      when: inMode('detail', 'quicklook'),
      run: () => void (currentId() && openDefault(currentId()!)),
    },

    // Playback: Space is "play/pause" in the detail view and "pause the slideshow" while presenting.
    {
      id: 'viewer.play',
      title: 'Play or pause',
      group: G,
      keys: ['Space'],
      priority: P,
      when: hasPlayer('toggle', 'detail'),
      run: () => viewer.player?.toggle(),
    },
    {
      id: 'viewer.seekBack',
      repeat: true,
      title: 'Back 5 seconds',
      group: G,
      keys: ['Ctrl+ArrowLeft'],
      priority: P,
      hidden: true,
      when: hasPlayer('seek', 'detail', 'quicklook'),
      run: () => viewer.player?.seek?.(-5),
    },
    {
      id: 'viewer.seekForward',
      repeat: true,
      title: 'Forward 5 seconds',
      group: G,
      keys: ['Ctrl+ArrowRight'],
      priority: P,
      hidden: true,
      when: hasPlayer('seek', 'detail', 'quicklook'),
      run: () => viewer.player?.seek?.(5),
    },
    {
      id: 'viewer.framePrev',
      repeat: true,
      title: 'Previous frame',
      group: G,
      keys: ['['],
      priority: P,
      when: hasPlayer('frame', 'detail', 'quicklook'),
      run: () => viewer.player?.frame?.(-1),
    },
    {
      id: 'viewer.frameNext',
      repeat: true,
      title: 'Next frame',
      group: G,
      keys: [']'],
      priority: P,
      when: hasPlayer('frame', 'detail', 'quicklook'),
      run: () => viewer.player?.frame?.(1),
    },
    {
      id: 'viewer.framePrev10',
      repeat: true,
      title: 'Back 10 frames',
      group: G,
      keys: ['Shift+{'],
      priority: P,
      hidden: true,
      when: hasPlayer('frame', 'detail', 'quicklook'),
      run: () => viewer.player?.frame?.(-10),
    },
    {
      id: 'viewer.frameNext10',
      repeat: true,
      title: 'Forward 10 frames',
      group: G,
      keys: ['Shift+}'],
      priority: P,
      hidden: true,
      when: hasPlayer('frame', 'detail', 'quicklook'),
      run: () => viewer.player?.frame?.(10),
    },
    {
      id: 'viewer.faster',
      repeat: true,
      title: 'Playback faster',
      group: G,
      keys: ['Shift+>'],
      priority: P,
      when: hasPlayer('speed', 'detail', 'quicklook'),
      run: () => viewer.player?.speed?.(1),
    },
    {
      id: 'viewer.slower',
      repeat: true,
      title: 'Playback slower',
      group: G,
      keys: ['Shift+<'],
      priority: P,
      when: hasPlayer('speed', 'detail', 'quicklook'),
      run: () => viewer.player?.speed?.(-1),
    },
    {
      id: 'viewer.volumeUp',
      repeat: true,
      title: 'Volume up',
      group: G,
      keys: ['Ctrl+ArrowUp'],
      priority: P,
      hidden: true,
      when: hasPlayer('volume', 'detail', 'quicklook'),
      run: () => viewer.player?.volume?.(0.1),
    },
    {
      id: 'viewer.volumeDown',
      repeat: true,
      title: 'Volume down',
      group: G,
      keys: ['Ctrl+ArrowDown'],
      priority: P,
      hidden: true,
      when: hasPlayer('volume', 'detail', 'quicklook'),
      run: () => viewer.player?.volume?.(-0.1),
    },
    {
      id: 'viewer.mute',
      title: 'Mute or unmute',
      group: G,
      keys: ['M'],
      priority: P,
      when: hasPlayer('mute', 'detail', 'quicklook'),
      run: () => viewer.player?.mute?.(),
    },
    {
      id: 'viewer.loop',
      title: 'Loop on or off',
      group: G,
      keys: ['L'],
      priority: P,
      when: hasPlayer('loop', 'detail', 'quicklook'),
      run: () => viewer.player?.loop?.(),
    },

    // Slideshow.
    {
      id: 'viewer.present',
      title: 'Start slideshow',
      group: 'View',
      keys: ['F5'],
      priority: P,
      icon: 'presentation',
      when: free,
      run: startPresent,
    },
    {
      id: 'viewer.presentPause',
      title: 'Pause or resume the slideshow',
      group: G,
      keys: ['Space'],
      priority: P,
      hidden: true,
      when: inMode('present'),
      run: () => (viewer.paused = !viewer.paused),
    },
    {
      id: 'viewer.presentSlower',
      repeat: true,
      title: 'Slideshow: longer per picture',
      group: G,
      keys: ['+', '=', 'Shift++'],
      priority: P,
      hidden: true,
      when: inMode('present'),
      run: () => (viewer.interval = Math.min(60, viewer.interval + 1)),
    },
    {
      id: 'viewer.presentFaster',
      repeat: true,
      title: 'Slideshow: shorter per picture',
      group: G,
      keys: ['-', 'Shift+_'],
      priority: P,
      hidden: true,
      when: inMode('present'),
      run: () => (viewer.interval = Math.max(1, viewer.interval - 1)),
    },

    ...ratings,
    ...itemCmds,
  ];
  return registerCommands(cmds);
}
