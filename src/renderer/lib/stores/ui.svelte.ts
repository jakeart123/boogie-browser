// Panels, overlays, viewer and dialogs. One overlay and one dialog at a time.
export type OverlayKind = 'command' | 'tags' | 'folderPicker' | 'goToFolder' | 'rename';
export type DialogKind =
  | 'libraries' // open / create / switch
  | 'import' // import progress + duplicate prompt
  | 'duplicates' // duplicate finder
  | 'settings'
  | 'confirm'
  | 'folderEdit'
  | 'smartFolderEdit'
  | 'tagManager'
  | 'conflicts'
  | 'prompt' // ui.prompt: one line of text
  | 'export' // export items to a folder
  | 'addUrl' // add from URL
  | 'copyToLibrary' // add to another library
  | 'shortcuts'; // the keyboard shortcut sheet

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'ok' | 'warn' | 'error';
  action?: { label: string; run: () => void };
  /** A newer toast with the same key replaces this one ("Importing…" by "Imported 3 items"). */
  key?: string;
}

class UIStore {
  sidebarVisible = $state(true);
  inspectorVisible = $state(true);
  inspectorTab = $state<'details' | 'history'>('details');
  overlay = $state<{ kind: OverlayKind; arg?: unknown } | null>(null);
  /**
   * detail = full view, quicklook = space-bar preview, compare = side by side, present = slideshow.
   * Raw: `ids` can be the grid's whole 85k-item list. Replace it whole, never mutate it.
   */
  viewer = $state.raw<{
    mode: 'detail' | 'quicklook' | 'compare' | 'present';
    ids: string[];
    index: number;
  } | null>(null);
  dialog = $state<{ kind: DialogKind; props?: Record<string, unknown> } | null>(null);
  toasts = $state<Toast[]>([]);
  /** An item to select and scroll to once the grid's result has it (a link was opened). */
  revealId = $state<string | null>(null);
  private nextToast = 1;

  /**
   * A picker overlay (tag window, folder picker, rename...) is open. The command palette doesn't
   * count: the commands it lists act on the window behind it.
   */
  get picker(): boolean {
    return !!this.overlay && this.overlay.kind !== 'command';
  }

  openOverlay(kind: OverlayKind, arg?: unknown): void {
    this.overlay = { kind, arg };
  }
  closeOverlay(): void {
    this.overlay = null;
  }
  openDialog(kind: DialogKind, props?: Record<string, unknown>): void {
    this.dialog = { kind, props };
  }
  closeDialog(): void {
    this.dialog = null;
  }

  /** Resolve with true/false. Rendered by the dialogs host (kind 'confirm'). */
  async confirm(
    title: string,
    body: string,
    confirmLabel = 'Continue',
    danger = false,
  ): Promise<boolean> {
    return (await this.confirmWith(title, body, { confirmLabel, danger })).ok;
  }

  /**
   * Confirm with an optional checkbox. The dialog calls props.resolve({ ok, checked }).
   * props: { title, body, confirmLabel, danger, checkbox: string | null, resolve }
   */
  confirmWith(
    title: string,
    body: string,
    opts: { confirmLabel?: string; danger?: boolean; checkbox?: string } = {},
  ): Promise<{ ok: boolean; checked: boolean }> {
    return new Promise((resolve) =>
      this.openDialog('confirm', {
        title,
        body,
        confirmLabel: opts.confirmLabel ?? 'Continue',
        danger: opts.danger ?? false,
        checkbox: opts.checkbox ?? null,
        resolve,
      }),
    );
  }

  /**
   * Ask for one line of text (a name). Resolves with the trimmed text, or null when cancelled or
   * left empty. Rendered by the dialogs host (kind 'prompt').
   */
  prompt(
    title: string,
    opts: { label?: string; value?: string; confirmLabel?: string; body?: string } = {},
  ): Promise<string | null> {
    return new Promise((resolve) => this.openDialog('prompt', { title, ...opts, resolve }));
  }

  toast(
    text: string,
    opts: { kind?: Toast['kind']; action?: Toast['action']; ms?: number; key?: string } = {},
  ): void {
    const kind = opts.kind ?? 'info';
    // The same notice again while it's still up (a refusal, key after key) doesn't stack.
    if (!opts.action && this.toasts.some((x) => x.text === text && x.kind === kind && !x.action))
      return;
    const t: Toast = { id: this.nextToast++, text, kind, action: opts.action, key: opts.key };
    const rest = opts.key ? this.toasts.filter((x) => x.key !== opts.key) : this.toasts;
    this.toasts = [...rest, t];
    setTimeout(() => (this.toasts = this.toasts.filter((x) => x.id !== t.id)), opts.ms ?? 5000);
  }
}

export const ui = new UIStore();
