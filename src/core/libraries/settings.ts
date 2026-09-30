// App settings at <config>/settings.json. The writable roots are the safety switch for real
// libraries, so every load and every change pushes them into the write guard.
import { isAbsolute, join, resolve } from 'node:path';
import type { AppSettings } from '../../shared/types';
import { setWritableRoots } from '../safety/writeGuard';
import { readJsonFile, writeFileAtomic } from './fsutil';

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  layout: 'justified',
  thumbSize: 190,
  showNames: true,
  showMeta: true,
  showSubfolderContents: true,
  doubleClickAction: 'detail',
  eagleCompatApi: true,
  mcpEnabled: true,
  mcpPort: 41597,
  writableRoots: [],
  bulkConfirmThreshold: 500,
  windowsNameMaxChars: 120,
};

type Check = (v: unknown) => unknown; // returns the cleaned value, or undefined when invalid

const oneOf =
  (...allowed: string[]): Check =>
  (v) =>
    typeof v === 'string' && allowed.includes(v) ? v : undefined;
const bool: Check = (v) => (typeof v === 'boolean' ? v : undefined);
const int =
  (min: number, max: number): Check =>
  (v) =>
    typeof v === 'number' && Number.isFinite(v)
      ? Math.min(max, Math.max(min, Math.round(v)))
      : undefined;
const roots: Check = (v) => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return undefined;
  const clean = (v as string[]).map((x) => x.trim()).filter(Boolean);
  if (clean.some((x) => !isAbsolute(x))) return undefined;
  return [...new Set(clean.map((x) => resolve(x)))];
};

const CHECKS: { [K in keyof AppSettings]-?: Check } = {
  theme: oneOf('dark', 'light', 'system'),
  layout: oneOf('justified', 'masonry', 'grid', 'list'),
  thumbSize: int(60, 1000),
  showNames: bool,
  showMeta: bool,
  showSubfolderContents: bool,
  doubleClickAction: oneOf('detail', 'reference', 'open'),
  eagleCompatApi: bool,
  mcpEnabled: bool,
  mcpPort: int(0, 65535),
  writableRoots: roots,
  bulkConfirmThreshold: int(1, 1_000_000),
  windowsNameMaxChars: int(20, 255),
};

/**
 * Merge `input` onto `base`. Unknown keys are dropped (so a settings.json from an older build, say
 * with the removed `autoHealStaleOverwrites`, loads cleanly and loses the key on the next save). A bad value is ignored when reading the
 * file (so a hand-edited typo can't brick the app) and rejected when the UI sets it.
 */
export function mergeSettings(base: AppSettings, input: unknown, strict: boolean): AppSettings {
  const next: Record<string, unknown> = { ...base };
  if (input && typeof input === 'object') {
    for (const key of Object.keys(CHECKS) as (keyof AppSettings)[]) {
      const raw = (input as Record<string, unknown>)[key];
      if (raw === undefined) continue;
      const clean = CHECKS[key](raw);
      if (clean === undefined) {
        if (strict) throw new Error(`"${key}" has a value that is not allowed.`);
        continue;
      }
      next[key] = clean;
    }
  }
  return next as unknown as AppSettings;
}

export interface SettingsStore {
  get(): AppSettings;
  load(): Promise<AppSettings>;
  update(patch: Partial<AppSettings>): Promise<AppSettings>;
}

export function createSettingsStore(configDir: string): SettingsStore {
  const file = join(configDir, 'settings.json');
  let current: AppSettings = { ...DEFAULT_SETTINGS };
  return {
    get: () => current,
    async load() {
      current = mergeSettings(DEFAULT_SETTINGS, await readJsonFile(file), false);
      setWritableRoots(current.writableRoots);
      return current;
    },
    async update(patch) {
      const next = mergeSettings(current, patch, true);
      await writeFileAtomic(file, JSON.stringify(next, null, 2) + '\n');
      current = next;
      setWritableRoots(current.writableRoots);
      return current;
    },
  };
}
