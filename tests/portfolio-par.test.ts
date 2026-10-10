// ============================================================================
// OmniFlow — regression tests for the 2026-10-08 "cash inputs off" +
// blank-portfolio bugs:
//   (1) a cash/MMF row with no stored price must value at PAR (1), not 0;
//   (2) a corrupt row with an unknown FX currency must be uncounted (0),
//       never NaN — the aggregate must survive;
//   (3) live quotes override corrupt/missing stored prices;
//   (4) buildPortfolio totals stay finite and flag uncounted rows.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { valueInBase, buildPortfolio } from '../src/ai/portfolio';
import { fxService } from '../src/services/fx';
import type { RatesForBase } from '../src/services/fx';
import type { InvestmentHolding, QuoteSnapshot } from '../src/domain/types';

/** 1 base = rates[code] code. toBase(1, code) = 1 / rates[code]. */
const myrFx = (usdRate: number): RatesForBase => ({
  base: 'MYR',
  rates: { MYR: 1, USD: 1 / usdRate },
  asOf: 0,
  source: 'offline',
});
/** NaN-guarded rate function: unknown currencies contribute 0, never NaN. */
const ratesOf = (fx: RatesForBase) => (code: string): number => {
  const r = fxService.toBase(1, code, fx);
  return Number.isFinite(r) ? r : 0;
};

const holding = (over: Partial<InvestmentHolding>): InvestmentHolding => ({
  id: 'h1',
  accountId: 'a1',
  symbol: 'CASH',
  assetClass: 'cash',
  holdingCurrency: 'MYR',
  units: 1500,
  averageEntryPrice: 1,
  ...over,
} as InvestmentHolding);

describe('valueInBase — par + corrupt handling', () => {
  it('a cash row with NO stored price values at par (1), not 0', () => {
    const h = holding({ currentPriceLocal: undefined });
    const fx = myrFx(4.3);
    const { valueBase, ok, costBase } = valueInBase(h, undefined, 'MYR', ratesOf(fx));
    expect(ok).toBe(true);
    expect(valueBase).toBe(1500); // 1500 units x par 1 x rate 1
    expect(costBase).toBe(1500);
  });

  it('a foreign-currency cash row converts its par amount', () => {
    const h = holding({ symbol: 'CASH', holdingCurrency: 'USD', units: 100 });
    const fx = myrFx(4.3);
    const { valueBase, ok } = valueInBase(h, undefined, 'MYR', ratesOf(fx));
    expect(ok).toBe(true);
    expect(valueBase).toBeCloseTo(430, 6); // 100 x 1 x 4.3
  });

  it('a corrupt equity row with an unknown FX currency is uncounted, not NaN', () => {
    const h = holding({
      symbol: 'GHOST',
      assetClass: 'equity-local',
      holdingCurrency: 'XYZ',
      units: 3,
      averageEntryPrice: 0,
      currentPriceLocal: undefined,
    });
    const fx = myrFx(4.3);
    const { valueBase, ok } = valueInBase(h, undefined, 'MYR', ratesOf(fx));
    expect(ok).toBe(false);
    expect(valueBase).toBe(0);
    expect(Number.isNaN(valueBase)).toBe(false);
  });

  it('a live quote overrides a corrupt/missing stored price', () => {
    const h = holding({
      symbol: 'AAPL',
      assetClass: 'equity-us',
      holdingCurrency: 'USD',
      units: 5,
      averageEntryPrice: 180,
      currentPriceLocal: undefined,
    });
    const quote: QuoteSnapshot = {
      symbol: 'AAPL',
      assetClass: 'equity-us',
      price: 200,
      currency: 'USD',
      asOf: Date.now(),
      source: 'yahoo',
    };
    const fx = myrFx(4.0);
    const { valueBase, ok, costBase } = valueInBase(h, quote, 'MYR', ratesOf(fx));
    expect(ok).toBe(true);
    expect(valueBase).toBe(4000); // 200 x 5 x 4.0
    expect(costBase).toBe(3600); // 180 x 5 x 4.0
  });
});

describe('buildPortfolio — offline with corrupt holdings', () => {
  it('counts healthy rows, flags corrupt ones, totals stay finite', () => {
    const fx = myrFx(4.0);
    const healthy = holding({
      symbol: 'AAPL',
      assetClass: 'equity-us',
      holdingCurrency: 'USD',
      units: 5,
      averageEntryPrice: 180,
      currentPriceLocal: 200,
      currentPriceBase: 800,
    });
    const corruptCash = holding({
      id: 'h2',
      symbol: 'CASH',
      assetClass: 'cash',
      holdingCurrency: 'MYR',
      units: 1500,
      averageEntryPrice: 1,
      currentPriceLocal: undefined, // legacy corrupt row: par heal must kick in
      currentPriceBase: undefined,
    });
    const corruptEquity = holding({
      id: 'h3',
      symbol: 'GHOST',
      assetClass: 'equity-local',
      holdingCurrency: 'XYZ',
      units: 3,
      averageEntryPrice: 0,
      currentPriceLocal: undefined,
      currentPriceBase: undefined,
    });
    const p = buildPortfolio([], [healthy, corruptCash, corruptEquity], {}, 'MYR', ratesOf(fx));
    // healthy: 200 x 5 x 4.0 = 4000; corrupt cash (par, MYR): 1500; corrupt
    // equity: 0 (uncounted).
    expect(p.totalValueBase).toBe(5500);
    expect(Number.isFinite(p.totalValueBase)).toBe(true);
    expect(p.uncounted).toBe(1);
    expect(p.liveQuoteCount).toBe(0);
    expect(p.staleQuoteCount).toBe(3);
    // per-account lines are untouched with zero accounts — totals still sound
    expect(p.byAccount).toHaveLength(0);
  });
});
