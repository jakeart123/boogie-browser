// Merging a Dropbox conflicted copy into the library's file, and deciding which copies are only
// noise (docs/specs/merge.md). Pure functions: no fs, no electron.
export { basesUntil, pickBases, SLACK_MS } from './bases';
export { judge } from './judge';
export { mergeItem, type ItemContext } from './item';
export { redundant, same, strip } from './normalize';
export { applyChange, byApplyOrder, diffRoot, foldersLeaving, mergeRoot } from './root';
export type { Change, Found, MergeRootOptions } from './root';
export { mergeTags } from './tags';
export {
  certain,
  questionsOf,
  summarize,
  takeAnswers,
  takeCertain,
  type Diff,
  type Rec,
  type Verdict,
} from './types';
