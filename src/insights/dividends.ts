// ============================================================================
// OmniFlow — Dividend engine (pure, $0, offline).
//
// Aggregates dividend events by holding/symbol, yields yield-on-cost, and
// splits reinvested vs. paid cash. Dividends are stored in their native
// `currency`; every total here is expressed in the user's base currency via
// the `toBase` converter (NaN-proof: unknown currency -> 0 contribution).
// ============================================================================

import type { Dividend, InvestmentHolding } from '../domain/types';

/** (amount, currency) => base-currency amount. Callers pass a NaN-proof converter. */
type ToBase = (amount: number, from: string) => number;

export interface DividendByHolding {
  holdingId: string;
  symbol: string;
  totalReceived: number; // base currency, all-time
  totalReinvested: number;
  totalCash: number;
  eventCount: number;
  lastDate: number | null;
}

export interface DividendYield {
  holdingId: string;
  symbol: string;
  /** annualised received / cost basis (0 if no cost basis or no dividends). */
  yieldOnCostPct: number | null;
}

/** Total dividends received (base currency) over a window (or all-time). */
export function dividendsTotal(
  dividends: Dividend[],
  toBase: ToBase,
  from?: number,
  to?: number,
): number {
  let t = 0;
  for (const d of dividends) {
    if (from !== undefined && d.date < from) continue;
    if (to !== undefined && d.date > to) continue;
    const base = toBase(d.amount, d.currency);
    if (Number.isFinite(base)) t += base;
  }
  return Number.isFinite(t) ? t : 0;
}

/** Group dividend events by holding, totals in base currency. */
export function dividendsByHolding(dividends: Dividend[], toBase: ToBase): DividendByHolding[] {
  const map = new Map<string, DividendByHolding>();
  for (const d of dividends) {
    const key = d.holdingId || `sym:${d.symbol}`;
    let row = map.get(key);
    if (!row) {
      row = {
        holdingId: d.holdingId,
        symbol: d.symbol,
        totalReceived: 0,
        totalReinvested: 0,
        totalCash: 0,
        eventCount: 0,
        lastDate: null,
      };
      map.set(key, row);
    }
    const base = toBase(d.amount, d.currency);
    if (Number.isFinite(base)) {
      row.totalReceived += base;
      if (d.reinvested) row.totalReinvested += base;
      else row.totalCash += base;
    }
    row.eventCount += 1;
    if (Number.isFinite(d.date) && (row.lastDate === null || d.date > row.lastDate)) {
      row.lastDate = d.date;
    }
  }
  return [...map.values()].sort((a, b) => b.totalReceived - a.totalReceived);
}

/**
 * Yield-on-cost per holding: trailing-365d base-currency income divided by the
 * holding's base-currency cost basis. Null when there is no cost basis or no
 * dividend income in the window.
 */
export function dividendYields(
  dividends: Dividend[],
  holdings: InvestmentHolding[],
  toBase: ToBase,
  toBaseCost: ToBase,
  now: number,
): DividendYield[] {
  const yearAgo = now - 365 * 86_400_000;
  const receivedByHolding = new Map<string, number>();
  for (const d of dividends) {
    if (d.date < yearAgo) continue;
    const base = toBase(d.amount, d.currency);
    if (!Number.isFinite(base)) continue;
    const key = d.holdingId || `sym:${d.symbol}`;
    receivedByHolding.set(key, (receivedByHolding.get(key) ?? 0) + base);
  }
  const out: DividendYield[] = [];
  for (const h of holdings) {
    const received =
      receivedByHolding.get(h.id) ?? receivedByHolding.get(`sym:${h.symbol}`) ?? 0;
    const costLocal = Number.isFinite(h.units) && Number.isFinite(h.averageEntryPrice)
      ? h.units * h.averageEntryPrice
      : 0;
    const costBase = toBaseCost(costLocal, h.holdingCurrency);
    const yoc = Number.isFinite(costBase) && costBase > 0 && received > 0 ? (received / costBase) * 100 : null;
    out.push({ holdingId: h.id, symbol: h.symbol, yieldOnCostPct: yoc });
  }
  return out.sort((a, b) => (b.yieldOnCostPct ?? -1) - (a.yieldOnCostPct ?? -1));
}
