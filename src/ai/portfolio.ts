// ============================================================================
// OmniFlow — Portfolio aggregation (platform-agnostic, Module C).
//
// Computes per-account, per-asset-class, and total portfolio value in the
// user's base currency, plus weighted cost basis and net return. Works on
// live quotes (when available) or the last-stored manual prices, so it
// degrades gracefully offline.
// ============================================================================

import type {
  InvestmentAccount,
  InvestmentHolding,
  QuoteSnapshot,
  AssetClass,
} from '../domain/types';
import { currencyInfo } from '../domain/enums';

export interface HoldingLine {
  holding: InvestmentHolding;
  quote: QuoteSnapshot | undefined;
  valueBase: number;      // value in base currency
  valueLocal: number;     // value in holding currency
  costBase: number;       // cost basis in base currency
  currency: string;       // currency the price is in
}

export interface AccountLine {
  account: InvestmentAccount;
  lines: HoldingLine[];
  valueBase: number;
  valueLocal: number;
  costBase: number;
  returnPct: number | null;
}

export interface PortfolioSummary {
  baseCurrency: string;
  totalValueBase: number;
  totalCostBase: number;
  totalReturnPct: number | null;
  byAssetClass: { assetClass: AssetClass; valueBase: number; pct: number }[];
  byAccount: AccountLine[];
  liveQuoteCount: number;
  staleQuoteCount: number;
}

/** Best-effort price in base currency for a holding, given a live quote (or
 *  not) and a base-rate table (units of base per 1 of currency). */
export function valueInBase(
  h: InvestmentHolding,
  quote: QuoteSnapshot | undefined,
  base: string,
  rates: (code: string) => number,
): { valueBase: number; valueLocal: number; costBase: number } {
  const priceLocal = quote?.price ?? h.currentPriceLocal;
  const cur = quote?.currency ?? h.holdingCurrency;
  const toBase = cur === base ? 1 : rates(cur);
  const valueLocal = priceLocal * h.units;
  const valueBase = valueLocal * toBase;
  const costBase = h.averageEntryPrice * h.units * toBase;
  return { valueBase, valueLocal, costBase };
}

export function buildPortfolio(
  accounts: InvestmentAccount[],
  holdings: InvestmentHolding[],
  quotes: Record<string, QuoteSnapshot>,
  base: string,
  rates: (code: string) => number,
): PortfolioSummary {
  const lines: HoldingLine[] = holdings.map((h) => {
    const q = quotes[h.symbol];
    const { valueBase, valueLocal, costBase } = valueInBase(h, q, base, rates);
    return { holding: h, quote: q, valueBase, valueLocal, costBase, currency: q?.currency ?? h.holdingCurrency };
  });

  const byAssetMap = new Map<AssetClass, number>();
  for (const l of lines) byAssetMap.set(l.holding.assetClass, (byAssetMap.get(l.holding.assetClass) ?? 0) + l.valueBase);

  const byAccount: AccountLine[] = accounts.map((acc) => {
    const accLines = lines.filter((l) => l.holding.accountId === acc.id);
    const valueBase = accLines.reduce((s, l) => s + l.valueBase, 0);
    const valueLocal = accLines.reduce((s, l) => s + l.valueLocal, 0);
    const costBase = accLines.reduce((s, l) => s + l.costBase, 0);
    const returnPct = costBase > 0 ? ((valueBase - costBase) / costBase) * 100 : null;
    return { account: acc, lines: accLines, valueBase, valueLocal, costBase, returnPct };
  });

  const totalValueBase = lines.reduce((s, l) => s + l.valueBase, 0);
  const totalCostBase = lines.reduce((s, l) => s + l.costBase, 0);
  const totalReturnPct = totalCostBase > 0 ? ((totalValueBase - totalCostBase) / totalCostBase) * 100 : null;

  const byAssetClass = [...byAssetMap.entries()]
    .map(([assetClass, valueBase]) => ({
      assetClass,
      valueBase,
      pct: totalValueBase > 0 ? (valueBase / totalValueBase) * 100 : 0,
    }))
    .sort((a, b) => b.valueBase - a.valueBase);

  const liveQuoteCount = lines.filter((l) => l.quote && l.quote.source === 'coingecko' || l.quote?.source === 'yahoo').length;
  const staleQuoteCount = lines.length - liveQuoteCount;

  return {
    baseCurrency: base,
    totalValueBase,
    totalCostBase,
    totalReturnPct,
    byAssetClass,
    byAccount,
    liveQuoteCount,
    staleQuoteCount,
  };
}

/** Format a value in base currency for display. */
export function fmtBase(value: number, base: string): string {
  const sym = currencyInfo(base).symbol;
  return `${sym}${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export const __test = { valueInBase, buildPortfolio };
