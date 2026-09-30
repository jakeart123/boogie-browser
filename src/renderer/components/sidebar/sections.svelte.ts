// Which sidebar sections are open. One remembered set for the whole app (not per library).
import { readJSON, writeJSON } from '../../lib/storage';

const SECTIONS_KEY = 'sidebar.sections';

export type SectionId = 'quick' | 'smart' | 'tags' | 'folders';

class Sections {
  // Tags start collapsed (spec); everything else open.
  open = $state<Record<SectionId, boolean>>({
    quick: true,
    smart: true,
    tags: false,
    folders: true,
    ...readJSON<Partial<Record<SectionId, boolean>>>(SECTIONS_KEY, {}),
  });

  toggle(id: SectionId): void {
    this.open[id] = !this.open[id];
    writeJSON(SECTIONS_KEY, $state.snapshot(this.open));
  }
}

export const sections = new Sections();
