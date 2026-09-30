// The ONE place the app imports the core. Everything else in src/app talks to a `CoreHost`.
import type { AppPaths, CoreHost } from '../core/contracts';
import { startEagleCompatServer } from '../core/http';
import { startMcpServer } from '../core/mcp';
import { createCoreHost } from '../core/service';
import type { ServerStarters } from './servers';

export { appPaths } from '../core/paths';

export async function openHost(paths: AppPaths): Promise<CoreHost> {
  return createCoreHost({ paths });
}

export const serverStarters: ServerStarters = { startEagleCompatServer, startMcpServer };
