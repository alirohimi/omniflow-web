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

export {
  applyCreatePortfolio,
  applyAction,
  parseAction,
  stripActionMarker,
  ACTION_CONTRACT,
  ACCOUNT_TYPES,
  ASSET_CLASSES,
  PAYMENT_METHODS,
  EXPENSE_PATCH_FIELDS,
  HOLDING_PATCH_FIELDS,
  type CreatePortfolioAction,
  type Action,
  type ActionStore,
  type ActionValidation,
  type AccountType,
  type ExpensePatchField,
  type HoldingPatchField,
} from './actions';
