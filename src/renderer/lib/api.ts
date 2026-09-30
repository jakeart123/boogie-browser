// The renderer's only door to the app. `api.someMethod(...)` works the same in Electron
// (window.boogie bridge -> IPC) and in the web dev server (the real core over fetch, see
// scripts/dev-backend.ts).
import type { BoogieApi, BoogieBridge, BoogieEventName, BoogieEvents } from '../../shared/api';

declare global {
  interface Window {
    boogie?: BoogieBridge;
  }
}

const bridge = typeof window !== 'undefined' ? window.boogie : undefined;
export const inElectron = !!bridge;

/** JSON can't carry bytes: send them as base64 (the dev server turns them back). */
function bytesAsBase64(_key: string, value: unknown): unknown {
  if (!(value instanceof Uint8Array)) return value;
  let s = '';
  for (let i = 0; i < value.length; i += 0x8000)
    s += String.fromCharCode(...value.subarray(i, i + 0x8000));
  return { $bytes: btoa(s) };
}

async function devInvoke(method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch('/__dev/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, args }, bytesAsBase64),
  });
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(body.error ?? `${method} failed`);
  return body.result;
}

const invoke = bridge ? bridge.invoke.bind(bridge) : devInvoke;

// Web-only fallbacks for the few synchronous bridge calls.
const local: Partial<BoogieApi> = {
  getPathForFile: (file: File) => (bridge ? bridge.getPathForFile(file) : file.name),
  startDrag: (ids: string[]) =>
    bridge ? bridge.startDrag(ids) : console.info('[dev] startDrag (desktop only)', ids),
};

export const api = new Proxy({} as BoogieApi, {
  get(_t, method: string) {
    if (method in local) return (local as Record<string, unknown>)[method];
    return (...args: unknown[]) => invoke(method, args);
  },
});

type Handler<K extends BoogieEventName> = (payload: BoogieEvents[K]) => void;
const devHandlers = new Map<string, Set<(p: unknown) => void>>();
let devSource: EventSource | null = null;

/** Subscribe to a main-process event. Returns an unsubscribe function. */
export function on<K extends BoogieEventName>(event: K, fn: Handler<K>): () => void {
  if (bridge) return bridge.on(event, fn as (p: unknown) => void);
  if (!devSource && typeof EventSource !== 'undefined') {
    devSource = new EventSource('/__dev/events');
    devSource.onmessage = (e) => {
      const { event: name, payload } = JSON.parse(e.data);
      devHandlers.get(name)?.forEach((h) => h(payload));
    };
  }
  let set = devHandlers.get(event);
  if (!set) devHandlers.set(event, (set = new Set()));
  set.add(fn as (p: unknown) => void);
  return () => set!.delete(fn as (p: unknown) => void);
}

const search = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
export const windowKind = bridge?.windowKind ?? {
  kind: search.get('window') === 'reference' ? ('reference' as const) : ('main' as const),
  itemId: search.get('item'),
};
