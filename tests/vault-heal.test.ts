// ============================================================================
// OmniFlow — vault healing + clobber-safety regression tests.
//
// Covers the white-screen bug class (pitfall #24):
//   1. healVault repairs historically corrupt rows (undefined prices,
//      missing fxRate/timestamp) so a decrypt of an old cloud vault can
//      never crash the render again.
//   2. withoutUndefined strips explicit `undefined` keys so the
//      addHolding / updateHolding / editExpense spread-merge paths can
//      never clobber computed defaults with undefined.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { healVault, withoutUndefined, emptyVault } from '../src/domain/seed';
import type { VaultBlob, InvestmentHolding, Expense } from '../src/domain/types';

function corruptVault(): VaultBlob {
  // Simulates the historical shape: a holding row whose prices clobbered to
  // undefined, a cash row, a corrupt expense, and one healthy row — plus a
  // non-finite entry price (NaN) that JSON round-trips as null.
  const blob = emptyVault();
  blob.holdings = [
    {
      id: 'h-bad',
      accountId: 'acc-1',
      symbol: 'AAPL',
      assetClass: 'equity-us',
      holdingCurrency: 'USD',
      units: 10,
      averageEntryPrice: 100,
      currentPriceLocal: undefined,
      currentPriceBase: undefined,
    } as unknown as InvestmentHolding,
    {
      id: 'h-cash',
      accountId: 'acc-1',
      symbol: 'USD',
      assetClass: 'cash',
      holdingCurrency: 'USD',
      units: 500,
      averageEntryPrice: 1,
      currentPriceLocal: undefined,
      currentPriceBase: undefined,
    } as unknown as InvestmentHolding,
    {
      id: 'h-badprice',
      accountId: 'acc-1',
      symbol: 'BTC',
      assetClass: 'crypto',
      holdingCurrency: 'USD',
      units: 0.5,
      averageEntryPrice: null as unknown as number, // JSON null -> non-finite
      currentPriceLocal: 90000,
      currentPriceBase: 90000,
    } as unknown as InvestmentHolding,
    {
      id: 'h-good',
      accountId: 'acc-1',
      symbol: 'ETH',
      assetClass: 'crypto',
      holdingCurrency: 'USD',
      units: 2,
      averageEntryPrice: 3000,
      currentPriceLocal: 3200,
      currentPriceBase: 3200,
    },
  ];
  blob.expenses = [
    {
      id: 'ex-bad',
      originalAmount: 50,
      baseAmount: undefined as unknown as number,
      baseCurrency: 'MYR',
      fxRate: undefined as unknown as number,
      category: 'Food',
      aiTier: 'llm-byok',
      merchant: 'Test cafe',
      timestamp: undefined as unknown as number,
      paymentMethod: 'card',
      source: 'manual',
    } as unknown as Expense,
  ];
  return blob;
}

describe('healVault (white-screen regression)', () => {
  it('fills undefined holding prices with the pre-clobber defaults', () => {
    const { blob, changed } = healVault(corruptVault());
    const bad = blob.holdings.find((h) => h.id === 'h-bad')!;
    // Default = averageEntryPrice (what addHolding computed pre-clobber).
    expect(bad.currentPriceLocal).toBe(100);
    expect(bad.currentPriceBase).toBe(100);
    expect(changed).toBe(true);
  });

  it('values cash/mmf at par when their prices are undefined', () => {
    const { blob } = healVault(corruptVault());
    const cash = blob.holdings.find((h) => h.id === 'h-cash')!;
    expect(cash.currentPriceLocal).toBe(1);
    expect(cash.currentPriceBase).toBe(1);
  });

  it('repairs a non-finite (null) entry price without dropping the row', () => {
    const { blob } = healVault(corruptVault());
    const btc = blob.holdings.find((h) => h.id === 'h-badprice')!;
    expect(btc.averageEntryPrice).toBe(0);
    // Healthy stored prices are preserved, not touched.
    expect(btc.currentPriceLocal).toBe(90000);
  });

  it('never drops healthy rows', () => {
    const { blob } = healVault(corruptVault());
    const good = blob.holdings.find((h) => h.id === 'h-good')!;
    expect(good.currentPriceLocal).toBe(3200);
    expect(good.currentPriceBase).toBe(3200);
    expect(blob.holdings).toHaveLength(4);
  });

  it('repairs corrupt expenses: missing fxRate -> 1, baseAmount -> amount*fx, timestamp -> now', () => {
    const { blob, changed } = healVault(corruptVault());
    const ex = blob.expenses[0];
    expect(ex.fxRate).toBe(1);
    expect(ex.baseAmount).toBe(50);
    expect(ex.timestamp).toBeTypeOf('number');
    expect(changed).toBe(true);
  });

  it('is a no-op (changed=false) on a clean vault', () => {
    // A truly clean vault (as emptyVault produces) is idempotent through
    // healVault: every normalization is a no-op, so changed stays false.
    // (An *old* encrypted blob — missing the new optional collections —
    // WILL report changed=true, which is the desired repair-and-resave
    // behavior; see the "normalizes missing collections" test below.)
    const { blob, changed } = healVault(emptyVault());
    expect(changed).toBe(false);
    expect(blob.autoInvests).toEqual([]);
    expect(blob.contributions).toEqual([]);
  });

  it('reports changed=true for an old blob that lacks the new collections', () => {
    const blob = emptyVault();
    delete (blob as Partial<VaultBlob>).autoInvests;
    delete (blob as Partial<VaultBlob>).contributions;
    const { blob: out, changed } = healVault(blob);
    expect(changed).toBe(true);
    expect(out.autoInvests).toEqual([]);
    expect(out.contributions).toEqual([]);
  });

  it('normalizes missing collections and optional fields', () => {
    const blob = { ...emptyVault(), holdings: undefined as never, expenses: undefined as never, coachLog: 'nope' as never, llmKey: undefined as never };
    const out = healVault(blob);
    expect(out.blob.holdings).toEqual([]);
    expect(out.blob.expenses).toEqual([]);
    expect(out.blob.llmKey).toBe('');
    expect(out.blob.coachLog).toBeUndefined();
  });

  it('upgrades a legacy default targetMonths of 3 to the new 6-month rule', () => {
    // A vault created under the OLD 3-month rule carries targetMonths: 3 —
    // which was the DEFAULT, not a deliberate pick. The engine would
    // otherwise "respect" it and never apply the new 6 default.
    const blob = emptyVault();
    blob.emergency = { items: [], targetMonths: 3 };
    const { blob: out } = healVault(blob);
    expect(out.emergency!.targetMonths).toBe(6);
  });

  it('does NOT clobber a deliberately picked targetMonths (4-12)', () => {
    const blob = emptyVault();
    blob.emergency = { items: [], targetMonths: 4 };
    const { blob: out } = healVault(blob);
    expect(out.emergency!.targetMonths).toBe(4); // user chose 4, keep it
  });
});

describe('withoutUndefined (spread-clobber regression)', () => {
  it('strips explicit undefined keys so defaults survive a merge', () => {
    const base = { currentPriceLocal: 110, currentPriceBase: 462, units: 5 };
    const input = { units: 5, currentPriceLocal: undefined, currentPriceBase: undefined };
    // The old crash: {...defaults, ...input} let undefined clobber the defaults.
    const safe = { ...base, ...withoutUndefined(input) };
    expect(safe.currentPriceLocal).toBe(110);
    expect(safe.currentPriceBase).toBe(462);
    expect(safe.units).toBe(5);
  });

  it('keeps defined values, including 0 and empty string', () => {
    const r = withoutUndefined({ a: 0, b: '', c: 'x', d: undefined });
    expect(r).toEqual({ a: 0, b: '', c: 'x' });
    expect('d' in r).toBe(false);
  });
});
