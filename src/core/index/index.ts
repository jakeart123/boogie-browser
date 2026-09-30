// SQLite index for one library. See docs/specs/index.md.
import type { IndexFactory } from '../contracts';
import { openIndex } from './open';

export const indexes: IndexFactory = { open: (ref, opts) => openIndex(ref, opts) };

export { projectRecord } from './project';
export type { FolderLookup, FtsRow, ItemRow, PaletteRow, ProjectedRecord } from './project';
export { flattenFolders } from './folders';
export { openIndex, SCHEMA_VERSION } from './open';
export { SqliteLibraryIndex } from './libraryIndex';
export type { HashRow, IndexFs, IndexOpenOptions, SyncDelta, VerifyOptions } from './libraryIndex';
