// Command registry + keyboard dispatcher. Every action with a shortcut or a Ctrl+K entry is a
// command. Components register theirs on mount:
//
//   onMount(() => registerCommands([{ id: 'grid.selectAll', title: 'Select all', keys: ['Ctrl+A'],
//     group: 'Selection', when: (c) => c.region === 'grid', run: () => ... }]));
//
// Key strings: modifiers in the order Ctrl+Alt+Shift+Meta, then the key: a letter (upper case),
// digit, or a KeyboardEvent.key name (Enter, Escape, Delete, Backspace, Space, ArrowLeft, F2,
// PageDown, '=', '-', '[', ']', '*', ...). Shift+digit is written 'Shift+1' (uses e.code).

import { untrack } from 'svelte';
import { contextMenu } from './contextMenu.svelte';

/** Which part of the window has keyboard focus. */
export type Region = 'grid' | 'sidebar' | 'inspector' | 'viewer' | 'overlay' | 'dialog' | 'other';

/**
 * What a command is judged against. A key press uses the live region. The command palette uses
 * the region it was opened from, so it lists what the window behind it can do, and it runs the
 * command only after it has closed and that region is live again.
 */
export interface CommandContext {
  region: Region;
}

export interface Command {
  id: string;
  title: string; // shown in the command palette
  group?: string; // palette section: 'Tags', 'Folders', 'View', 'Selection', 'Library'...
  keys?: string[];
  icon?: string; // lucide icon name, for the palette
  /** Only active when this returns true (checked at key time and palette time). */
  when?: (ctx: CommandContext) => boolean;
  /** Fire even while typing in an input (Escape, Ctrl+K...). Default false. */
  allowInInput?: boolean;
  /** Higher wins when several enabled commands share a key. Default 0; overlays use 10+. */
  priority?: number;
  /** Hide from the command palette (still runs by key). */
  hidden?: boolean;
  /**
   * Keeps running while its key is held down: moving, zooming, stepping frames. Everything else
   * runs once per press, so a held X or Delete can't trash one item after another.
   */
  repeat?: boolean;
  /**
   * Acts on the main window's panels (the sidebar, the filter bar, where the grid is), so it is
   * off while the viewer or Triage covers them.
   */
  mainWindow?: boolean;
  /** Still runs while a full-window mode owns the keyboard (overlays' and dialogs' Escape). */
  anyMode?: boolean;
  /** What it returns is ignored (awaited when the palette runs it). */
  run: () => unknown;
}

class Focus {
  region = $state<Region>('grid');
  /** The region under the open overlays (palette, pickers): where focus returns when they close. */
  underOverlay = $state<Region>('grid');
}
export const focus = new Focus();

/** The context for a key press right now. */
export function liveContext(): CommandContext {
  return { region: focus.region };
}

// A full-window mode (Triage, the slideshow, the viewer, a dialog) owns the keyboard: while one
// is up, a command runs, and the palette lists it, only when the mode on top keeps it. What sits
// behind (the grid, the sidebar, another mode) can't act on keys it never sees.
interface Mode {
  name: string;
  keeps: (c: Command) => boolean;
}
let modes = $state.raw<Mode[]>([]);

/** Call when a full-window mode opens; call the returned function when it closes. */
export function enterMode(name: string, keeps: (c: Command) => boolean): () => void {
  const mode = { name, keeps };
  // Often called from an effect: reading the stack there must not make the effect depend on it.
  modes = [...untrack(() => modes), mode];
  return () => (modes = untrack(() => modes).filter((m) => m !== mode));
}

/** The full-window mode on top, if any ('triage', 'slideshow', 'viewer', 'dialog'). */
export function topMode(): string | null {
  return modes.at(-1)?.name ?? null;
}

function kept(c: Command): boolean {
  const top = modes.at(-1);
  return !top || !!c.anyMode || top.keeps(c);
}

class Registry {
  list = $state.raw<Command[]>([]);

  register(cmds: Command[]): () => void {
    this.list = [...this.list.filter((c) => !cmds.some((n) => n.id === c.id)), ...cmds];
    return () => {
      const ids = new Set(cmds.map((c) => c.id));
      this.list = this.list.filter((c) => !ids.has(c.id) || !cmds.includes(c));
    };
  }

  enabled(ctx: CommandContext = liveContext()): Command[] {
    return this.list.filter((c) => kept(c) && (!c.when || c.when(ctx)));
  }

  async run(id: string, ctx: CommandContext = liveContext()): Promise<boolean> {
    const cmd = this.list.find((c) => c.id === id);
    if (!cmd || !kept(cmd) || (cmd.when && !cmd.when(ctx))) return false;
    await cmd.run();
    return true;
  }
}

export const commands = new Registry();

export function registerCommands(cmds: Command[]): () => void {
  return commands.register(cmds);
}

// While a modal overlay (the palette, a picker, a filter popover) is open, the grid's single-key
// shortcuts (1-5 to rate, T, F...) must not fire, so the region becomes 'overlay'. Several can
// open in a row (palette -> tag window), so this counts them and restores the region under them
// only when the last one closes.
let overlays = 0;

/** Call when an overlay opens; call the returned function when it closes. */
export function enterOverlay(): () => void {
  if (++overlays === 1) {
    focus.underOverlay = focus.region;
    focus.region = 'overlay';
  }
  let left = false;
  return () => {
    if (left) return;
    left = true;
    if (--overlays === 0) focus.region = focus.underOverlay;
  };
}

export function keyString(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  let key = e.key;
  if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (/^Numpad[0-9]$/.test(e.code)) key = e.code.slice(6);
  else if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return parts.join('+');
  parts.push(key);
  return parts.join('+');
}

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.isContentEditable ||
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT'
  );
}

/** Install once (App.svelte). Returns an uninstall function. */
export function installKeyHandler(target: Window = window): () => void {
  const handler = (e: KeyboardEvent) => {
    // An open right-click menu has the keyboard (arrows, Enter, Escape); nothing else runs.
    if (e.isComposing || contextMenu.open) return;
    const inInput = typing(e.target);
    // A held-down Enter acts once. Its repeats run no command, and outside a text field they don't
    // click the focused button either: the first press often opens a confirm whose button has the
    // focus ("Merge tags", "Change 5,454 items?"), and the repeats would answer it.
    if (e.key === 'Enter' && e.repeat) {
      if (!inInput) e.preventDefault();
      return;
    }
    const key = keyString(e);
    const matches = commands
      .enabled()
      .filter((c) => c.keys?.includes(key) && (!inInput || c.allowInInput))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    const cmd = matches[0];
    if (!cmd) return;
    e.preventDefault();
    e.stopPropagation();
    // A held key acts once unless its command is made for holding (arrows, zoom).
    if (e.repeat && !cmd.repeat) return;
    void cmd.run();
  };
  target.addEventListener('keydown', handler, true);
  return () => target.removeEventListener('keydown', handler, true);
}
