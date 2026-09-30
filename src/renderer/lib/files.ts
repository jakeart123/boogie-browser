// Getting files in and out: imports (drops, the + menu, paste), and handing items to the rest of
// the desktop (reference window, default app, file manager, clipboard, links). Each one catches its
// own error and says so in a toast.
import { api, inElectron } from './api';
import { canEdit, fail } from './edit';
import { plural, quoted } from './format';
import { items } from './stores/items.svelte';
import { library } from './stores/library.svelte';
import { ui } from './stores/ui.svelte';
import { view } from './stores/view.svelte';

/** Where new files go by default: the folder you are looking at, if any. */
export function currentFolderId(): string | null {
  return view.scope.kind === 'folder' ? view.scope.id : null;
}

const into = (folderId: string | null) => {
  const name = folderId ? library.folder(folderId)?.node.name : null;
  return name ? ` into ${quoted(name)}` : '';
};

// ── in ──

/**
 * Files and folders from disk. `keepFolderStructure` recreates dropped folders as Eagle folders
 * (loose files still land in `folderId`); `folders` says how many of the paths are folders.
 */
export async function importPaths(
  paths: string[],
  folderId = currentFolderId(),
  opts: { keepFolderStructure?: boolean; folders?: number } = {},
): Promise<void> {
  if (!paths.length || !canEdit()) return;
  const { folders = 0, keepFolderStructure } = opts;
  try {
    await api.importPaths(paths, { folderId, keepFolderStructure });
    const files = paths.length - folders;
    const what = [folders && plural(folders, 'folder'), files && plural(files, 'file')]
      .filter(Boolean)
      .join(' and ');
    ui.toast(`Importing ${what}${into(folderId)}`, { ms: 2500, key: 'import' });
  } catch (e) {
    fail(e);
  }
}

export async function importUrl(url: string, folderId = currentFolderId()): Promise<void> {
  if (!canEdit()) return;
  try {
    await api.importUrl(url, { folderId });
    ui.toast(`Importing from the web${into(folderId)}`, { ms: 2500, key: 'import' });
  } catch (e) {
    fail(e);
  }
}

/**
 * Several links as ONE import job and one history entry. `asBookmarks` saves them as bookmark
 * items (web pages) instead of downloading what they point at.
 */
export async function importUrls(
  urls: string[],
  folderId = currentFolderId(),
  asBookmarks = false,
): Promise<void> {
  if (!urls.length || !canEdit()) return;
  try {
    const opts = { folderId };
    await api.importBatch!(
      urls.map((url) => (asBookmarks ? { bookmark: url, opts } : { url, opts })),
    );
    ui.toast(
      `${asBookmarks ? 'Saving' : 'Importing'} ${plural(urls.length, 'link')}${into(folderId)}`,
      { ms: 2500, key: 'import' },
    );
  } catch (e) {
    fail(e);
  }
}

/** http(s) and data: links, one per line (anything else on a line is ignored). */
export function linksIn(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/\s+/)
        .map((l) => l.trim())
        .filter((l) => /^(https?:\/\/\S+|data:\S+)$/i.test(l)),
    ),
  ];
}

/**
 * Ctrl+V and "+ > Paste from clipboard": files (a copied folder keeps its tree), else an image,
 * else links. The core runs a paste as an import job, and the job's own toast says how it went.
 */
export async function pasteFromClipboard(folderId = currentFolderId()): Promise<void> {
  if (!canEdit()) return;
  try {
    const clip = await api.readClipboardForImport();
    if (clip.paths.length) {
      await api.importPaths(clip.paths, { folderId, keepFolderStructure: true });
      return void ui.toast(`Importing from the clipboard${into(folderId)}`, {
        ms: 2500,
        key: 'import',
      });
    }
    if (clip.image)
      return void (await api.importBytes(clip.image, 'Pasted image.png', { folderId }));
    if (clip.urls?.length) return await importUrls(clip.urls, folderId);
    ui.toast('There is nothing to import on the clipboard', { ms: 2500 });
  } catch (e) {
    fail(e);
  }
}

export async function importFiles(): Promise<void> {
  if (!canEdit()) return;
  try {
    const paths = await api.pickFiles();
    if (paths.length) await importPaths(paths);
  } catch (e) {
    fail(e);
  }
}

/** A folder from disk, recreating its subfolders as Eagle folders. */
export async function importFolder(): Promise<void> {
  if (!canEdit()) return;
  try {
    const dir = await api.pickDirectory('Choose a folder to import');
    if (dir) await importPaths([dir], currentFolderId(), { keepFolderStructure: true, folders: 1 });
  } catch (e) {
    fail(e);
  }
}

// ── out ──

export async function openReference(id: string): Promise<void> {
  try {
    await api.openReferenceWindow(id);
  } catch (e) {
    fail(e);
  }
}

export async function openDefault(id: string): Promise<void> {
  try {
    await api.openItemWithDefaultApp(id);
  } catch (e) {
    fail(e);
  }
}

export async function reveal(id: string): Promise<void> {
  try {
    await api.revealItem(id);
  } catch (e) {
    fail(e);
  }
}

/** Ctrl+C: the pictures and the files, for pasting into other apps. */
export async function copyItems(ids: string[]): Promise<void> {
  if (!ids.length) return;
  try {
    await api.copyItems(ids);
    ui.toast(`Copied ${plural(ids.length, 'item')}`, { kind: 'ok', ms: 2000 });
  } catch (e) {
    fail(e);
  }
}

/** Copy text. `what` names it in the toast ("file path"); by default the text itself is shown. */
export async function copyText(text: string, what?: string): Promise<void> {
  try {
    if (inElectron) await api.copyText(text);
    else await navigator.clipboard.writeText(text);
    ui.toast(`Copied ${what ?? text}`, { kind: 'ok', ms: 2000 });
  } catch (e) {
    fail(e, 'Could not copy: ');
  }
}

/** Copy the originals into a folder you pick (never moves them): the export dialog. */
export function exportItems(ids: string[]): void {
  if (ids.length) ui.openDialog('export', { ids: [...ids] });
}

/** A whole folder, subfolders included, mirrored below the folder itself. */
export function exportFolder(folderId: string): void {
  ui.openDialog('export', { folderId });
}

/**
 * Eagle's link to an item or folder, as Obsidian and Notion accept it. Always Eagle's own port:
 * the link has to open in the partner's Eagle too, not just while Boogie answers on this computer.
 */
export function eagleLink(kind: 'item' | 'folder' | 'smartFolder', id: string): string {
  return `http://localhost:41595/${kind === 'smartFolder' ? 'smart-folder' : kind}?id=${id}`;
}

/** One link per line for several items. */
export function copyLink(
  kind: 'item' | 'folder' | 'smartFolder',
  ids: string | string[],
): Promise<void> {
  const list = typeof ids === 'string' ? [ids] : ids;
  return copyText(
    list.map((id) => eagleLink(kind, id)).join('\n'),
    list.length === 1 ? 'the link' : `${list.length} links`,
  );
}

export async function copyPaths(ids: string[]): Promise<void> {
  try {
    const full = await items.loadFulls(ids);
    await copyText(
      full.map((f) => f.filePath).join('\n'),
      ids.length === 1 ? 'the file path' : `${ids.length} file paths`,
    );
  } catch (e) {
    fail(e);
  }
}

/** Only web links open. A bare "example.com/x" gets https://. */
export function safeLink(raw: string): string | null {
  const url = raw.trim();
  if (!url) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export async function openLink(raw: string): Promise<void> {
  const url = safeLink(raw);
  if (!url) return ui.toast('This link can’t be opened. Only web links work.', { kind: 'warn' });
  try {
    if (inElectron) await api.openExternalUrl(url);
    else window.open(url, '_blank', 'noopener');
  } catch (e) {
    fail(e, 'Could not open the link: ');
  }
}

/** Ctrl+Shift+O: the item's source URL in the browser. */
export async function openSource(id: string): Promise<void> {
  try {
    const item = await items.loadFull(id);
    if (!item?.url) return void ui.toast('This item has no source URL');
    await openLink(item.url);
  } catch (e) {
    fail(e);
  }
}
