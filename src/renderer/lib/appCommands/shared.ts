// What the app-wide commands share: when a key may act on the window behind.
import type { CommandContext } from '../commands.svelte';
import { selection } from '../stores/selection.svelte';
import { ui } from '../stores/ui.svelte';

/**
 * Keys that act on the items or the window behind are off while an overlay (the palette, a
 * picker, a filter popover) has the keyboard, even once focus slips out of its text field, and
 * while a picker is open (T inside the tag window must not open it a second time). The palette
 * still lists them: it judges from the region under it and runs them after it closes.
 */
export const free = (c: CommandContext) => c.region !== 'overlay' && !ui.dialog && !ui.picker;
export const hasSelection = (c: CommandContext) => free(c) && selection.count > 0;
