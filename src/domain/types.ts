// ============================================================================
// OmniFlow — domain types (browser edition).
// Mirrors the iOS SwiftData schema, ported to JSON-serializable TS objects.
// Everything here is what gets encrypted; the ciphertext is persisted to the
// shared database (one row per user). No local copy is kept.
// ============================================================================

export type AssetClass =
  | 'equity-us'
  | 'equity-local'
  | 'etf'
  | 'crypto'
  | 'cash'
  | 'mmf';

export type ExpenseSource =
  | 'manual'
  | 'ocr'
  | 'notification'
  | 'card'
  | 'import';

export type PaymentMethod =
  | 'card'
  | 'qr'
  | 'ewallet'
  | 'cash'
  | 'bank'
  | 'other';

export type AITier = 'dictionary' | 'llm-byok' | 'llm-failed';

/** A single multi-currency expense. `baseAmount` is snapshotted at the time
 *  of the transaction (rate captured), so later rate moves don't rewrite history. */
export interface Expense {
  id: string;
  originalAmount: number;
  originalCurrency: string; // ISO-4217, e.g. 'MYR'
  baseAmount: number;       // converted to prefs.baseCurrency at capture time
  baseCurrency: string;
  fxRate: number;          // baseAmount / originalAmount (1 unit of orig = rate base)
  category: string;        // Category.name
  aiTier: AITier;
  merchant: string;
  timestamp: number;       // epoch ms
  paymentMethod: PaymentMethod;
  source: ExpenseSource;
  note?: string;
  receiptText?: string;    // raw OCR text, if captured
}

/** A category the user can extend with custom entries. */
export interface Category {
  id: string;
  name: string;
  icon: string; // emoji or short label
}

/** A platform-agnostic investment account / "wrapper". */
export interface InvestmentAccount {
  id: string;
  platformName: string;      // 'Luno', 'IBKR', 'StashAway', 'Hata', 'Moomoo', 'Manual'
  accountType: 'broker' | 'robo' | 'crypto' | 'cash' | 'other';
  baseCurrencyValue: number; // last aggregated value in base currency (denormalized)
  lastUpdated: number;      // epoch ms
  /** Optional: starting capital in base currency (deposit at the account's
   *  inception). When set, P&L is measured against it instead of the
   *  holdings' summed cost basis — matching what the user actually put in.
   *  Optional so old encrypted blobs heal cleanly. */
  initialDepositBase?: number;
}

/** A holding inside an account. */
export interface InvestmentHolding {
  id: string;
  accountId: string;         // -> InvestmentAccount.id
  symbol: string;            // 'BTC', 'CSPX.L', 'AAPL', '1155.KL'
  assetClass: AssetClass;
  holdingCurrency: string;   // currency this holding is denominated in
  units: number;
  averageEntryPrice: number; // in holdingCurrency
  currentPriceLocal: number; // last known price in holdingCurrency
  currentPriceBase: number;  // last known price in base currency
}

/** BYOK LLM providers. 'none' = free on-device rule engine only.
 *  Gemini is the free-tier-friendly option (AI Studio keys, $0 quota). */
export type LLMProvider = 'none' | 'openai' | 'anthropic' | 'gemini' | 'adacode';

/** Periodic cadence for budgets, recurring charges, and liability payments. */
export type BudgetPeriod = 'daily' | 'weekly' | 'monthly' | 'yearly';

/** A category budget cap. `cap` is a monthly-equivalent amount in the base
 *  currency at the time it was set; the engine converts other periods to
 *  monthly. `rollover` carries unused cap into the next month (Copilot-style
 *  "save for bigger purchases"). OmniFlow's first budgeting primitive. */
export interface Budget {
  id: string;
  category: string;      // Category.name the cap applies to
  cap: number;           // monthly-equivalent cap, base currency
  period: BudgetPeriod;  // billing cadence the cap expresses
  rollover: boolean;     // roll unused cap forward
  createdAt: number;
}

/** A structured recurring charge (subscription / bill / rent / loan payment).
 *  Today the advisor only DETECTS repeat merchants; this makes recurring
 *  first-class data so a bill calendar and "upcoming bills" fall out of it. */
export interface Recurring {
  id: string;
  name: string;
  merchant: string;
  amount: number;        // original (transaction) currency
  currency: string;      // ISO-4217
  baseAmount: number;    // snapshot in base currency at create/refresh time
  fxRate: number;
  period: BudgetPeriod;
  nextDue: number;       // epoch ms
  category: string;
  active: boolean;
}

/** A liability: credit card, loan, house, car. Drives the debt-payoff plan. */
export interface Liability {
  id: string;
  name: string;
  balance: number;       // outstanding principal, base currency
  apr: number;           // annual percentage rate, e.g. 24 = 24%
  minPayment: number;    // minimum monthly payment, base currency
  extraPayment?: number; // optional accelerated monthly payment
}

/** A non-investment asset: a bank account, cash, property value. Feeds net
 *  worth alongside the investment accounts. */
export interface ManualAsset {
  id: string;
  name: string;
  value: number;         // base currency
  kind: 'bank' | 'cash' | 'property' | 'other';
}

/** A single captured net-worth snapshot. Appended automatically by the
 *  dashboard on each visit (capped at the most recent 365 points so the
 *  encrypted vault blob stays small). */
export interface NetWorthPoint {
  at: number;            // epoch ms
  net: number;           // base currency
  investments: number;
  assets: number;
  liabilities: number;
}

export type AutoInvestPeriod = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

/** Cadence the salary input figure was expressed in — reuses the same
 *  BudgetPeriod the budgets / recurring modules already use. */
export type SalaryPeriod = BudgetPeriod;

/** A declared salary / income figure, entered by the user. This is the
 *  authoritative income rate for the cash-flow forecast: logged Income
 *  rows are often sparse (people don't log every payday), so a near-zero
 *  "income/mo" derived from the ledger reads like a data error. The user
 *  declares their real salary here; the forecast uses it INSTEAD of the
 *  logged-income rate when present. `period` is the cadence the amount
 *  expresses; the engine converts everything to a monthly-equivalent. */
export interface SalaryProfile {
  /** Monthly-equivalent amount in base currency (after period conversion). */
  amountPerMonth: number;
  /** Cadence the input figure was expressed in (default 'monthly'). */
  period: SalaryPeriod;
  /** Optional label, e.g. "Salary", "Salary + side income". Display only. */
  label?: string;
  updatedAt: number;
}

/** A standing auto-invest plan: "invest X per period into this account".
 *  `nextDue` is the next cycle the plan owes a contribution. `active` plans
 *  are surfaced in the panel with a "Log now" action; the panel also
 *  auto-settles due cycles on mount (one contribution per load, capped). */
export interface AutoInvest {
  id: string;
  accountId: string;      // -> InvestmentAccount.id (the target portfolio)
  name: string;           // e.g. "Monthly Luno top-up"
  amount: number;         // per-cycle amount, in `currency`
  currency: string;       // ISO-4217
  baseAmount: number;     // snapshot in base currency at create/refresh time
  fxRate: number;         // units of base per 1 `currency`
  period: AutoInvestPeriod;
  nextDue: number;        // epoch ms — the upcoming cycle to be settled
  active: boolean;
  createdAt: number;
}

/** One settled auto-invest cycle, or a manual "log a contribution now".
 *  Appended to the ledger; the account's invested capital grows by
 *  `amountBase` (its `initialDepositBase`), which is what P&L measures
 *  against. */
export interface Contribution {
  id: string;
  accountId: string;      // -> InvestmentAccount.id
  planId?: string;        // -> AutoInvest.id when settled from a plan
  amount: number;         // in `currency`
  currency: string;       // ISO-4217
  amountBase: number;     // base currency
  fxRate: number;
  date: number;           // epoch ms
  note?: string;
}

/** A savings goal: a named target amount in the base currency, with an
 *  optional deadline. `funded` is the amount currently allocated toward it
 *  (base currency), so the UI can render a progress bar. */
export interface SavingsGoal {
  id: string;
  name: string;
  target: number;        // base currency
  funded: number;        // base currency, currently allocated
  deadline?: number;     // epoch ms, optional
  createdAt: number;
}

/** A dividend event on a holding. `reinvested` records "reinvested vs paid". */
export interface Dividend {
  id: string;
  holdingId: string;     // -> InvestmentHolding.id
  symbol: string;
  amount: number;        // base currency
  currency: string;
  date: number;          // epoch ms (ex-date)
  reinvested: boolean;
}

/** A disposal event on a holding — the tax-lot / realized-gains helper. */
export interface Disposal {
  id: string;
  holdingId: string;     // -> InvestmentHolding.id
  symbol: string;
  units: number;
  salePrice: number;     // per unit, in the holding's currency
  currency: string;
  costBasisPerUnit: number; // average entry price at disposal
  date: number;
}

/** A piece of the emergency reserve. Two source types so a user can either
 *  DESIGNATE an existing tracked portfolio account (Mint/Copilot-style
 *  "link a cushion to my HYSA") or record a MANUAL amount they hold
 *  somewhere OmniFlow doesn't track. Emergency money is a SEPARATE line
 *  from the investment portfolio by design — designating an account is a
 *  reference, never a retype, so it never mixes into asset-class
 *  aggregation or net-worth double-counts. */
export interface EmergencyFundItem {
  id: string;
  /** 'account' = designated existing InvestmentAccount (live value, FX-aware)
 *   'manual'   = a static snapshot amount the user maintains. */
  kind: 'account' | 'manual';
  /** For kind 'account': InvestmentAccount.id the item mirrors (live value is
 *   pulled from portfolio aggregation so FX + quotes apply for free). */
  accountId?: string;
  name: string;          // display label (account name, or user-given)
  /** Manual amount in `currency` (ignored for account items — they're live). */
  amount?: number;
  currency: string;      // ISO-4217 (manual items); account items inherit it.
  createdAt: number;
}

/** The emergency-fund module (separate from the investment portfolio).
 *  `targetMonths` is the classic 3–6-months-of-essentials target; the
 *  engine measures coverage against essential spending, not total spend
 *  (Bankrate/YNAB rule). All optional so old encrypted blobs keep
 *  decrypting; readers normalize with `?? EMERGENCY_DEFAULT`. */
export interface EmergencyFund {
  items: EmergencyFundItem[];
  /** Target reserve = essential monthly spend * targetMonths. Default 3. */
  targetMonths: number;
  /** Optional user override of the target in base currency; when set it
   *  wins over the months-derived figure (the "I already know my number"
   *  case). Empty/undefined = derived from spending. */
  targetOverrideBase?: number;
  note?: string;
}

/** Direction of a parsed statement line: 'out' = spend/withdrawal,
 *  'in' = deposit/credit/salary/refund. */
export type Direction = 'in' | 'out';

/** One extracted, editable statement line — the shape the PDF review UI edits.
 *  Lives in the domain (not services) so it can be persisted inside the
 *  encrypted vault blob (see `PendingImport`). */
export interface ParsedStatementLine {
  /** Raw statement line it came from (kept for the user's reference). */
  raw: string;
  /** Parsed date, or undefined if the statement didn't carry one on the line. */
  date?: number; // epoch ms
  merchant: string;
  description?: string;
  /** Positive magnitude in the line's currency (use `direction` for sign). */
  amount: number;
  direction: Direction;
  /** Detected ISO-4217 code, or undefined to let the UI default to base. */
  currency?: string;
  /** The running STATEMENT BALANCE that followed this row in a table-layout
   *  statement (bank statements print the post-transaction balance). Kept for
   *  the user's reference and to sanity-check the LLM-verification path — it is
   *  NEVER the imported amount (that is `amount`). */
  balance?: number;
  // Filled in after categorization:
  category?: string;
  aiTier?: AITier;
}

/** A PDF statement import in flight or awaiting review. Persisted inside the
 *  encrypted vault so a page refresh / close mid-upload, mid-parse, or
 *  mid-review survives: the review screen rehydrates on the next load and the
 *  user can still commit (or discard) it. No plaintext statement text is ever
 *  stored outside the ciphertext — the whole blob is AES-GCM encrypted and
 *  scoped to a single user, so this adds zero new attack surface. */
export interface PendingImport {
  fileName: string;
  /** 'parse' = text extracted, rows not yet derived (refresh -> re-parse the
   *  persisted text). 'review' = rows derived and being edited (refresh ->
   *  restore the review screen directly). */
  phase: 'parse' | 'review';
  /** Raw text layer extracted from the PDF (deterministic from the file).
   *  Persisted so a refresh mid-parse can re-derive the rows without the user
   *  re-picking the file. Lives only inside the encrypted blob. */
  text?: string;
  /** Which engine produced the structure (set once parse completes). */
  parser: 'llm' | 'regex';
  /** LLM diagnostic (e.g. "fell back to regex"), if any. */
  llmError?: string;
  /** The extracted, categorized, editable lines the review UI edits. Empty
   *  until the parse phase completes. */
  lines: ParsedStatementLine[];
  /** Row indices the user unchecked (skipped on import). */
  disabled: number[];
  createdAt: number;
}

/** App-wide preferences. */
export interface UserPreferences {
  baseCurrency: string; // default 'MYR'
  displayName: string;
  llmProvider: LLMProvider;
  llmKeyFinger: string; // SHA-256 fingerprint of the stored key (for display)
  /** BYOK model override; empty = the provider's default. */
  llmModel?: string;
  autoCategorize: boolean;
  advisorRules: boolean;
  /** PWA/localhost notification permission the user granted for bill
   *  reminders + subscription nudges. 'granted' | 'denied' | 'default'. */
  notifyPermission?: NotificationPermission | 'unsupported';
  /** Target portfolio allocation (assetClass -> weight, weights may sum to
   *  anything; the rebalance engine works with relative proportions). */
  targetAllocation?: Record<string, number>;
  /** When true, the app arms a PWA notification for recurring bills that
   *  fall due within `billNoticeWindowDays`. */
  billReminders: boolean;
  billNoticeWindowDays?: number;
}

/** The encrypted-at-rest shape stored in the database. */
export interface VaultBlob {
  schema: number;
  createdAt: number;
  updatedAt: number;
  expenses: Expense[];
  categories: Category[];
  accounts: InvestmentAccount[];
  holdings: InvestmentHolding[];
  prefs: UserPreferences;
  // Optional BYOK LLM key, stored encrypted INSIDE the vault (re-decrypted
  // per session with the passphrase). Empty string when not set.
  llmKey: string;
  // Coach conversation, persisted so a reload keeps the thread. Old
  // encrypted blobs may lack it — readers normalize with ?? [].
  coachLog?: CoachMessage[];
  /** Multi-session coach threads. NEW — replaces the single coachLog with a
   *  set of named conversations, each persisted encrypted inside the vault.
   *  Optional so old blobs keep decrypting; readers normalize with ?? [].
   *  @deprecated alias below (coachLog) is retained one release. */
  coachThreads?: CoachThread[];
  /** The thread id currently open in the Coach UI. Optional; readers default
   *  to the most-recently-updated thread when it's missing or points at a
   *  deleted id. */
  activeCoachThread?: string;
  // ---- Extended entities (gap-report P0/P1). All optional so old encrypted
  // blobs keep decrypting; readers normalize with ?? []. ----
  /** Category budget caps (P0 #4). */
  budgets?: Budget[];
  /** Structured recurring charges / bills (P0 #5). */
  recurring?: Recurring[];
  /** Liabilities for the debt-payoff plan (P0 #7). */
  liabilities?: Liability[];
  /** Non-investment assets that feed net worth (P0 #6). */
  assets?: ManualAsset[];
  /** Dividend events (P0 #9). */
  dividends?: Dividend[];
  /** Disposal events for realized gains / cost basis (P0 #10). */
  disposals?: Disposal[];
  /** Emergency reserve module (separate from the investment portfolio). */
  emergency?: EmergencyFund;
  /** Net-worth history (one point per day, most recent last). Optional so
   *  old encrypted blobs keep decrypting; readers normalize with ?? []. */
  netWorthHistory?: NetWorthPoint[];
  /** Savings goals: target amounts with optional deadline. Optional so old
   *  encrypted blobs keep decrypting; readers normalize with ?? []. */
  savingsGoals?: SavingsGoal[];
  /** In-progress PDF statement import (upload/parse/review). Persisted so a
   *  refresh or close mid-import survives; cleared when the user commits it
   *  to expenses or discards it. Optional so old encrypted blobs heal. */
  pendingImport?: PendingImport | null;
  /** Standing auto-invest plans (monthly/weekly top-ups into a portfolio).
   *  Optional so old encrypted blobs keep decrypting; readers normalize
   *  with ?? []. */
  autoInvests?: AutoInvest[];
  /** Declared salary / income figure (authoritative forecast income rate).
   *  Optional so old encrypted blobs keep decrypting; readers normalize
   *  with ?? null. */
  salary?: SalaryProfile | null;
  /** Contribution ledger (settled auto-invest cycles + manual top-ups).
   *  Grows each account's invested capital; P&L measures against it.
   *  Optional so old encrypted blobs keep decrypting; readers normalize
   *  with ?? []. */
  contributions?: Contribution[];
}

/** One coach chat turn, persisted (encrypted) with the vault. Compact by
 *  design: bounded text, source tier recorded for the badge. No raw ledger
 *  data — grounding happens at answer time, not storage time. */
export interface CoachMessage {
  id: string;
  role: 'user' | 'coach';
  text: string;
  /** Optional compressed image attachment (JPEG data URL), persisted inside
 *  the encrypted vault. The LLM tier receives it as a vision input; the
 *  rule engine notes it cannot read it. Compressed to keep the vault blob
 *  small (max long side ~1600px). */
  image?: string;
  source?: 'llm' | 'rules' | 'system';
  at: number;
}

/** One named coach conversation. Persisted encrypted inside the vault.
 *  Bounded to the last 200 messages per thread (same bound as the old
 *  single coachLog) so the vault blob stays small no matter how long the
 *  user chats. `title` is auto-set from the first user message (40-char cap)
 *  and can be user-renamed; `updatedAt` bumps on every message push. */
export interface CoachThread {
  id: string; // client-generated
  title: string; // "New chat" until the first user message titles it
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
  messages: CoachMessage[];
}

/** Snapshot of live market data — not persisted with the vault by default
 *  (re-fetchable), kept for UI caching. */
export interface QuoteSnapshot {
  symbol: string;
  assetClass: AssetClass;
  price: number;
  currency: string;
  asOf: number;
  source: 'coingecko' | 'yahoo' | 'manual' | 'cache' | 'failed';
  /** Human-readable reason when the quote is a fallback or a failure
 *  (e.g. "live fetch timed out — using stored price", "unknown symbol"). */
  note?: string;
}
