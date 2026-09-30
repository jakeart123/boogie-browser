// Routes one `boogie:invoke` call: AppApi methods run here in the app, everything else goes to
// the core's CoreApi. Plain Node (no electron import); ipc.ts wires it to ipcMain.
import { APP_API_METHODS, type AppApi } from '../shared/api';
import type { JobProgress } from '../shared/types';

/** What an app method needs to know about who is calling. `Ctx` is the electron-side context. */
export type AppMethods<Ctx> = {
  [K in (typeof APP_API_METHODS)[number]]: (
    ctx: Ctx,
    ...args: Parameters<AppApi[K]>
  ) => ReturnType<AppApi[K]> | Awaited<ReturnType<AppApi[K]>>;
};

export interface DispatchDeps<Ctx> {
  api: object;
  app: AppMethods<Ctx>;
  /** Export jobs live in the app, not the core: cancelJob and listJobs have to know about them. */
  exports: { cancel(jobId: string): boolean; list(): JobProgress[] };
  /** Called after settings change (servers may need to start or stop). */
  onSettingsChanged(): void;
}

const APP_METHOD_SET: ReadonlySet<string> = new Set(APP_API_METHODS);

/** A method the renderer may call on the core: a real function, not something inherited from Object. */
function coreMethod(api: object, method: string): ((...args: unknown[]) => unknown) | null {
  if (method in Object.prototype || method.startsWith('_')) return null; // __proto__, constructor, toString...
  const fn = (api as Record<string, unknown>)[method];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown).bind(api) : null;
}

export function createDispatcher<Ctx>(deps: DispatchDeps<Ctx>) {
  return async function dispatch(ctx: Ctx, method: unknown, args: unknown): Promise<unknown> {
    if (typeof method !== 'string' || !Array.isArray(args))
      throw new Error('That request was not understood.');

    if (APP_METHOD_SET.has(method)) {
      const fn = deps.app[method as keyof AppMethods<Ctx>] as (
        ctx: Ctx,
        ...a: unknown[]
      ) => unknown;
      return fn(ctx, ...args);
    }

    if (method === 'cancelJob' && typeof args[0] === 'string' && deps.exports.cancel(args[0]))
      return undefined;
    const fn = coreMethod(deps.api, method);
    if (!fn) throw new Error(`Unknown method: ${method.slice(0, 60)}`);

    const result = await fn(...args);
    if (method === 'listJobs' && Array.isArray(result)) return [...result, ...deps.exports.list()];
    if (method === 'setSettings') deps.onSettingsChanged();
    return result;
  };
}
