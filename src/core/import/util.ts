// Small helpers for the import pipeline. Nothing here touches a library.
import { basename, extname, resolve, sep } from 'node:path';

/** True when `child` is `parent` or lives somewhere under it (both made absolute first). */
export function isInside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Files we never import: hidden files, OS droppings, half-finished downloads, our own temp files. */
const PARTIAL_EXTS = new Set(['crdownload', 'aria', 'aria2', 'part', 'download', 'tmp']);
export function isIgnoredName(name: string): boolean {
  const lower = name.toLowerCase();
  if (name.startsWith('.') || name.startsWith('~$')) return true;
  if (lower === 'desktop.ini' || lower === 'thumbs.db') return true;
  return PARTIAL_EXTS.has(extname(lower).slice(1));
}
export function isPartialExt(ext: string): boolean {
  return PARTIAL_EXTS.has(ext.toLowerCase());
}

/** `photo.JPG` -> `photo`. A name with no extension comes back unchanged. */
export function nameWithoutExt(fileName: string): string {
  const base = basename(fileName);
  const ext = extname(base);
  return ext && ext !== base ? base.slice(0, -ext.length) : base;
}

// Extensions that mean the same content type, so `Photo.jpeg` saved as a jpg drops `.jpeg` too.
const ALIASES: Record<string, string[]> = {
  jpg: ['jpg', 'jpeg', 'jpe', 'jfif'],
  tif: ['tif', 'tiff'],
  tiff: ['tif', 'tiff'],
  heic: ['heic', 'heif', 'hif'],
};

/**
 * For a name the caller chose (a page title, an explicit name): drop a trailing `.ext` only when it
 * is the detected extension (or an alias), so "Photo 1.5" or "v2.0 mockup" keep their dots.
 */
export function stripKnownExt(name: string, ext: string): string {
  const options = ALIASES[ext] ?? [ext];
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name;
  return options.includes(name.slice(dot + 1).toLowerCase()) ? name.slice(0, dot) : name;
}

/** `Clipboard - YYYY-MM-DD HH.mm.ss` in local time, Eagle's name for a pasted image. */
export function clipboardName(when: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}`;
  const time = `${p(when.getHours())}.${p(when.getMinutes())}.${p(when.getSeconds())}`;
  return `Clipboard - ${date} ${time}`;
}

/** Short plain-English reason for a failed file. */
export function reasonOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT') return 'file not found';
  if (code === 'EACCES' || code === 'EPERM') return 'no permission to read this file';
  if (code === 'ENOSPC') return 'the disk is full';
  return err instanceof Error ? err.message : String(err);
}
