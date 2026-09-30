// Creates and tracks the app's windows: the main window (remembers where it was) and the
// floating reference windows. Also the security rules every window gets.
import { BrowserWindow, screen, shell, type Rectangle } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BoogieEventName } from '../shared/api';
import { isWebUrl, referenceList } from './links';

export interface WindowsOptions {
  /** <config>/window.json lives here. */
  configDir: string;
  preload: string;
  /** Folder holding the built index.html and reference.html. */
  rendererDir: string;
  /** electron-vite dev server URL (ELECTRON_RENDERER_URL); undefined in a built app. */
  devUrl: string | undefined;
  iconPath: string;
  devtools: boolean;
  /** Ctrl+Q in any window. */
  quit: () => void;
}

interface SavedState extends Partial<Rectangle> {
  maximized?: boolean;
}

const BACKGROUND = '#1d1e21'; // --bg in tokens.css: no white flash while the renderer loads

export class Windows {
  main: BrowserWindow | null = null;
  private references = new Map<string, BrowserWindow>();

  constructor(private o: WindowsOptions) {}

  // ── main window ──

  createMain(): BrowserWindow {
    const saved = this.loadState();
    const win = new BrowserWindow({
      width: saved.width ?? 1600,
      height: saved.height ?? 1000,
      x: saved.x,
      y: saved.y,
      minWidth: 900,
      minHeight: 600,
      frame: false,
      roundedCorners: false, // the compositor rounds corners (Hyprland)
      backgroundColor: BACKGROUND,
      title: 'Boogie Browser',
      icon: this.o.iconPath,
      // No show:false + ready-to-show: that event is unreliable on NVIDIA/Wayland (electron#48859).
      webPreferences: this.webPreferences(),
    });
    if (saved.maximized) win.maximize();
    this.harden(win);
    this.rememberState(win);
    win.on('closed', () => {
      if (this.main === win) this.main = null;
    });
    this.main = win;
    void this.load(win, 'index.html');
    return win;
  }

  focusMain(): void {
    const win = this.main;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  // ── reference windows ──

  /**
   * A small always-on-top window with one item in it (the page handles opacity: it is transparent).
   * `ids` is the list it can step through with the arrow keys (the selection it was opened from).
   */
  openReference(itemId: string, ids?: string[]): void {
    const existing = this.references.get(itemId);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 640,
      height: 640,
      minWidth: 160,
      minHeight: 120,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      roundedCorners: false,
      alwaysOnTop: true, // a no-op on Wayland: a Hyprland windowrule on the title below pins it
      title: 'Boogie Reference',
      icon: this.o.iconPath,
      webPreferences: this.webPreferences(),
    });
    // A fixed title gives window rules something stable to match, whatever the page calls itself.
    win.on('page-title-updated', (e) => e.preventDefault());
    this.harden(win);
    this.references.set(itemId, win);
    win.on('closed', () => {
      if (this.references.get(itemId) === win) this.references.delete(itemId);
    });
    const query: Record<string, string> = { window: 'reference', item: itemId };
    const list = referenceList(itemId, ids);
    if (list.length > 1) query.items = list.join(',');
    void this.load(win, 'reference.html', query);
  }

  // ── events ──

  /** Push a core event to every window. */
  broadcast(event: BoogieEventName, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed())
        win.webContents.send(`boogie:event:${event}`, payload);
    }
  }

  /** Is this URL one of our own pages? Used to reject IPC and navigation from anything else. */
  isOwnUrl(raw: string | undefined): boolean {
    if (!raw) return false;
    try {
      const u = new URL(raw);
      if (this.o.devUrl) return u.origin === new URL(this.o.devUrl).origin;
      return u.protocol === 'file:' && fileURLToPath(u).startsWith(this.o.rendererDir + sep);
    } catch {
      return false;
    }
  }

  saveStateNow(): void {
    if (this.main && !this.main.isDestroyed()) this.writeState(this.main);
  }

  // ── internals ──

  private webPreferences() {
    return {
      preload: this.o.preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    };
  }

  private load(
    win: BrowserWindow,
    page: 'index.html' | 'reference.html',
    query: Record<string, string> = {},
  ): Promise<void> {
    if (this.o.devUrl) {
      const url = new URL(page === 'index.html' ? '/' : `/${page}`, this.o.devUrl);
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
      return win.loadURL(url.toString());
    }
    return win.loadFile(join(this.o.rendererDir, page), { query });
  }

  private harden(win: BrowserWindow): void {
    const wc = win.webContents;
    // Links open in the user's browser; nothing opens a new app window on its own.
    wc.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    // Dropping a file on the window must not navigate to it, and the app never leaves its own page.
    wc.on('will-navigate', (e, url) => {
      if (this.isOwnUrl(url)) return;
      e.preventDefault();
      if (isWebUrl(url)) void shell.openExternal(url);
    });
    // A blank window with no explanation is the worst failure to debug: say what happened.
    wc.on('did-fail-load', (_e, code, description, url) => {
      if (code !== -3) console.error(`[window] could not load ${url}: ${description} (${code})`); // -3 = aborted, normal
    });
    wc.on('render-process-gone', (_e, details) =>
      console.error('[window] the page crashed:', details.reason),
    );
    wc.setVisualZoomLevelLimits(1, 1); // pinch/ctrl+wheel zoom belongs to the grid, not the page
    // With no app menu, the window-level keys a menu would give are handled here.
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      const key = input.key.toLowerCase();
      const plain = !input.control && !input.shift && !input.alt && !input.meta;
      if (input.control && !input.shift && !input.alt && key === 'q') this.o.quit();
      else if (plain && input.key === 'F11') win.setFullScreen(!win.isFullScreen());
      else if (
        this.o.devtools &&
        (input.key === 'F12' || (input.control && input.shift && key === 'i'))
      )
        wc.toggleDevTools();
      else return;
      e.preventDefault();
    });
  }

  // ── remembered size, position and maximized ──

  private get stateFile(): string {
    return join(this.o.configDir, 'window.json');
  }

  private loadState(): SavedState {
    try {
      const s = JSON.parse(readFileSync(this.stateFile, 'utf8')) as SavedState;
      const out: SavedState = { maximized: s.maximized === true };
      if (
        Number.isFinite(s.width) &&
        Number.isFinite(s.height) &&
        s.width! >= 300 &&
        s.height! >= 200
      ) {
        const bounds = {
          x: Math.round(s.x ?? NaN),
          y: Math.round(s.y ?? NaN),
          width: Math.round(s.width!),
          height: Math.round(s.height!),
        };
        // Back on the monitor it was on, if that is still plugged in. Otherwise the default spot
        // on the main monitor; either way never bigger than the monitor it opens on.
        const home = Number.isFinite(bounds.x + bounds.y)
          ? screen.getAllDisplays().find((d) => overlaps(d.workArea, bounds))
          : undefined;
        const area = (home ?? screen.getPrimaryDisplay()).workArea;
        out.width = Math.min(bounds.width, area.width);
        out.height = Math.min(bounds.height, area.height);
        if (home) {
          out.x = bounds.x;
          out.y = bounds.y;
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  private rememberState(win: BrowserWindow): void {
    let timer: NodeJS.Timeout | null = null;
    const later = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => this.writeState(win), 500);
    };
    win.on('resize', later);
    win.on('move', later);
    win.on('maximize', later);
    win.on('unmaximize', later);
    win.on('close', () => {
      if (timer) clearTimeout(timer);
      this.writeState(win);
    });
  }

  private writeState(win: BrowserWindow): void {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    try {
      const state: SavedState = { ...win.getNormalBounds(), maximized: win.isMaximized() };
      mkdirSync(dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, this.stateFile);
    } catch (e) {
      console.warn('[window] could not save window.json:', e);
    }
  }
}

function overlaps(a: Rectangle, b: Rectangle): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
