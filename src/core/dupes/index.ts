// Duplicate finder: exact copies by content, near-copies by perceptual hash, and the pure
// planning of a merge. The service composes this with the journal and the Eagle adapter.
import type { DupeFinder } from '../contracts';
import { planMerge } from './planMerge';
import { scanDuplicates } from './scan';

export const dupeFinder: DupeFinder = { scan: scanDuplicates, planMerge };

export { scanDuplicates, MAX_CLUSTER } from './scan';
export { planMerge } from './planMerge';
