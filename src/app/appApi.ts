// AppApi: the things that need Electron (dialogs, clipboard, shell, drag out, windows).
// dispatch.ts calls these when the renderer invokes an AppApi method.
import {
  BrowserWindow,
  ClipboardItem,
  clipboard,
  dialog,
  nativeImage,
  shell,
  type NativeImage,
  type OpenDialogOptions,
  type WebContents,
} from 'electron';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CoreHost } from '../core/contracts';
import type { AppMethods } from './dispatch';
import type { ExportJobs } from './exporter';
import { pngBytesForFile, pngBytesFromBytes, vipsToPng } from './imageTools';
import { isWebUrl, urlsFromClipboardText } from './links';
import type { Windows } from './windows';

export interface AppCtx {
  /** The window that made the call (parent for dialogs), if it still exists. */
  win: BrowserWindow | null;
  sender: WebContents;
}

export interface AppApiDeps {
  host: CoreHost;
  windows: Windows;
  exports: ExportJobs;
  iconPath: string;
}

const DRAG_ICON_PX = 96;
/** Nautilus's clipboard format for copied files ("copy" then one file URL per line). */
const GNOME_FILES = 'x-special/gnome-copied-files';
/** How Electron lists that raw format when it reads the clipboard back. */
const GNOME_FILES_READ = `electron application/osclipboard;format="${GNOME_FILES}"`;
const MAX_DRAG_FILES = 1000;

/** A `.library` folder, or any folder that has the two things every Eagle library has. */
function looksLikeLibrary(dir: string): boolean {
  if (/\.library$/i.test(dir)) return true;
  try {
    return existsSync(join(dir, 'metadata.json')) && statSync(join(dir, 'images')).isDirectory();
  } catch {
    return false;
  }
}

/** Paths from a `text/uri-list` (or GNOME's copied-files list). Only file:// entries count. */
function pathsFromUriList(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l.startsWith('file://')) continue; // also skips comments and GNOME's leading "copy"/"cut"
    try {
      out.push(fileURLToPath(l));
    } catch {
      /* not a usable file url */
    }
  }
  return out;
}

export function createAppMethods(d: AppApiDeps): AppMethods<AppCtx> {
  const { host, windows } = d;
  const tmpDir = host.paths.tmp;
  const iconCache = new Map<string, NativeImage>();

  const openDialog = (ctx: AppCtx, opts: OpenDialogOptions) =>
    ctx.win ? dialog.showOpenDialog(ctx.win, opts) : dialog.showOpenDialog(opts);

  async function originalOrThrow(id: string): Promise<string> {
    const p = await host.originalPath(id);
    if (!p || !existsSync(p)) throw new Error('That file is missing from the library folder.');
    return p;
  }

  const appIcon = () =>
    nativeImage.createFromPath(d.iconPath).resize({ width: DRAG_ICON_PX, height: DRAG_ICON_PX });

  /** The image shown under the cursor while dragging: the first item's thumbnail at 96 px. */
  async function dragIcon(libraryId: string | undefined, itemId: string): Promise<NativeImage> {
    try {
      const thumb = libraryId ? await host.resolveFile('thumb', libraryId, itemId) : null;
      if (thumb) {
        const cached = iconCache.get(thumb.path);
        if (cached) return cached;
        let img = nativeImage.createEmpty();
        // Small thumbnails decode fine in-process. Big ones (noThumbnail items show the original)
        // and WebP-in-a-.png (Eagle's usual thumbnail) go through vips instead.
        if ((await stat(thumb.path)).size < 2_000_000) img = nativeImage.createFromPath(thumb.path);
        if (img.isEmpty()) {
          await mkdir(tmpDir, { recursive: true });
          const dir = await mkdtemp(join(tmpDir, 'icon-'));
          try {
            await vipsToPng(thumb.path, join(dir, 'icon.png'), DRAG_ICON_PX);
            img = nativeImage.createFromPath(join(dir, 'icon.png'));
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }
        if (!img.isEmpty()) {
          const { width, height } = img.getSize();
          const small =
            width >= height
              ? img.resize({ width: DRAG_ICON_PX })
              : img.resize({ height: DRAG_ICON_PX });
          if (iconCache.size > 200) iconCache.clear();
          iconCache.set(thumb.path, small);
          return small;
        }
      }
    } catch (e) {
      console.warn('[drag] no thumbnail icon:', e);
    }
    return appIcon();
  }

  return {
    async pickLibraryFolder(ctx) {
      const dropbox = join(homedir(), 'Dropbox');
      const r = await openDialog(ctx, {
        title: 'Open an Eagle library',
        properties: ['openDirectory'],
        defaultPath: existsSync(dropbox) ? dropbox : homedir(),
      });
      const dir = r.canceled ? null : r.filePaths[0];
      if (!dir) return null;
      if (!looksLikeLibrary(dir))
        throw new Error(
          'That folder is not an Eagle library. Pick a folder that ends in .library.',
        );
      return dir;
    },

    async pickDirectory(ctx, title) {
      const r = await openDialog(ctx, { title, properties: ['openDirectory', 'createDirectory'] });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },

    async pickFiles(ctx) {
      const r = await openDialog(ctx, {
        title: 'Add files',
        properties: ['openFile', 'multiSelections'],
      });
      return r.canceled ? [] : r.filePaths;
    },

    async startDrag(ctx, ids) {
      const files: string[] = [];
      let firstId: string | null = null;
      for (const id of ids.slice(0, MAX_DRAG_FILES)) {
        const p = await host.originalPath(id);
        if (p && existsSync(p)) {
          files.push(p);
          firstId ??= id;
        }
      }
      if (!files.length || !firstId) return; // nothing left on disk: no drag
      const libraryId = (await host.api.getLibraryState())?.ref.id;
      const icon = await dragIcon(libraryId, firstId);
      if (ctx.sender.isDestroyed()) return;
      ctx.sender.startDrag({ file: files[0], files, icon });
    },

    async copyItems(_ctx, ids) {
      const found: { id: string; path: string }[] = [];
      for (const id of ids.slice(0, MAX_DRAG_FILES)) {
        const path = await host.originalPath(id);
        if (path && existsSync(path)) found.push({ id, path });
      }
      if (!found.length)
        throw new Error(
          'Those files are missing from the library folder, so there is nothing to copy.',
        );
      // One copy carries both: pixels for image editors and browsers, file paths for file managers
      // (Dolphin and most apps read text/uri-list; Nautilus pastes files from GNOME's own list).
      const urls = found.map((f) => pathToFileURL(f.path).href);
      const entry: Record<string, string | Blob> = {
        'text/uri-list': urls.join('\r\n'),
        [GNOME_FILES]: new Blob([['copy', ...urls].join('\n')]),
      };
      const ext = (await host.api.getItem(found[0].id))?.ext ?? '';
      const png = await pngBytesForFile(found[0].path, ext, tmpDir);
      if (png) entry['image/png'] = new Blob([png], { type: 'image/png' });
      await clipboard.write([new ClipboardItem(entry)]);
    },

    async copyText(_ctx, text) {
      await clipboard.writeText(text);
    },

    async readClipboardForImport() {
      const empty = { paths: [] as string[], image: null as Uint8Array | null };
      try {
        const items = await clipboard.read();
        const text = async (item: (typeof items)[number], type: string) =>
          ((await item.getType(type)) as Blob).text();
        for (const item of items) {
          // Files copied in a file manager
          for (const type of ['text/uri-list', GNOME_FILES, GNOME_FILES_READ]) {
            if (!item.types.includes(type)) continue;
            const paths = pathsFromUriList(await text(item, type));
            if (paths.length) return { paths, image: null };
          }
        }
        for (const item of items) {
          // A copied picture (from a browser, a screenshot tool, Krita)
          const type = item.types.includes('image/png')
            ? 'image/png'
            : item.types.find((t) => t.startsWith('image/'));
          if (!type) continue;
          const bytes = new Uint8Array(await ((await item.getType(type)) as Blob).arrayBuffer());
          if (type === 'image/png') return { paths: [], image: bytes };
          const png = await pngBytesFromBytes(bytes, tmpDir);
          if (png) return { paths: [], image: png };
        }
        // Copied links ("Copy link" in a browser, a list of addresses from a text editor)
        for (const item of items) {
          if (!item.types.includes('text/uri-list')) continue;
          const urls = urlsFromClipboardText(await text(item, 'text/uri-list'), true);
          if (urls.length) return { ...empty, urls };
        }
        const urls = urlsFromClipboardText(await clipboard.readText());
        if (urls.length) return { ...empty, urls };
      } catch (e) {
        console.warn('[clipboard] could not read the clipboard:', e); // an odd clipboard is "nothing to paste"
      }
      return empty;
    },

    async revealItem(_ctx, id) {
      shell.showItemInFolder(await originalOrThrow(id));
    },

    async openItemWithDefaultApp(_ctx, id) {
      const error = await shell.openPath(await originalOrThrow(id));
      if (error) throw new Error(`Could not open that file: ${error}`);
    },

    async openExternalUrl(_ctx, url) {
      if (!isWebUrl(url)) throw new Error('Only web links (http or https) can be opened.');
      await shell.openExternal(url);
    },

    exportItems: (_ctx, ids, dir, opts) => d.exports.start(ids, dir, opts),

    async showFolder(_ctx, path) {
      let isDir = false;
      try {
        isDir = isAbsolute(path) && (await stat(path)).isDirectory();
      } catch {
        /* reported below */
      }
      if (!isDir) throw new Error('That folder does not exist any more.');
      const error = await shell.openPath(path);
      if (error) throw new Error(`Could not open that folder: ${error}`);
    },

    async openReferenceWindow(_ctx, id, ids) {
      windows.openReference(id, ids);
    },

    // Runs inside the window itself (webUtils in the preload); it can't work over IPC.
    getPathForFile() {
      throw new Error('getPathForFile only works inside the window, not over IPC.');
    },

    windowControl(ctx, action) {
      const win = ctx.win;
      if (!win || win.isDestroyed()) return;
      if (action === 'minimize') win.minimize();
      else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
      else if (action === 'fullscreen') win.setFullScreen(!win.isFullScreen());
      else if (action === 'close') win.close();
    },
  };
}
