// The service: the glue between the UI / HTTP API / MCP and every other core module.
import type { Actor } from '../../shared/types';
import { appPaths } from '../paths';
import type { AppPaths, CoreHost } from '../contracts';
import { createKnownStore } from '../libraries/known';
import { createSettingsStore } from '../libraries/settings';
import type { DiscoveryOptions } from '../libraries/discovery';
import { makeApi } from './api';
import type { CoreDeps } from './deps';
import { CoreService } from './host';

export type { CoreDeps, EagleHelpers } from './deps';

export interface CreateCoreHostOptions {
  paths?: AppPaths;
  deps?: Partial<CoreDeps>;
  /** Where first-run discovery looks (tests point this at fake folders). Default: the real ones, read-only. */
  discovery?: DiscoveryOptions & { home?: string };
}

/** The actor for everything the UI does. */
export const USER: Actor = { kind: 'user', name: 'You' };

const DEP_KEYS: (keyof CoreDeps)[] = [
  'eagle',
  'indexes',
  'queries',
  'createJournal',
  'createMedia',
  'createWatcher',
  'eagleMonitor',
  'dropbox',
  'importers',
  'dupes',
  'helpers',
];

export async function createCoreHost(opts: CreateCoreHostOptions = {}): Promise<CoreHost> {
  const paths = opts.paths ?? appPaths();
  const given = opts.deps ?? {};
  let svc: CoreService | undefined;
  // The real modules are only loaded when something wasn't supplied.
  const base: Partial<CoreDeps> = DEP_KEYS.every((k) => given[k] !== undefined)
    ? {}
    : (await import('./defaultDeps')).makeDefaultDeps({
        selfPort: () => svc?.eagleApiPort() ?? null,
      });
  const deps = { ...base, ...given } as CoreDeps;

  const settings = createSettingsStore(paths.config);
  await settings.load();
  const known = createKnownStore({
    configDir: paths.config,
    home: opts.discovery?.home,
    discovery: opts.discovery,
  });
  const service = (svc = new CoreService(paths, deps, settings, known));

  return {
    api: makeApi(service, USER),
    as: (actor) => makeApi(service, actor),
    on: (event, fn) => service.on(event, fn),
    resolveFile: (kind, libraryId, itemId) => service.resolveFile(kind, libraryId, itemId),
    originalPath: (itemId) => service.originalPath(itemId),
    setPorts: (ports) => service.setPorts(ports),
    setAgentActivity: (list) => service.setAgentActivity(list),
    isAgentPaused: (name) => service.agentPauses.isPaused(name),
    paths,
    close: () => service.close(),
  };
}
