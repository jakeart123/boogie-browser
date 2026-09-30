// The Eagle format adapter: the ONLY code that reads or writes files inside a library.
export { eagleLibraries, openLibrary } from './library';
export type { EagleAdapter, EagleOpenOptions } from './library';
export { createLibrary, probeLibrary } from './create';
export * from './errors';
export { guid, isItemId } from './ids';
export { sanitizeItemName, sanitizeFolderName, capUtf8 } from './names';
export * from './edits';
export * from './root';
export * from './order';
export { SUPPORTED_APP_VERSION, isSupportedVersion } from './version';
export { conflictedCopyBase, isConflictedCopy } from './read';
export { serialize, parseJson } from './json';
export {
  childPath,
  itemDir,
  metadataPath,
  originalPath,
  thumbnailPath,
  itemMetadataRel,
  thumbnailJournalRel,
  thumbnailJournalId,
} from './paths';
export { SKEW_MARGIN_MS, isBoogieStamp, isBoogieWrite } from './stamp';
