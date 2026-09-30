// Sync safety for a library shared with a partner's Eagle: what their Eagle has seen of our changes
// and re-sending them while it runs (partner.ts), the decisions as pure functions (judge.ts), their
// clock (clock.ts), and logging outside writes that may have put an old copy over ours
// (outside.ts). See partner.ts for the whole story.
export { Partner, PARTNER_TIMING, type PartnerIO } from './partner';
export { PartnerClock, CLOCK_RULES } from './clock';
export {
  JUDGE_RULES,
  isBoogieValue,
  onlyStampChanged,
  pastForPartner,
  raiseFate,
  ranThrough,
  judgeOutsideWrite,
  seenByRewrite,
  touchChoice,
  writerOf,
  type Sent,
  type TouchChoice,
  type Verdict,
} from './judge';
export {
  OTHER_BOOGIE,
  afterShared,
  attribute,
  keepTheirs,
  recordJudged,
  sortShared,
  type SharedSort,
  type Writer,
} from './outside';
