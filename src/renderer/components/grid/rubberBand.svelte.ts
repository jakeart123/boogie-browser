// Drag a rectangle over empty grid space to select the tiles it touches (Ctrl adds to the
// selection). Scrolls while you hold the pointer near the top or bottom edge. A plain click on
// empty space clears the selection.
import { focus } from '../../lib/commands.svelte';
import { selection } from '../../lib/stores/selection.svelte';
import { itemsInRect, type Layout } from './layout';

/** What the grid hands its helpers: live getters, since the elements and the layout change. */
export interface GridParts {
  scroller(): HTMLElement | undefined;
  spacer(): HTMLElement | undefined;
  /** How far tiles sit above their layout position in the spacer (a very tall, scaled layout). */
  shift(): number;
  layout(): Layout;
  ids(): string[];
}

/** A point in the tile area's coordinates (the layout's own). */
export function contentPoint(spacer: HTMLElement, clientX: number, clientY: number, shift: number) {
  const r = spacer.getBoundingClientRect();
  return { x: clientX - r.left, y: clientY - r.top + shift };
}

const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export class RubberBand {
  /** The rectangle to draw, in content coordinates. */
  rect = $state<{ x: number; y: number; w: number; h: number } | null>(null);
  private start: {
    x: number;
    y: number;
    additive: boolean;
    base: string[];
    moved: boolean;
  } | null = null;
  private pointer = { x: 0, y: 0 };
  private raf = 0;

  constructor(private g: GridParts) {}

  /** True from pointerdown on empty space until pointerup. */
  get active(): boolean {
    return !!this.start;
  }

  down(e: PointerEvent): void {
    focus.region = 'grid';
    const scroller = this.g.scroller();
    const spacer = this.g.spacer();
    if (e.button !== 0 || !spacer || !scroller) return;
    if ((e.target as Element).closest('[data-id], button, a, input, .subfolders, .head')) return;
    if (e.clientX >= scroller.getBoundingClientRect().left + scroller.clientWidth) return; // the scrollbar
    e.preventDefault();
    scroller.focus({ preventScroll: true });
    scroller.setPointerCapture(e.pointerId);
    const additive = e.ctrlKey || e.metaKey;
    const p = contentPoint(spacer, e.clientX, e.clientY, this.g.shift());
    this.start = { ...p, additive, base: additive ? [...selection.ids] : [], moved: false };
    this.pointer = { x: e.clientX, y: e.clientY };
  }

  move(e: PointerEvent): void {
    if (!this.start) return;
    this.pointer = { x: e.clientX, y: e.clientY };
    this.update();
    if (!this.raf) this.raf = requestAnimationFrame(this.autoscroll);
  }

  up(e: PointerEvent): void {
    if (!this.start) return;
    if (!this.start.moved && !this.start.additive) selection.clear();
    this.start = null;
    this.rect = null;
    this.stop();
    try {
      this.g.scroller()?.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private update(): void {
    const s = this.start;
    const spacer = this.g.spacer();
    if (!s || !spacer) return;
    const p = contentPoint(spacer, this.pointer.x, this.pointer.y, this.g.shift());
    if (!s.moved && Math.hypot(p.x - s.x, p.y - s.y) < 4) return;
    s.moved = true;
    const x0 = Math.min(s.x, p.x);
    const y0 = Math.min(s.y, p.y);
    const x1 = Math.max(s.x, p.x);
    const y1 = Math.max(s.y, p.y);
    this.rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    const ids = this.g.ids();
    const hit = itemsInRect(this.g.layout(), x0, y0, x1, y1).map((i) => ids[i]);
    const next = s.additive ? [...new Set([...s.base, ...hit])] : hit;
    if (!sameIds(next, selection.ids)) selection.setMany(next, hit.at(-1) ?? next.at(-1) ?? null);
  }

  private autoscroll = () => {
    this.raf = 0;
    const scroller = this.g.scroller();
    if (!this.start || !scroller) return;
    const r = scroller.getBoundingClientRect();
    const edge = 40;
    const y = this.pointer.y;
    let dy = 0;
    if (y < r.top + edge) dy = -Math.ceil((r.top + edge - y) / 4);
    else if (y > r.bottom - edge) dy = Math.ceil((y - (r.bottom - edge)) / 4);
    if (!dy) return;
    scroller.scrollTop += dy;
    this.update();
    this.raf = requestAnimationFrame(this.autoscroll);
  };
}
