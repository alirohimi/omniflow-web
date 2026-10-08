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

/** Snapshot of live market data — not persisted with the vault by default
 *  (re-fetchable), kept for UI caching. */
export interface QuoteSnapshot {
  symbol: string;
  assetClass: AssetClass;
  price: number;
  currency: string;
  asOf: number;
  source: 'coingecko' | 'yahoo' | 'manual' | 'cache';
}
