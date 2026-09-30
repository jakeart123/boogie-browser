// Drag and drop on the grid. Out: tiles start a drag of the selection. In: files and folders from
// other apps are imported (a folder keeps its tree, as in Eagle), links are imported by URL, and
// our own tiles dropped inside a folder reorder it (manual order).
import { api } from '../../lib/api';
import { beginItemDrag, dragHasPayload, ownDragIds, readDrop } from '../../lib/dnd';
import { canEdit, fail } from '../../lib/edit';
import { currentFolderId, importPaths, importUrl } from '../../lib/files';
import { library } from '../../lib/stores/library.svelte';
import { selection } from '../../lib/stores/selection.svelte';
import { view } from '../../lib/stores/view.svelte';
import * as act from './actions';
import { dropTarget, type DropTarget } from './layout';
import { contentPoint, type GridParts } from './rubberBand.svelte';

export class GridDrop {
  /** Something importable is over the grid: the whole grid lights up. */
  active = $state(false);
  /** Our own tiles over a folder: where they would land. */
  bar = $state<DropTarget | null>(null);

  constructor(private g: GridParts & { hasSubfolders(): boolean }) {}

  start(e: DragEvent, id: string): void {
    if (!selection.has(id)) selection.select(id, 'replace');
    beginItemDrag(e, [...selection.ids]);
  }

  clear(): void {
    if (this.active) this.active = false;
    if (this.bar) this.bar = null;
  }

  over(e: DragEvent): void {
    const scroller = this.g.scroller();
    if (!dragHasPayload(e) || !scroller) return;
    const own = !!ownDragIds();
    const reorder = own && view.scope.kind === 'folder';
    if (own && !reorder) return; // dropping our own items on a non-folder view does nothing
    e.preventDefault(); // accept the drop even when read-only: the drop handler says why nothing happened
    if (e.dataTransfer) e.dataTransfer.dropEffect = reorder ? 'move' : 'copy';
    this.active = !own && !library.readOnly;
    const spacer = this.g.spacer();
    if (own && spacer && !library.readOnly) {
      const p = contentPoint(spacer, e.clientX, e.clientY, this.g.shift());
      this.bar = dropTarget(this.g.layout(), p.x, p.y);
    } else this.bar = null;
    // Scroll while dragging near the top or bottom edge.
    const r = scroller.getBoundingClientRect();
    if (e.clientY < r.top + 50) scroller.scrollTop -= 14;
    else if (e.clientY > r.bottom - 50) scroller.scrollTop += 14;
  }

  leave(e: DragEvent, root: HTMLElement | undefined): void {
    if (root?.contains(e.relatedTarget as Node | null)) return;
    this.clear();
  }

  async drop(e: DragEvent): Promise<void> {
    const bar = this.bar;
    this.clear();
    const drop = readDrop(e, library.state?.ref.path ?? null);
    if (!drop) return;
    e.preventDefault();
    if (!canEdit()) return; // says "Read-only: ..." instead of silently ignoring the drop
    if (drop.kind === 'files')
      return importPaths(drop.paths, currentFolderId(), {
        keepFolderStructure: true,
        folders: drop.folders,
      });
    if (drop.kind === 'url') return importUrl(drop.url);
    if (view.scope.kind !== 'folder' || !bar) return;
    const ids = this.g.ids();
    const moving = new Set(drop.ids);
    const here = drop.ids.length === 1 ? ids.indexOf(drop.ids[0]) : -1;
    if (here >= 0 && (bar.index === here || bar.index === here + 1)) return; // dropped where it already is
    // Keep the moved items in the order they are shown, whatever order they were selected in.
    let moved = drop.ids;
    if (moved.length > 1) {
      const pos = new Map(ids.map((id, i) => [id, i]));
      moved = [...moved].sort((a, b) => (pos.get(a) ?? 0) - (pos.get(b) ?? 0));
    }
    try {
      await act.reorder(moved, await this.beforeIdFor(bar.index, moving));
    } catch (err) {
      fail(err);
    }
  }

  /**
   * The item the moved ones should land before: the first tile after the gap that isn't being
   * moved. Manual order only exists inside the folder itself, so when subfolder contents are
   * shown, skip the tiles that belong only to subfolders (asking the core for the folder's own
   * items once, however far that run goes). Null means the end of the folder.
   */
  private async beforeIdFor(from: number, moving: Set<string>): Promise<string | null> {
    const scope = view.scope;
    const ids = this.g.ids();
    let own: Set<string> | null = null;
    if (scope.kind === 'folder' && scope.includeSubfolders && this.g.hasSubfolders()) {
      const r = await api.query({
        scope: { kind: 'folder', id: scope.id, includeSubfolders: false },
        filter: {},
        sort: null,
      });
      own = new Set(r.ids);
    }
    for (let k = from; k < ids.length; k++)
      if (!moving.has(ids[k]) && (!own || own.has(ids[k]))) return ids[k];
    return null;
  }
}
