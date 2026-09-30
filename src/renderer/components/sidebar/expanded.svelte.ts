// Which folders (and smart folders) are open, remembered per library in localStorage
// (key boogie.expanded.<libraryId>). Shared by the folder tree and the smart folder list.
import { readJSON, writeJSON } from '../../lib/storage';

const expandedKey = (libraryId: string) => `expanded.${libraryId}`;

class Expanded {
  /** Replace, never mutate: the tree rebuilds its rows when this changes. */
  set = $state.raw<Set<string>>(new Set());
  private libraryId = '';

  /** Switch to a library's saved state. Safe to call from every effect that needs it. */
  load(libraryId: string): void {
    if (libraryId === this.libraryId) return;
    this.libraryId = libraryId;
    this.set = new Set(readJSON<string[]>(expandedKey(libraryId), []));
  }

  replace(next: Set<string>): void {
    this.set = next;
    writeJSON(expandedKey(this.libraryId), [...next]);
  }

  add(ids: string[]): void {
    if (ids.every((id) => this.set.has(id))) return;
    this.replace(new Set([...this.set, ...ids]));
  }

  toggle(id: string, open = !this.set.has(id)): void {
    const next = new Set(this.set);
    if (open) next.add(id);
    else next.delete(id);
    this.replace(next);
  }
}

export const expanded = new Expanded();
