// Grid selection. `primary` is the item the inspector shows (last clicked / keyboard focus).
class SelectionStore {
  ids = $state.raw<string[]>([]);
  primary = $state<string | null>(null);
  anchor = $state<string | null>(null);
  set = $derived(new Set(this.ids));
  count = $derived(this.ids.length);

  has(id: string): boolean {
    return this.set.has(id);
  }

  /** replace = plain click, toggle = Ctrl+click, range = Shift+click (needs the display order). */
  select(id: string, mode: 'replace' | 'toggle' | 'range' = 'replace', order?: string[]): void {
    if (mode === 'toggle') {
      this.ids = this.set.has(id) ? this.ids.filter((x) => x !== id) : [...this.ids, id];
      this.primary = id;
      this.anchor = id;
      return;
    }
    if (mode === 'range' && order && this.anchor) {
      const a = order.indexOf(this.anchor);
      const b = order.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        this.ids = order.slice(lo, hi + 1);
        this.primary = id;
        return;
      }
    }
    this.ids = [id];
    this.primary = id;
    this.anchor = id;
  }

  setMany(ids: string[], primary: string | null = ids.at(-1) ?? null): void {
    this.ids = ids;
    this.primary = primary;
    this.anchor = primary;
  }

  clear(): void {
    this.ids = [];
    this.primary = null;
    this.anchor = null;
  }

  /** The selected ids in the order the grid shows them (commands act in that order). */
  inOrder(order: readonly string[] | undefined): string[] {
    const ids = this.ids;
    if (!order || ids.length < 2) return [...ids];
    const pos = new Map<string, number>();
    order.forEach((id, i) => pos.set(id, i));
    return [...ids].sort((a, b) => (pos.get(a) ?? Infinity) - (pos.get(b) ?? Infinity));
  }

  /** Drop ids that are no longer in the result. */
  retain(valid: Set<string>): void {
    const kept = this.ids.filter((id) => valid.has(id));
    if (kept.length !== this.ids.length) this.ids = kept;
    if (this.primary && !valid.has(this.primary)) this.primary = kept.at(-1) ?? null;
  }
}

export const selection = new SelectionStore();
