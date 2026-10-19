// ============================================================================
// OmniFlow — Net worth engine (pure, $0, offline).
//
// Net worth = (investment value + manual assets) − liabilities, all in base
// currency. `netWorthNow` is the accurate *current* snapshot; the forward-
// looking trend is produced by the forecast engine (cash-flow based) since
// we do not record historical mark-to-market points.
// ============================================================================

import type {
  InvestmentHolding,
  ManualAsset,
  Liability,
  QuoteSnapshot,
} from '../domain/types';

export interface NetWorthNow {
  investments: number;
  assets: number;
  liabilities: number;
  net: number;
  /** True when no source data exists yet (all zeros) — UI can show an
   *  empty state instead of a misleading "0 net worth". */
  hasData: boolean;
}

/** Current investment value (base currency) — NaN-proof.
 *  Par rows (cash / MMF) default to par=1 when no stored price exists,
 *  matching ai/portfolio.ts valueInBase so this never undercounts cash. */
export function investmentValueNow(
  holdings: InvestmentHolding[],
  quotes: Record<string, QuoteSnapshot>,
  toBase: (amount: number, from: string) => number,
): number {
  let total = 0;
  for (const h of holdings) {
    const q = quotes[h.symbol];
    const isPar = h.assetClass === 'cash' || h.assetClass === 'mmf';
    const rawPrice = q?.price ?? h.currentPriceLocal;
    const priceLocal = Number.isFinite(rawPrice) ? rawPrice : isPar ? 1 : 0;
    if (!Number.isFinite(priceLocal) || !Number.isFinite(h.units) || priceLocal <= 0) continue;
    const cur = isPar ? h.holdingCurrency : (q?.currency ?? h.holdingCurrency);
    // Convert 1 unit of `cur` to base (FX table), applied to the LOCAL price
    // so the same math holds whether the price came from a live quote or the
    // stored fallback. Same convention as valueInBase in ai/portfolio.ts.
    const rate = toBase(1, cur);
    const r = Number.isFinite(rate) ? rate : (cur === 'USD' ? 0 : 1);
    total += priceLocal * h.units * r;
  }
  return Number.isFinite(total) ? total : 0;
}

/** Current manual-asset value (base currency). */
export function assetValueNow(assets: ManualAsset[]): number {
  const t = assets.reduce((s, a) => (Number.isFinite(a.value) ? s + a.value : s), 0);
  return Number.isFinite(t) ? t : 0;
}

/** Current liability total (base currency). */
export function liabilityTotalNow(liabilities: Liability[]): number {
  const t = liabilities.reduce((s, l) => (Number.isFinite(l.balance) ? s + l.balance : s), 0);
  return Number.isFinite(t) ? t : 0;
}

/** Accurate current net-worth snapshot. `hasData` is false when the user has
 *  not entered any investments, assets, or liabilities yet. */
export function netWorthNow(
  holdings: InvestmentHolding[],
  quotes: Record<string, QuoteSnapshot>,
  assets: ManualAsset[],
  liabilities: Liability[],
  toBase: (amount: number, from: string) => number,
): NetWorthNow {
  const investments = investmentValueNow(holdings, quotes, toBase);
  const assetsSum = assetValueNow(assets);
  const liabilitiesSum = liabilityTotalNow(liabilities);
  return {
    investments,
    assets: assetsSum,
    liabilities: liabilitiesSum,
    net: investments + assetsSum - liabilitiesSum,
    hasData: holdings.length > 0 || assets.length > 0 || liabilities.length > 0,
  };
}
