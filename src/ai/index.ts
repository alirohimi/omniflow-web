// ============================================================================
// OmniFlow — AI layer exports.
// ============================================================================

export {
  categorize,
  categorizeByDictionary,
  categorizeByLLM,
  testLLMKey,
  type CategorizeInput,
  type CategorizeResult,
  type LLMConfig,
} from './categorize';

export {
  runRules,
  adviseWithLLM,
  portfolioBaseValue,
  spendOverLastDays,
  type Advisory,
  type AdvisorInput,
} from './advisor';

export {
  buildPortfolio,
  valueInBase,
  fmtBase,
  type HoldingLine,
  type AccountLine,
  type PortfolioSummary,
} from './portfolio';

export {
  coachAsk,
  buildBrief,
  coachFallback,
  coachSystemPrompt,
  type CoachContext,
  type CoachBrief,
  type CoachAnswer,
} from './coach';
