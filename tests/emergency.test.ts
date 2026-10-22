// ============================================================================
// OmniFlow — regression tests for the emergency-reserve engine (2026-10-11,
// avg-spend rule reworked 2026-10-21 for Task 006).
// Pins the coverage position the Settings panel and Dashboard card render:
// average-MONTHLY-spend (all non-Income outflows, partial current month
// prorated), derived vs. pinned target, FX conversion of manual lines,
// designated-account liquidity, and the status ladder.
// All inputs are deterministic (explicit `now`), so tests pin exact numbers.
// ============================================================================

import { describe, expect, it } from 'vitest';
import type {
  EmergencyFund,
  Expense,
  InvestmentAccount,
} from '../src/domain/types';
import type { RatesForBase } from '../src/services/fx';
import type { PortfolioSummary } from '../src/ai/portfolio';
import { computeEmergency, essentialMonthlySpend } from '../src/insights/emergency';

const DAY = 86_400_000;
// Fixed 1st of the month at 12:00 local -> current-month daysElapsed = 25,
// daysInMonth = 31 (October).  Prorate factor = 31/25 = 1.24.
const NOW = new Date(2025, 9, 1).getTime();

// 1 MYR = 0.25 USD  =>  1 USD = 4 MYR (toBase divides by the rate).
const fx: RatesForBase = { base: 'MYR', rates: { USD: 0.25 }, asOf: NOW, source: 'offline' };

const expense = (over: Partial<Expense>): Expense =>
  ({
    id: 'e1',
    originalAmount: 100,
    originalCurrency: 'MYR',
    baseAmount: 100,
    fxRate: 1,
    baseCurrency: 'MYR',
    category: 'Housing & Rent',
    merchant: 'Toll',
    timestamp: NOW,
    paymentMethod: 'applepay',
    ...over,
  }) as Expense;

const em = (over: Partial<EmergencyFund>): EmergencyFund => ({
  items: [],
  targetMonths: 6,
  ...over,
});

const account = (over: Partial<InvestmentAccount>): InvestmentAccount =>
  ({ id: 'a1', platformName: 'Luno', accountType: 'crypto', baseCurrencyValue: 0, lastUpdated: NOW, ...over }) as InvestmentAccount;

/** Minimal PortfolioSummary — only the fields computeEmergency reads. */
const portfolio = (byAccount: unknown[]): PortfolioSummary =>
  ({
    baseCurrency: 'MYR',
    totalValueBase: 0,
    totalCostBase: 0,
    byAssetClass: [],
    byAccount: byAccount,
    totalReturnPct: null,
  }) as unknown as PortfolioSummary;

/** A designated account line. `classes` are the asset classes it holds. */
const acctLine = (id: string, platformName: string, valueBase: number, classes: string[]) => ({
  account: account({ id, platformName }),
  lines: classes.map((c) => ({
    holding: { assetClass: c } as never,
    quote: undefined,
    valueBase: 0,
    valueLocal: 0,
    currency: 'MYR',
    ok: true,
  })),
  valueBase,
  valueLocal: valueBase,
  costBase: valueBase,
  returnPct: null,
});

/** 3+ months of spend, pinned. NOW = 1st Oct 2025 00:00 -> complete months
 *  are Aug & Sep 2025; current partial month = Oct (just started, ~1 day).
 *  All non-Income outflows count; income rows + out-of-window months excluded. */
const SPEND = [
  expense({ id: 'aug1', category: 'Transport', baseAmount: 800, timestamp: new Date(2025, 7, 10).getTime() }),
  expense({ id: 'sep1', category: 'Groceries', baseAmount: 300, timestamp: new Date(2025, 8, 5).getTime() }),
  expense({ id: 'sep2', category: 'Entertainment', baseAmount: 200, timestamp: new Date(2025, 8, 24).getTime() }),
  expense({ id: 'jul', category: 'Housing & Rent', baseAmount: 5000, timestamp: new Date(2025, 6, 5).getTime() }),  // out of window
  expense({ id: 'inc', category: 'Income', baseAmount: 5000, timestamp: new Date(2025, 8, 5).getTime() }),     // income
];

describe('essentialMonthlySpend', () => {
  it('averages complete calendar months and prorates the partial current month', () => {
    // Aug complete: 800
    // Sep complete: 300+200 = 500
    // Oct current (partial, ~1 day elapsed, 0 spend): prorates to 0
    // average = (800 + 500 + 0) / 3 = 433.33
    expect(essentialMonthlySpend(SPEND, 'MYR', NOW)).toBeCloseTo(433.33, 0);
  });

  it('prorates a partial current month up to its full-month equivalent', () => {
    // Pin NOW to a full UTC day boundary so the proration fraction is
    // timezone-deterministic: local "Sep 25 00:00" in WIB (UTC+7) is
    // Sep 24 17:00 UTC, 23.67 days into Sep -> daysElapsed = round(23.67)
    // = 24, daysInMonth = 30, proration = 100 * (30/24) = 125.
    const now = new Date(Date.UTC(2025, 8, 25, 0, 0, 0)).getTime();
    const rows = [
      expense({ id: 'a', category: 'Groceries', baseAmount: 100, timestamp: new Date(Date.UTC(2025, 8, 2)).getTime() }),
    ];
    // 3 windows: Jul (complete, empty -> 0), Aug (complete, empty -> 0),
    // Sep current partial: 100 * (30 / 24 elapsed) = 125.
    // average = (0 + 0 + 125) / 3 = 41.67.
    expect(essentialMonthlySpend(rows, 'MYR', now)).toBeCloseTo(41.67, 0);
  });

  it('is zero when no spending exists', () => {
    expect(essentialMonthlySpend([expense({ category: 'Income', baseAmount: 500, timestamp: NOW })], 'MYR', NOW)).toBe(0);
  });

  it('treats a no-spend complete month as a known 0 (pulls the average down)', () => {
    const noSpendMonth = [
      expense({ id: 'a', category: 'Groceries', baseAmount: 300, timestamp: new Date(2025, 7, 20).getTime() }), // Aug
      // Sep has no spending -> counts as 0; Oct partial -> 0
    ];
    // (800 absent) (0 + 300 + 0) / 3 = 100.  A no-spend month must NOT be skipped.
    expect(essentialMonthlySpend(noSpendMonth, 'MYR', NOW)).toBeCloseTo(100, 0);
  });
});

describe('computeEmergency', () => {
  it('derives target = months x average monthly spend; a manual line is FX-converted to base', () => {
    const r = computeEmergency({
      emergency: em({ items: [{ id: 'm1', kind: 'manual', name: 'Bank HYSA', amount: 150, currency: 'USD', createdAt: NOW }] }),
      expenses: SPEND,
      accounts: [],
      portfolio: null,
      fx,
      base: 'MYR',
      now: NOW,
    });
    // 150 USD / 0.25 = 600 MYR reserve.  monthlySpend = 433.33 (from the
    // SPEND dataset above), target = 433.33 * 6 (default months) = 2600.
    expect(r.reserve).toBe(600);
    expect(r.monthlySpend).toBeCloseTo(433.33, 0);
    expect(r.targetMonths).toBe(6);
    expect(r.target).toBeCloseTo(2600, 0);
    expect(r.targetSource).toBe('derived');
    expect(r.coverageMonths).toBeCloseTo(1.4, 1); // 600 / 433.33
    expect(r.status).toBe('building'); // reserve < target
    expect(r.liquidValue).toBe(600); // manual reserve counts as liquid
    expect(r.investedValue).toBe(0);
    expect(r.gap).toBeCloseTo(2000, 0);
  });

  it('an explicit user-set targetMonths (e.g. 3) is respected over the 6 default', () => {
    const r = computeEmergency({
      emergency: em({
        targetMonths: 3,
        items: [{ id: 'm1', kind: 'manual', name: 'Bank', amount: 150, currency: 'USD', createdAt: NOW }],
      }),
      expenses: SPEND,
      accounts: [],
      portfolio: null,
      fx,
      base: 'MYR',
      now: NOW,
    });
    expect(r.targetMonths).toBe(3);
    expect(r.target).toBeCloseTo(433.33 * 3, 0); // 1300
    expect(r.targetSource).toBe('derived');
  });

  it('a pinned override wins over the months-derived target and sets the gap', () => {
    const r = computeEmergency({
      emergency: em({
        targetOverrideBase: 1000,
        items: [{ id: 'm1', kind: 'manual', name: 'Bank', amount: 150, currency: 'USD', createdAt: NOW }],
      }),
      expenses: SPEND,
      accounts: [],
      portfolio: null,
      fx,
      base: 'MYR',
      now: NOW,
    });
    expect(r.target).toBe(1000);
    expect(r.targetSource).toBe('override');
    expect(r.reserve).toBe(600);
    expect(r.status).toBe('building');
    expect(r.gap).toBe(400);
    expect(r.pctOfTarget).toBe(60);
  });

  it('treats an empty designated account as liquid; an invested one as not', () => {
    const r = computeEmergency({
      emergency: em({
        items: [
          { id: 'x1', kind: 'account', name: 'Luno', accountId: 'a1', currency: 'MYR', createdAt: NOW }, // equity -> invested
          { id: 'x2', kind: 'account', name: 'Cashbox', accountId: 'a2', currency: 'MYR', createdAt: NOW }, // empty -> liquid
        ],
      }),
      expenses: SPEND,
      accounts: [],
      portfolio: portfolio([acctLine('a1', 'Luno', 1200, ['equity']), acctLine('a2', 'Cashbox', 500, [])]),
      fx,
      base: 'MYR',
      now: NOW,
    });
    // reserve = 1200 + 500
    expect(r.reserve).toBe(1700);
    expect(r.liquidValue).toBe(500); // empty account is liquid
    expect(r.investedValue).toBe(1200); // equity account is invested
    const x1 = r.lines.find((l) => l.id === 'x1')!;
    const x2 = r.lines.find((l) => l.id === 'x2')!;
    expect(x1.liquid).toBe(false);
    expect(x1.live).toBe(true);
    expect(x2.liquid).toBe(true);
  });

  it('an account not present in the live portfolio is live=false with zero value', () => {
    const r = computeEmergency({
      emergency: em({ items: [{ id: 'z', kind: 'account', name: 'Ghost', accountId: 'nope', currency: 'MYR', createdAt: NOW }] }),
      expenses: SPEND,
      accounts: [],
      portfolio: portfolio([]),
      fx,
      base: 'MYR',
      now: NOW,
    });
    const z = r.lines.find((l) => l.id === 'z')!;
    expect(z.live).toBe(false);
    expect(z.valueBase).toBe(0);
    expect(r.reserve).toBe(0);
  });

  it('reports "none" when there are no lines and no spend base', () => {
    const r = computeEmergency({
      emergency: em({}),
      expenses: [],
      accounts: [],
      portfolio: null,
      fx,
      base: 'MYR',
      now: NOW,
    });
    expect(r.status).toBe('none');
    expect(r.coverageMonths).toBeNull(); // no spend base to measure against
    expect(r.target).toBe(0);
    expect(r.targetSource).toBe('zero-spend');
  });

  it('a manual line in the base currency bypasses FX entirely', () => {
    const r = computeEmergency({
      emergency: em({ items: [{ id: 'b1', kind: 'manual', name: 'Domestic cash', amount: 200, currency: 'MYR', createdAt: NOW }] }),
      expenses: [],
      accounts: [],
      portfolio: null,
      fx: null, // no table — but base currency needs none
      base: 'MYR',
      now: NOW,
    });
    expect(r.reserve).toBe(200);
  });

  it('a foreign-currency manual line with no FX table contributes 0 (never invents a rate)', () => {
    const r = computeEmergency({
      emergency: em({ items: [{ id: 'f1', kind: 'manual', name: 'USD', amount: 100, currency: 'USD', createdAt: NOW }] }),
      expenses: [],
      accounts: [],
      portfolio: null,
      fx: null,
      base: 'MYR',
      now: NOW,
    });
    expect(r.reserve).toBe(0);
  });
});
