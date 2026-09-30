import { randomInt } from 'node:crypto';

const B36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Eagle's id: base36(Date.now()) uppercased and padded to 8 chars (the first 8 chars decode to
 * the creation time), plus 5 random base36 chars. 13 chars of [0-9A-Z]. Folders, smart folders,
 * tag groups and comments use the same generator.
 */
export function guid(now: number = Date.now()): string {
  let rand = '';
  for (let i = 0; i < 5; i++) rand += B36[randomInt(36)];
  return now.toString(36).toUpperCase().padStart(8, '0') + rand;
}

/**
 * An item folder id: 13 chars (Eagle) or 36 chars (legacy UUID). Anything else is ignored by
 * Eagle's loader and watchers. The character class also keeps an id from ever being a path
 * (`../x`), because ids are joined into file paths.
 */
export function isItemId(s: unknown): s is string {
  return (
    typeof s === 'string' && (s.length === 13 || s.length === 36) && /^[A-Za-z0-9_-]+$/.test(s)
  );
}

export function assertItemId(id: string): void {
  if (!isItemId(id)) throw new Error(`Not a valid item id: ${JSON.stringify(id)}`);
}
