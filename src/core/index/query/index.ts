// Scopes, filters, keyword grammar, sorts, smart folders and color search over the SQLite index.
// See docs/specs/query.md.
import type { QueryEngineFactory } from '../../contracts';
import { SqlQueryEngine } from './engine';

export const queryEngines: QueryEngineFactory = {
  create: (index, urls, filePathOf) => new SqlQueryEngine(index, urls, filePathOf),
};

export { SqlQueryEngine } from './engine';
export { parseKeywords, keywordsToSql, keywordTerms } from './keywords';
export type { KeywordNode } from './keywords';
export {
  evaluateSmartFolder,
  matchesConditions,
  compileSmartFolder,
  normalizeSmartFolders,
  flattenSmartFolders,
  findSmartFolder,
} from './smartFolders';
export type { EvalContext, CompiledSmartFolder, SmartFolderEntry } from './smartFolders';
export { colorDistance, rgbToLab, COLOR_TOLERANCE } from './color';
export type { RGB } from './color';
export { ascendingFromSortIncrease, sortIncreaseFromAscending, naturalKey } from './sorts';
export { TYPE_GROUP_EXTS } from './filters';
export { eagleRuleToFilter, filterToEagleRule, defaultEagleRule } from './savedFilters';
export type { EagleRule } from './savedFilters';
