// Input pieces several tools share. Descriptions only where the name alone isn't enough: every
// agent session pays for them in tools/list.
import { z } from 'zod';
import { FOLDER_COLORS, type FolderColor } from '../../shared/types';
import { MAX_ITEMS_PER_APPLY } from './plans';

/** Every tool but list_libraries names its library: the user's open library never decides it. */
export const library = z.string().trim().min(1).max(4000);

export const itemId = z.string().trim().min(1).max(64);

export const itemIds = z
  .array(itemId)
  .min(1)
  .max(
    MAX_ITEMS_PER_APPLY,
    `At most ${MAX_ITEMS_PER_APPLY} item ids per call. Split the job into batches.`,
  );

/** What it means is in each tool's description ("Two steps: ..."). */
export const planId = z.string().optional();
export const dryRun = z.boolean().optional().describe('Preview only.');

export const tagList = z.array(z.string().trim().min(1).max(100)).min(1).max(50);

export const folderRef = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .describe('Folder id, full path ("Parent / Child") or unique name.');

export const folderRefs = z.array(folderRef).min(1).max(20);

/** Paging through a list of results. */
export const page = {
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(100).optional().describe('Default 25.'),
};

/** Eagle's eight color names, shared by folders, smart folders and tag groups. */
export const COLORS = Object.keys(FOLDER_COLORS) as [FolderColor, ...FolderColor[]];
export const colorName = z.enum(COLORS);
/** A color, or "none" to clear it. */
export const colorOrNone = z.enum([...COLORS, 'none']);
