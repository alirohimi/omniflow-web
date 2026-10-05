// ============================================================================
// OmniFlow — AI layer exports.
// ============================================================================

export {
  categorize,
  categorizeByDictionary,
  categorizeByLLM,
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
