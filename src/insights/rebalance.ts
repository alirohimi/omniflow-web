// ============================================================================
// OmniFlow — Rebalance engine (pure, $0, offline).
//
// Given the *current* allocation by asset class (base-currency values) and a
// *target* allocation (weights that may sum to anything; the engine
// normalises to 100%), it produces the trades needed to get back to target.
// A trade is expressed as target-units-per-symbol when possible; at this
// layer (no price needed for the math) we express it as a value delta per
// asset class, plus the specific buy/sell list per symbol.
// ============================================================================

import type { InvestmentHolding, QuoteSnapshot } from '../domain/types';

export type AssetClass = 'equity' | 'etf' | 'crypto' | 'cash' | 'other';

export interface CurrentSizing {
  total: number;
  byClass: Record<string, number>; // class -> current base value
}

export interface RebalanceOrder {
  symbol: string;
  /** base-currency value to trade (+ buy, - sell). */
  delta: number;
  direction: 'buy' | 'sell' | 'hold';
  /** current weight and target weight (0..1). */
  currentWeight: number;
  targetWeight: number;
}

export interface RebalancePlan {
  /** 0..1+ — how far off target the current allocation is (sum |Δweight|/2
   *  normalised); > `toleranceBand` means a rebalance is worthwhile. */
  drift: number;
  orders: RebalanceOrder[];
  /** Sum of |delta| across orders — total turnover value. */
  turnover: number;
}

/**
 * Value each symbol in base currency (live quote overrides stored price),
 * grouped by asset class.
 */
export function sizeByClass(
  holdings: InvestmentHolding[],
  quotes: Record<string, QuoteSnapshot>,
  toBase: (amount: number, from: string) => number,
): CurrentSizing {
  const bySymbol = new Map<string, number>();
  const byClass: Record<string, number> = {};
  let total = 0;
  for (const h of holdings) {
    const q = quotes[h.symbol];
    const priceBase = q ? toBase(q.price, q.currency) : (h.currentPriceBase ?? 0);
    if (!Number.isFinite(priceBase) || !Number.isFinite(h.units)) continue;
    const v = priceBase * h.units;
    total += v;
    bySymbol.set(h.symbol, (bySymbol.get(h.symbol) ?? 0) + v);
    const cls: string = (h.assetClass as string) || 'other';
    byClass[cls] = (byClass[cls] ?? 0) + v;
  }
  return { total, byClass };
}

/**
 * Compute a rebalance plan. `target` maps asset class -> weight (sum need not
 * be 1; normalised internally). Symbols are spread proportionally within
 * their class so the *class* drift is removed. Orders are per-symbol value
 * deltas.
 *
 * `toleranceBand` (default 0.05 = 5% drift) gates whether any trades are
 * emitted: if the aggregate drift is below the band, all orders are 'hold'.
 */
export function planRebalance(
  holdings: InvestmentHolding[],
  quotes: Record<string, QuoteSnapshot>,
  target: Record<string, number>,
  toBase: (amount: number, from: string) => number,
  toleranceBand = 0.05,
): RebalancePlan {
  const sizing = sizeByClass(holdings, quotes, toBase);
  const total = sizing.total;
  if (total <= 0 || Object.keys(target).length === 0) {
    return { drift: 0, orders: [], turnover: 0 };
  }

  // Normalise target to weights summing to 1.
  const weightSum = Object.values(target).reduce((s, w) => s + (Number.isFinite(w) ? w : 0), 0);
  if (!(weightSum > 0)) return { drift: 0, orders: [], turnover: 0 };
  const targetW: Record<string, number> = {};
  for (const [cls, w] of Object.entries(target)) {
    targetW[cls] = (Number.isFinite(w) ? w : 0) / weightSum;
  }

  // Drift = 0.5 * sum over classes |currentW - targetW|.
  let drift = 0;
  for (const cls of new Set([...Object.keys(targetW), ...Object.keys(sizing.byClass)])) {
    const curW = (sizing.byClass[cls] ?? 0) / total;
    const tarW = targetW[cls] ?? 0;
    drift += Math.abs(curW - tarW);
  }
  drift /= 2;

  // Build per-symbol orders: within each class, scale each symbol to its
  // share of the class's target value.
  const orders: RebalanceOrder[] = [];
  let turnover = 0;
  const rebalance = drift >= toleranceBand;

  for (const h of holdings) {
    const cls = (h.assetClass as string) || 'other';
    const q = quotes[h.symbol];
    const priceBase = q ? toBase(q.price, q.currency) : (h.currentPriceBase ?? 0);
    if (!Number.isFinite(priceBase) || !Number.isFinite(h.units)) continue;
    const currentVal = priceBase * h.units;
    const currentWeight = currentVal / total;
    // Target value for this symbol = class target share * (symbol's share of
    // its class's current value) so relative proportions within the class hold.
    const classNow = sizing.byClass[cls] ?? 0;
    const symbolShareOfClass = classNow > 0 ? currentVal / classNow : 0;
    const targetVal = (targetW[cls] ?? 0) * total * symbolShareOfClass;
    const targetWeight = targetVal / total;
    const delta = rebalance ? targetVal - currentVal : 0;
    if (Math.abs(delta) < 1e-6) {
      orders.push({ symbol: h.symbol, delta: 0, direction: 'hold', currentWeight, targetWeight });
      continue;
    }
    const direction = delta > 0 ? 'buy' : 'sell';
    orders.push({ symbol: h.symbol, delta, direction, currentWeight, targetWeight });
    turnover += Math.abs(delta);
  }

  return { drift, orders, turnover };
}
