// The two IPC doors the preload uses: `boogie:invoke` (request/response) and `boogie:startDrag`
// (fire and forget, from a dragstart handler), plus forwarding core events to every window.
import { BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import type { CoreHost } from '../core/contracts';
import type { BoogieEventName } from '../shared/api';
import type { AppCtx } from './appApi';
import type { createDispatcher } from './dispatch';
import type { Windows } from './windows';

/** Every name in BoogieEvents. The type check below fails the build if the contract gains one we forget. */
export const EVENT_NAMES = [
  'library',
  'itemsChanged',
  'itemsAdded',
  'itemsRemoved',
  'counts',
  'job',
  'history',
  'status',
  // Sent by the app itself (eagle:// links, the Eagle API's /item links); the core never emits it.
  'reveal',
] as const satisfies readonly BoogieEventName[];
const _allEventsListed: Exclude<BoogieEventName, (typeof EVENT_NAMES)[number]> extends never
  ? true
  : never = true;
void _allEventsListed;

export function registerIpc(o: {
  host: CoreHost;
  windows: Windows;
  dispatch: ReturnType<typeof createDispatcher<AppCtx>>;
}): () => void {
  const { host, windows, dispatch } = o;

  /** Only our own pages may call in. Anything else (a stray frame, a navigated window) is refused. */
  function contextFor(e: IpcMainInvokeEvent | IpcMainEvent): AppCtx {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || !windows.isOwnUrl(e.senderFrame?.url)) throw new Error('That request was refused.');
    return { win, sender: e.sender };
  }

  ipcMain.handle('boogie:invoke', async (e, method: unknown, args: unknown) => {
    try {
      return await dispatch(contextFor(e), method, args);
    } catch (err) {
      console.warn(`[ipc] ${String(method)} failed:`, err);
      // Only the message crosses the process boundary: no stack, no odd properties.
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.on('boogie:startDrag', (e, ids: unknown) => {
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return;
    try {
      dispatch(contextFor(e), 'startDrag', [ids]).catch((err) =>
        console.warn('[ipc] startDrag failed:', err),
      );
    } catch (err) {
      console.warn('[ipc] startDrag refused:', err);
    }
  });

  const unsubscribers = EVENT_NAMES.map((name) =>
    host.on(name, (payload) => windows.broadcast(name, payload)),
  );

  return () => {
    ipcMain.removeHandler('boogie:invoke');
    ipcMain.removeAllListeners('boogie:startDrag');
    for (const off of unsubscribers) off();
  };
}
