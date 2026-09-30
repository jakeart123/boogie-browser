/// <reference lib="dom" />
// Exposes the one bridge the renderer uses. Keep it tiny: everything else is `invoke`.
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { BoogieBridge, BoogieEventName } from '../shared/api';

const params = new URLSearchParams(location.search);
const item = params.get('item');
// The reference window's step list (windows.ts only sends it when there is more than one item).
const items = params.get('items')?.split(',').filter(Boolean) ?? [];

const bridge: BoogieBridge = {
  // Electron wraps errors as "Error invoking remote method 'boogie:invoke': Error: <msg>"; keep just <msg>.
  invoke: (method, args) =>
    ipcRenderer.invoke('boogie:invoke', method, args).catch((e: unknown) => {
      const msg = String((e as Error)?.message ?? e);
      throw new Error(msg.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ''));
    }),
  on: (event: BoogieEventName, fn) => {
    const listener = (_e: unknown, payload: unknown) => fn(payload);
    ipcRenderer.on(`boogie:event:${event}`, listener);
    return () => ipcRenderer.removeListener(`boogie:event:${event}`, listener);
  },
  getPathForFile: (file) => webUtils.getPathForFile(file),
  startDrag: (ids) => ipcRenderer.send('boogie:startDrag', ids),
  windowKind: {
    kind: params.get('window') === 'reference' ? 'reference' : 'main',
    itemId: item,
    itemIds: items.length ? items : item ? [item] : [],
  },
};

contextBridge.exposeInMainWorld('boogie', bridge);
