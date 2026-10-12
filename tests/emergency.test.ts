// ============================================================================
// OmniFlow — regression tests for the emergency-reserve engine (2026-10-11).
// Pins the coverage position the Settings panel and Dashboard card render:
// essential-spend filtering, derived vs. pinned target, FX conversion of
// manual lines, designated-account liquidity, and the status ladder.
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

const NOW = 1_760_000_000_000;
const D = 86_400_000;

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
  targetMonths: 3,
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

/** 90-day essential spend, pinned: only in-window essential categories count. */
const SPEND = [
  expense({ id: 's1', category: 'Housing & Rent', baseAmount: 300, timestamp: NOW - 30 * D }),
  expense({ id: 's2', category: 'Groceries', baseAmount: 300, timestamp: NOW - 10 * D }),
  expense({ id: 's3', category: 'Entertainment', baseAmount: 999, timestamp: NOW }), // non-essential
  expense({ id: 's4', category: 'Housing & Rent', baseAmount: 1000, timestamp: NOW - 100 * D }), // out of window
  expense({ id: 's5', category: 'Income', baseAmount: 5000, timestamp: NOW - 5 * D }), // income
];

describe('essentialMonthlySpend', () => {
  it('averages 90-day essential spend and skips non-essential / income / out-of-window', () => {
    // (300 + 300) / 3 = 200.  s3 (entertainment), s4 (>90d), s5 (income) excluded.
    expect(essentialMonthlySpend(SPEND, 'MYR', NOW)).toBe(200);
  });

  it('is zero when no essential spending exists', () => {
    expect(essentialMonthlySpend([expense({ category: 'Entertainment', baseAmount: 500, timestamp: NOW })], 'MYR', NOW)).toBe(0);
  });
});

describe('computeEmergency', () => {
  it('derives target = months x essential spend; a manual line is FX-converted to base', () => {
    const r = computeEmergency({
      emergency: em({ items: [{ id: 'm1', kind: 'manual', name: 'Bank HYSA', amount: 150, currency: 'USD', createdAt: NOW }] }),
      expenses: SPEND,
      accounts: [],
      portfolio: null,
      fx,
      base: 'MYR',
      now: NOW,
    });
    // 150 USD / 0.25 = 600 MYR reserve.  target = 200 * 3 = 600.
    expect(r.reserve).toBe(600);
    expect(r.monthlyEssential).toBe(200);
    expect(r.target).toBe(600);
    expect(r.targetSource).toBe('derived');
    expect(r.coverageMonths).toBe(3);
    expect(r.status).toBe('ok');
    expect(r.liquidValue).toBe(600); // manual reserve counts as liquid
    expect(r.investedValue).toBe(0);
    expect(r.gap).toBe(0);
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
    expect(r.coverageMonths).toBeNull(); // no essential spend to measure against
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
