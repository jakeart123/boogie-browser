// Drag and drop on the folder tree: dragging a folder to reorder or nest it, and dropping items,
// files or a link onto a folder. The tree owns the DOM; this owns the drag state and the rules.
import { dragHasPayload } from '../../lib/dnd';
import { canEdit } from '../../lib/edit';
import { library } from '../../lib/stores/library.svelte';
import type { FolderNode } from '../../../shared/types';
import * as act from './actions';
import { expanded } from './expanded.svelte';
import { moveTarget, zoneAt, type Row, type Zone } from './tree';

/** Marks a folder dragged inside the tree (the browser hides drag data until the drop). */
const FOLDER_MIME = 'application/x-boogie-folder';
/** Hovering the middle of a closed folder this long opens it so you can drop deeper. */
const OPEN_AFTER_MS = 600;

export class FolderDnd {
  /** The row under the pointer and where on it (drives the highlight). */
  hover = $state<{ id: string; zone: Zone } | null>(null);
  /** The folder being dragged, if the drag started in this tree. */
  dragId = $state<string | null>(null);
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private ctx: {
      roots: () => FolderNode[];
      readOnly: () => boolean;
      tree: () => HTMLElement | null;
    },
  ) {}

  private clearHover() {
    this.hover = null;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private setHover(row: Row<FolderNode>, zone: Zone) {
    if (this.hover?.id === row.node.id && this.hover.zone === zone) return;
    this.hover = { id: row.node.id, zone };
    clearTimeout(this.timer);
    if (zone === 'inside' && row.hasChildren && !row.open) {
      const id = row.node.id;
      this.timer = setTimeout(() => {
        if (this.hover?.id === id && this.hover.zone === 'inside') expanded.toggle(id, true);
      }, OPEN_AFTER_MS);
    }
  }

  /** Our own folder drag (a stale dragId doesn't count if the drag in flight is something else). */
  private isFolderDrag(e: DragEvent) {
    return !!this.dragId && !!e.dataTransfer?.types.includes(FOLDER_MIME);
  }

  start = (e: DragEvent, node: FolderNode) => {
    if (this.ctx.readOnly() || !e.dataTransfer) return e.preventDefault();
    this.dragId = node.id;
    e.dataTransfer.setData(FOLDER_MIME, node.id);
    e.dataTransfer.effectAllowed = 'move';
  };

  end = () => {
    this.dragId = null;
    this.clearHover();
  };

  over = (e: DragEvent, row: Row<FolderNode>) => {
    if (this.ctx.readOnly()) {
      // Take the drop so the window doesn't navigate to a dropped file; refuse it in the cursor.
      if (dragHasPayload(e)) (e.preventDefault(), (e.dataTransfer!.dropEffect = 'none'));
      return;
    }
    if (this.isFolderDrag(e)) {
      const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const zone = zoneAt(e.clientY - box.top, box.height);
      // Refused (itself, its own descendant, no change): no preventDefault, so no drop and no highlight.
      if (!moveTarget(library.folders, this.ctx.roots(), this.dragId!, row.node.id, zone)) {
        return this.clearHover();
      }
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';
      this.setHover(row, zone);
    } else if (dragHasPayload(e)) {
      e.preventDefault();
      e.dataTransfer!.dropEffect = e.shiftKey ? 'move' : 'copy';
      this.setHover(row, 'inside');
    }
  };

  /** The pointer left the whole tree (moving between rows doesn't count). */
  leave = (e: DragEvent) => {
    if (!this.ctx.tree()?.contains(e.relatedTarget as Node | null)) this.clearHover();
  };

  drop = async (e: DragEvent, row: Row<FolderNode>) => {
    e.preventDefault();
    if (this.ctx.readOnly()) return void canEdit(); // says why nothing happened
    const zone = this.hover?.zone ?? 'inside';
    const folderDrag = this.isFolderDrag(e);
    const id = this.dragId;
    this.end();
    if (folderDrag && id) {
      const t = moveTarget(library.folders, this.ctx.roots(), id, row.node.id, zone);
      if (!t) return;
      if (t.parentId) expanded.add([t.parentId]);
      await act.moveFolder(id, t.parentId, t.index, t.parentId !== library.folder(id)?.parentId);
    } else {
      // The browser empties the drop data once this handler returns, so act.dropOnFolder reads it
      // synchronously, before its first await.
      await act.dropOnFolder(e, row.node.id);
    }
  };
}
