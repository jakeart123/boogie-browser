// Watching the library, Dropbox conflicted copies, Dropbox status, and detecting a Wine Eagle.
export { createWatcher, type WatcherOptions, type PokeableWatcher } from './watcher';
export {
  createEagleMonitor,
  wineToPosix,
  isEagleCommandLine,
  type EagleMonitorOptions,
} from './eagleMonitor';
export { createDropboxStatus, parseDropboxStatus, type DropboxStatusOptions } from './dropbox';
export { findConflictFiles, scanItemConflicts, conflictBaseName } from './conflicts';
