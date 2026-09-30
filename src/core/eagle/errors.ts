// Typed errors of the Eagle adapter. The service maps these to plain-English messages.
// (WriteBlockedError lives in src/core/safety/writeGuard.ts and is thrown by every write.)
import type { ItemWrite } from '../contracts';

/** The library's root metadata.json is missing or won't parse (after retries). Never repaired. */
export class LibraryUnreadableError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`Library file is unreadable (${reason}): ${path}`);
    this.name = 'LibraryUnreadableError';
  }
}

/** A write was attempted on a library opened read-only. */
export class ReadOnlyError extends Error {
  constructor(what = 'write') {
    super(`This library is open read-only, so ${what} was refused.`);
    this.name = 'ReadOnlyError';
  }
}

/** Root metadata.json has no applicationVersion, or one newer than we support. */
export class UnsupportedVersionError extends Error {
  constructor(
    readonly applicationVersion: string | null,
    readonly supported: string,
  ) {
    super(
      applicationVersion
        ? `Library was saved by a newer Eagle (${applicationVersion}); Boogie supports up to ${supported}.`
        : 'Library metadata has no applicationVersion, so it is not safe to write.',
    );
    this.name = 'UnsupportedVersionError';
  }
}

/** An item folder or its metadata.json is missing. */
export class ItemNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Item ${id} was not found in this library.`);
    this.name = 'ItemNotFoundError';
  }
}

/** An item's metadata.json exists but can't be parsed (damaged, or still syncing). Never overwritten. */
export class ItemUnreadableError extends Error {
  constructor(
    readonly id: string,
    readonly reason: string,
  ) {
    super(`Item ${id} can't be read (${reason}), so it was left untouched.`);
    this.name = 'ItemUnreadableError';
  }
}

/** Either kind of "can't edit this item right now": callers may skip these and carry on. */
export function isSkippableItemError(err: unknown): err is ItemNotFoundError | ItemUnreadableError {
  return err instanceof ItemNotFoundError || err instanceof ItemUnreadableError;
}

/**
 * `updateItems` hit a hard error (disk full, write blocked) after some items were already written.
 * Those are on disk, journaled and raised in mtime.json, so the caller must still apply `writes`
 * (index them, commit the journal group) before passing the error on. `cause` is the original error.
 */
export class PartialWriteError extends Error {
  constructor(
    readonly writes: ItemWrite[],
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'PartialWriteError';
  }
}
