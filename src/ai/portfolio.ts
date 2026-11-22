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
  ok: boolean;            // false when this row contributed 0 (corrupt/missing rate)
}

export interface AccountLine {
  account: InvestmentAccount;
  lines: HoldingLine[];
  valueBase: number;
  valueLocal: number;
  costBase: number;
  returnPct: number | null;
  /** P&L against the user's INITIAL DEPOSIT (account.initialDepositBase) when
   *  one is set — the real "did my money grow?" number. `pnlBase` is the
   *  absolute change; null when no deposit is recorded. */
  depositBase: number | null;
  pnlBase: number | null;
  depositReturnPct: number | null;
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
  /** Rows that contributed 0 (corrupt data or missing FX rate) — excluded
   *  from totals so the KPI panel never shows NaN/Infinity. */
  uncounted: number;
}

/** Best-effort price in base currency for a holding, given a live quote (or
 *  not) and a base-rate table (units of base per 1 of currency).
 *
 *  NaN-proof by construction: a corrupt row (undefined price/units from a
 *  legacy vault) or a missing FX rate (e.g. offline approximations not
 *  covering the pair) must contribute 0 to the total and be flagged with
 *  `ok: false` — never poison the whole aggregate. */
export function valueInBase(
  h: InvestmentHolding,
  quote: QuoteSnapshot | undefined,
  base: string,
  rates: (code: string) => number,
): { valueBase: number; valueLocal: number; costBase: number; ok: boolean } {
  // Cash / money-market funds trade at par: the unit IS the value, so a
  // missing live quote or stored price must default to 1 (par) — NOT 0 —
  // or a "MYR 1,500 cash" row would silently read as RM0 (the "cash input
  // off" bug). Every other asset class with a missing price contributes 0.
  const isPar = h.assetClass === 'cash' || h.assetClass === 'mmf';
  const rawPrice = quote?.price ?? h.currentPriceLocal;
  const priceLocal = Number.isFinite(rawPrice) ? rawPrice : isPar ? 1 : 0;
  // Par rows are ALWAYS denominated in the holding's own currency — the "price"
  // is the par unit (1.0), not a market quote. batch() dedupes quotes by
  // symbol, so a USD-account "CASH" line can clobber the shared CASH quote
  // and carry currency:'USD'; using the quote's currency would then convert
  // a MYR cash row at the USD rate (the 4000 MYR -> RM16350 bug). Non-par
  // rows still take the quote's currency (the live quote knows it).
  const cur = isPar ? h.holdingCurrency : (quote?.currency ?? h.holdingCurrency);
  const toBaseRaw = cur === base ? 1 : rates(cur);
  const toBase = Number.isFinite(toBaseRaw) ? toBaseRaw : 0;
  const units = Number.isFinite(h.units) ? h.units : 0;
  const entry = Number.isFinite(h.averageEntryPrice) ? h.averageEntryPrice : 0;
  // Valid when the row has real units, a usable FX rate, and (unless par) a
  // positive price. Par rows are always valid so long as units + rate exist.
  const ok = units > 0 && toBase > 0 && priceLocal > 0;
  const valueLocal = priceLocal * units;
  const valueBase = valueLocal * toBase;
  const costBase = entry * units * toBase;
  return { valueBase, valueLocal, costBase, ok };
}

export function buildPortfolio(
  accounts: InvestmentAccount[],
  holdings: InvestmentHolding[],
  quotes: Record<string, QuoteSnapshot>,
  base: string,
  rates: (code: string) => number,
): PortfolioSummary {
  // Index accounts by id so allocation lines can reach their net deposit.
  const depositById = new Map<string, number>();
  for (const a of accounts) {
    const d = typeof a.initialDepositBase === 'number' && Number.isFinite(a.initialDepositBase) && a.initialDepositBase > 0
      ? a.initialDepositBase : 0;
    if (d > 0) depositById.set(a.id, d);
  }
  const lines: HoldingLine[] = holdings.map((h) => {
    const q = quotes[h.symbol];
    // Allocation sleeve: value = pct/100 × netDeposit × (livePrice / refPrice).
    // The slice scales with how the REAL ticker has moved since it was set —
    // this is what makes a StashAway-style allocation track auto-rebalance.
    if (h.isAllocation && Number.isFinite(h.allocationPct) && (h.allocationPct ?? 0) > 0) {
      const deposit = depositById.get(h.accountId) ?? 0;
      const ref = Number.isFinite(h.refPrice) && (h.refPrice ?? 0) > 0 ? h.refPrice! : 0;
      const live = q && Number.isFinite(q.price) && q.price > 0 ? q.price : ref; // offline -> flat
      const scale = ref > 0 ? live / ref : 1; // no ref -> value = the slice (flat)
      const valueBase = ((h.allocationPct ?? 0) / 100) * deposit * scale;
      // valueBase is authoritative (totals + P&L are base-currency). Local is
      // only a display hint for these sleeves — mirror valueBase when the
      // holding currency IS the base, else it's shown "—" by the UI anyway.
      const valueLocal = h.holdingCurrency === base ? valueBase : 0;
      const ok = valueBase > 0;
      return { holding: h, quote: q, valueBase, valueLocal, costBase: 0, currency: q?.currency ?? h.holdingCurrency, ok };
    }
    const { valueBase, valueLocal, costBase, ok } = valueInBase(h, q, base, rates);
    return { holding: h, quote: q, valueBase, valueLocal, costBase, currency: q?.currency ?? h.holdingCurrency, ok };
  });

  const byAssetMap = new Map<AssetClass, number>();
  for (const l of lines) byAssetMap.set(l.holding.assetClass, (byAssetMap.get(l.holding.assetClass) ?? 0) + l.valueBase);

  // O(n) per-account grouping: one pass into a Map keyed by accountId,
  // instead of a per-account `.filter()` over all lines (was O(accounts ×
  // holdings) — stalling at 50 accounts × 500 holdings).
  const linesByAccount = new Map<string, HoldingLine[]>();
  for (const l of lines) {
    const key = l.holding.accountId;
    const bucket = linesByAccount.get(key);
    if (bucket) bucket.push(l);
    else linesByAccount.set(key, [l]);
  }

  const byAccount: AccountLine[] = accounts.map((acc) => {
    const accLines = linesByAccount.get(acc.id) ?? [];
    const valueBase = accLines.reduce((s, l) => s + l.valueBase, 0);
    const valueLocal = accLines.reduce((s, l) => s + l.valueLocal, 0);
    const costBase = accLines.reduce((s, l) => s + l.costBase, 0);
    const returnPct = costBase > 0 ? ((valueBase - costBase) / costBase) * 100 : null;
    const depositBase =
      typeof acc.initialDepositBase === 'number' && Number.isFinite(acc.initialDepositBase) && acc.initialDepositBase > 0
        ? acc.initialDepositBase
        : null;
    const pnlBase = depositBase != null ? valueBase - depositBase : null;
    const depositReturnPct = depositBase != null ? ((valueBase - depositBase) / depositBase) * 100 : null;
    return { account: acc, lines: accLines, valueBase, valueLocal, costBase, returnPct, depositBase, pnlBase, depositReturnPct };
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

  const liveQuoteCount = lines.filter(
    (l) => (l.quote?.source === 'coingecko' || l.quote?.source === 'yahoo'),
  ).length;
  const staleQuoteCount = lines.length - liveQuoteCount;
  const uncounted = lines.filter((l) => !l.ok).length;

  return {
    baseCurrency: base,
    totalValueBase,
    totalCostBase,
    totalReturnPct,
    byAssetClass,
    byAccount,
    liveQuoteCount,
    staleQuoteCount,
    uncounted,
  };
}

/** Format a value in base currency for display. */
export function fmtBase(value: number, base: string): string {
  const sym = currencyInfo(base).symbol;
  return `${sym}${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export const __test = { valueInBase, buildPortfolio };
