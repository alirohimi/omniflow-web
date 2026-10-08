// ============================================================================
// OmniFlow — Coach actions.
//
// The coach is read-only by design (it advises on your data). This module
// adds ONE safe write path: when the user asks the LLM to CREATE a portfolio
// or holdings, the LLM emits a strict [[ACTION:{...}]] marker. The client:
//
//   1. parses + validates it against the real domain (account types, asset
//      classes, ISO currencies, sane numbers, dedupe against existing data)
//   2. shows a confirm card in the chat — NOTHING is written until Apply
//   3. applies it via the store, idempotently (re-Apply skips duplicates)
//
// An invalid or unverifiable proposal is rejected with a reason, never
// written. The rule-engine tier (no LLM key) cannot emit actions.
// ============================================================================

import type {
  AssetClass,
  InvestmentAccount,
  InvestmentHolding,
} from '../domain/types';

export const ACCOUNT_TYPES = ['broker', 'robo', 'crypto', 'cash', 'other'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ASSET_CLASSES: AssetClass[] = [
  'equity-us', 'equity-local', 'etf', 'crypto', 'cash', 'mmf',
];

export interface ProposedHolding {
  symbol: string;
  assetClass: AssetClass;
  currency: string; // ISO 4217, the currency the holding is denominated in
  units: number;
  entryPrice: number; // average entry price, in `currency`
}

/** The single action the LLM may propose: create an account + holdings. */
export interface CreatePortfolioAction {
  action: 'create_portfolio';
  platformName: string;
  accountType: AccountType;
  holdings: ProposedHolding[];
}

export interface ActionValidation {
  ok: boolean;
  action?: CreatePortfolioAction;
  /** Human-readable rejection reason when ok === false. */
  reason?: string;
}

/**
 * Minimal store surface the applier needs (structural, test-friendly).
 * Reads go through getters so it can be satisfied by the real VaultStore
 * (where accounts/holdings live inside `vault`) without coupling to that
 * shape. Writes go through addAccount/addHolding, which return the id.
 */
export interface ActionStore {
  addAccount: (i: { platformName: string; accountType: InvestmentAccount['accountType'] }) => string;
  addHolding: (i: {
    accountId: string;
    symbol: string;
    assetClass: AssetClass;
    holdingCurrency: string;
    units: number;
    averageEntryPrice: number;
    currentPriceLocal?: number;
    currentPriceBase?: number;
  }) => string;
  getAccounts: () => InvestmentAccount[];
  getHoldings: () => InvestmentHolding[];
}

// ---------------------------------------------------------------------------
// Prompt contract — appended to the coach system prompt.
// ---------------------------------------------------------------------------

export const ACTION_CONTRACT: string = [
  '',
  'You may also ACT on the user\u2019s data. When \u2014 and ONLY when \u2014 the user explicitly asks to create, add, or set up a portfolio or holdings (e.g. "create a portfolio for me", "add these to my portfolio"), reply with a short plain-language confirmation of what you are about to create, followed on its own line by exactly one marker:',
  '[ACTION:{"action":"create_portfolio","platformName":"<name>","accountType":"<one of: broker|robo|crypto|cash|other>","holdings":[{"symbol":"<e.g. CSPX | BTC | AAPL | 1155.KL>","assetClass":"<one of: equity-us|equity-local|etf|crypto|cash|mmf>","currency":"<ISO 4217 code, e.g. USD>","units":<number>,"entryPrice":<number in currency>}]}]',
  'Rules for the marker: valid JSON only; numbers as numbers (no quotes); symbols as written by the user or standard ticker (BTC, ETH, AAPL, CSPX, GLDM, 1155.KL); accountType "robo" for StashAway/Versa-style wrappers, "broker" for Luno/IBKR/Moomoo, "crypto" for exchange wallets, "cash" for cash/MMF; entryPrice is the average purchase price per unit in the holding currency (use 0 only when genuinely unknown). If the request is ambiguous, ask ONE clarifying question instead of guessing. Never emit [ACTION:] for analysis, questions, or advice about data that already exists.',
].join('\n');

// ---------------------------------------------------------------------------
// Parsing + validation.
// ---------------------------------------------------------------------------

const MARKER_RE = /\[ACTION:(\{[\s\S]*\})\]/;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export function parseAction(raw: string): ActionValidation {
  const m = MARKER_RE.exec(raw);
  if (!m) return { ok: false, reason: 'No [ACTION:] marker found.' };

  let data: unknown;
  try {
    data = JSON.parse(m[1]);
  } catch (e) {
    return { ok: false, reason: 'Invalid JSON in action marker: ' + String(e).slice(0, 80) };
  }

  const d = data as Record<string, unknown>;
  if (d?.action !== 'create_portfolio') return { ok: false, reason: 'Unknown action type.' };

  const platformName = typeof d.platformName === 'string' ? d.platformName.trim().slice(0, 40) : '';
  if (!platformName) return { ok: false, reason: 'Missing platformName.' };

  const accountType = d.accountType;
  if (!(ACCOUNT_TYPES as readonly string[]).includes(String(accountType))) {
    return { ok: false, reason: `accountType must be one of: ${ACCOUNT_TYPES.join(', ')}.` };
  }

  const rawHoldings = Array.isArray(d.holdings) ? d.holdings : [];
  if (rawHoldings.length === 0) return { ok: false, reason: 'At least one holding is required.' };
  if (rawHoldings.length > 20) return { ok: false, reason: 'Too many holdings in one action (max 20).' };

  const holdings: ProposedHolding[] = [];
  const seen = new Set<string>();
  for (const h of rawHoldings) {
    const hh = h as Record<string, unknown>;
    const symbol = typeof hh.symbol === 'string' ? hh.symbol.trim().toUpperCase().slice(0, 16) : '';
    if (!symbol || !/^[A-Z0-9.\-@^_]+$/.test(symbol)) {
      return { ok: false, reason: `Invalid symbol: ${String(hh.symbol ?? '')}. Use a ticker like CSPX, BTC, AAPL, 1155.KL.` };
    }
    if (seen.has(symbol)) return { ok: false, reason: `Duplicate symbol in one action: ${symbol}.` };
    seen.add(symbol);

    if (!ASSET_CLASSES.includes(hh.assetClass as AssetClass)) {
      return { ok: false, reason: `Invalid assetClass for ${symbol}: ${String(hh.assetClass)}. Use one of: ${ASSET_CLASSES.join(', ')}.` };
    }
    const currency = typeof hh.currency === 'string' ? hh.currency.trim().toUpperCase() : '';
    if (!/^[A-Z]{3}$/.test(currency)) {
      return { ok: false, reason: `Invalid currency for ${symbol}: ${String(hh.currency)}. Use an ISO 4217 code like USD or MYR.` };
    }
    if (!isNum(hh.units) || hh.units <= 0) {
      return { ok: false, reason: `units for ${symbol} must be a positive number.` };
    }
    if (!isNum(hh.entryPrice)) {
      return { ok: false, reason: `entryPrice for ${symbol} must be a non-negative number.` };
    }

    holdings.push({ symbol, assetClass: hh.assetClass as AssetClass, currency, units: hh.units, entryPrice: hh.entryPrice });
  }

  return { ok: true, action: { action: 'create_portfolio', platformName, accountType: accountType as AccountType, holdings } };
}

/** Remove the marker from user-visible text. */
export function stripActionMarker(text: string): string {
  return text.replace(MARKER_RE, '').trim();
}

// ---------------------------------------------------------------------------
// Apply — idempotent. Reuse an existing same-named account; skip holdings
// already present (same symbol+units+entry). Returns a summary string.
// ---------------------------------------------------------------------------

export function applyCreatePortfolio(store: ActionStore, a: CreatePortfolioAction): string {
  const accounts = store.getAccounts();
  const holdings = store.getHoldings();
  const existing = accounts.find((x) => x.platformName.toLowerCase() === a.platformName.toLowerCase());
  const accountId = existing ? existing.id : store.addAccount({ platformName: a.platformName, accountType: a.accountType });

  let added = 0;
  let skipped = 0;
  for (const h of a.holdings) {
    const dup = holdings.some(
      (x) => x.accountId === accountId && x.symbol === h.symbol && x.units === h.units && x.averageEntryPrice === h.entryPrice,
    );
    if (dup) { skipped++; continue; }
    store.addHolding({
      accountId,
      symbol: h.symbol,
      assetClass: h.assetClass,
      holdingCurrency: h.currency,
      units: h.units,
      averageEntryPrice: h.entryPrice,
    });
    added++;
  }

  const bits: string[] = [];
  bits.push(existing ? `used existing "${existing.platformName}"` : `created "${a.platformName}" (${a.accountType})`);
  if (added > 0) bits.push(`added ${added} holding${added === 1 ? '' : 's'}`);
  if (skipped > 0) bits.push(`skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}`);
  return bits.join(', ');
}

export const __test = { parseAction, stripActionMarker, applyCreatePortfolio, ACCOUNT_TYPES, ASSET_CLASSES };
