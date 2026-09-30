// The one Eagle preference the browser extension switches through the API: whether it shows its
// own "choose folder and tags" window before saving (`/api/preferences/collect/on|off`). Eagle
// keeps it in its preferences; we keep it in a small file next to Boogie's settings.
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class CompatPrefs {
  showCollectModal = false;

  constructor(private file: string) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { showCollectModal?: unknown };
      this.showCollectModal = saved.showCollectModal === true;
    } catch {
      /* no file yet, or a damaged one: Eagle's default (off) */
    }
  }

  async setCollect(on: boolean): Promise<void> {
    this.showCollectModal = on;
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify({ showCollectModal: on }));
    await rename(tmp, this.file);
  }
}
