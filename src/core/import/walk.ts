// Turns the paths a user dropped into a flat, ordered list of files to import (and, when the
// folder structure is kept, the directory tree to mirror as Eagle folders). Read-only.
import type { Dirent } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DirNode } from './folders';
import { isIgnoredName, isInside, reasonOf } from './util';

export interface PlanFile {
  src: string;
  /** The directory this file sits in when the structure is kept; null = goes to the target folder. */
  dir: DirNode | null;
}

export interface Plan {
  files: PlanFile[];
  /** Top-level directories to mirror (only when the structure is kept). */
  roots: DirNode[];
  /** Paths that could not be used at all, with a plain-English reason. */
  failed: { source: string; reason: string }[];
}

const byName = (a: Dirent, b: Dirent) => a.name.localeCompare(b.name, undefined, { numeric: true });
const isLibraryDir = (name: string) => name.toLowerCase().endsWith('.library');

export async function buildPlan(
  paths: string[],
  keepStructure: boolean,
  libraryRoot: string,
  signal?: AbortSignal,
): Promise<Plan> {
  const plan: Plan = { files: [], roots: [], failed: [] };
  const visited = new Set<string>(); // real paths of folders entered, so symlink loops end

  async function walk(dir: string, name: string): Promise<DirNode> {
    const node: DirNode = { path: dir, name, files: [], dirs: [] };
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      plan.failed.push({ source: dir, reason: `could not open this folder (${reasonOf(e)})` });
      return node;
    }
    entries.sort(byName);
    for (const entry of entries) {
      if (signal?.aborted) break;
      if (isIgnoredName(entry.name)) continue;
      const full = join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const s = await stat(full);
          isDir = s.isDirectory();
          isFile = s.isFile();
        } catch {
          continue; // dangling link
        }
      }
      if (isDir) {
        if (isLibraryDir(entry.name)) continue; // never descend into an Eagle library
        const real = await realpath(full).catch(() => full);
        if (visited.has(real)) continue;
        visited.add(real);
        node.dirs.push(await walk(full, entry.name));
      } else if (isFile) {
        node.files.push(full);
      }
    }
    return node;
  }

  const count = (n: DirNode): number =>
    n.files.length + n.dirs.reduce((sum, d) => sum + count(d), 0);
  // Drop directories with nothing to import so we don't litter the library with empty folders.
  const prune = (n: DirNode) => {
    n.dirs = n.dirs.filter((d) => count(d) > 0);
    n.dirs.forEach(prune);
  };
  const flatten = (n: DirNode, keep: boolean) => {
    for (const src of n.files) plan.files.push({ src, dir: keep ? n : null });
    for (const d of n.dirs) flatten(d, keep);
  };

  for (const source of paths) {
    if (signal?.aborted) break;
    let s;
    try {
      s = await stat(source);
    } catch (e) {
      plan.failed.push({ source, reason: reasonOf(e) });
      continue;
    }
    // Anything inside the library we are importing into is refused up front, once.
    const here = await realpath(source).catch(() => source);
    if (isInside(here, await realpath(libraryRoot).catch(() => libraryRoot))) {
      plan.failed.push({ source, reason: 'this is already in the library' });
      continue;
    }
    const name =
      source
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .pop() ?? source;
    if (s.isDirectory()) {
      if (isLibraryDir(name)) {
        plan.failed.push({
          source,
          reason: 'this is an Eagle library, open it instead of importing it',
        });
        continue;
      }
      const real = await realpath(source).catch(() => source);
      visited.add(real);
      const node = await walk(source, name);
      if (count(node) === 0) {
        plan.failed.push({ source, reason: 'no files to import in this folder' });
        continue;
      }
      prune(node);
      if (keepStructure) plan.roots.push(node);
      flatten(node, keepStructure);
    } else if (s.isFile()) {
      if (isIgnoredName(name))
        plan.failed.push({ source, reason: 'skipped: hidden or system file' });
      else plan.files.push({ src: source, dir: null });
    } else {
      plan.failed.push({ source, reason: 'not a file or folder' });
    }
  }
  return plan;
}
