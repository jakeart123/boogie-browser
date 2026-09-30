// Which filter popover is open and where, plus the session-only "keep filter" lock. Shared by the
// toolbar (pipette, funnel), the filter bar (chips, + Filter) and the command palette.
import type { DateField, PopoverKind } from './chips';

export interface OpenPopover {
  kind: PopoverKind;
  field?: DateField;
  /** Viewport position of the popover's top-left corner (clamped by the popover itself). */
  x: number;
  y: number;
}

/** Widths in px; the popover clamps itself inside the window using these. */
export const POPOVER_WIDTH: Record<PopoverKind, number> = {
  tags: 330,
  folders: 340,
  color: 300,
  shape: 300,
  rating: 270,
  type: 330,
  date: 290,
  size: 260,
  dimensions: 290,
  duration: 260,
  urlnote: 310,
  saved: 320,
};

class FilterUi {
  open = $state<OpenPopover | null>(null);
  /** "Keep filter when changing folders". Session only, like Eagle's lock. */
  lock = $state(false);
  /** Elements popovers and the + Filter menu hang from. Set by the toolbar and the filter bar. */
  toolbarAnchor = $state.raw<HTMLElement | null>(null);
  barAnchor = $state.raw<HTMLElement | null>(null);

  /** Open a popover under `anchor` (or under the toolbar's funnel button when none is given). */
  openPopover(kind: PopoverKind, anchor?: Element | null, field?: DateField): void {
    const el = anchor ?? this.barAnchor ?? this.toolbarAnchor;
    const r = el?.getBoundingClientRect();
    this.open = {
      kind,
      field,
      x: r ? r.left : Math.max(8, window.innerWidth - 360),
      y: r ? r.bottom + 6 : 56,
    };
  }

  close(): void {
    this.open = null;
  }

  /** Anchor for the "+ Filter" menu: the bar's button when the bar is showing. */
  menuAnchor(): HTMLElement | null {
    return this.barAnchor ?? this.toolbarAnchor;
  }
}

export const filterUi = new FilterUi();
