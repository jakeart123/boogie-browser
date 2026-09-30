// Undo: agents can revert the changes agents made, never the user's or the partner's.
import { z } from 'zod';
import type { HistoryEntry } from '../../../shared/types';
import { UserError } from '../errors';
import { type Tool, writableLibrary } from '../kit';

export function registerUndoTool(tool: Tool): void {
  tool(
    'undo',
    {
      title: 'Undo',
      description:
        "Undo an agent's change by group_id (default: your latest). Fields edited since are left alone and reported as conflicts. The user's and the partner's changes can't be undone here.",
      input: z.strictObject({ group_id: z.string().min(1).optional() }),
      // Reverting can remove things again (tags, folders), so it is not a harmless add.
      kind: 'changing',
      idempotent: false,
    },
    async ({ group_id }, call) => {
      await writableLibrary(call);
      const history = (await call.api.listHistory({ limit: 500 })).sort((a, b) => b.at - a.at);
      let target: HistoryEntry | undefined;
      if (group_id) {
        target = history.find((h) => h.groupId === group_id);
        if (!target)
          throw new UserError(
            `Group ${group_id} is not in the recent history of the open library. Use history to find a group_id.`,
          );
      } else {
        target = history.find(
          (h) => h.actor.name === call.actor.name && h.kind !== 'undo' && h.undoable && !h.undoneBy,
        );
        if (!target) throw new UserError(`There is no change by ${call.actor.name} left to undo.`);
      }
      if (target.actor.kind !== 'agent') {
        throw new UserError(
          `That change was made by ${target.actor.name}, not by an agent, so it cannot be undone from here. Ask the user to undo it in the History tab.`,
        );
      }
      if (target.undoneBy)
        throw new UserError(`That change was already undone (by group ${target.undoneBy}).`);
      if (!target.undoable) throw new UserError('That change cannot be undone.');
      const r = await call.api.undo(target.groupId);
      return {
        undone_group_id: target.groupId,
        undo_group_id: r.groupId,
        reverted: r.reverted,
        conflicts: r.conflicts,
        summary: `Undid "${target.label}"`,
      };
    },
  );
}
