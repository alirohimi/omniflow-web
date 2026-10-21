// ============================================================================
// OmniFlow — regression tests for the insights engines (2026-10-11 batch):
// budgets, debt payoff, net worth, forecast, recurring detection, rebalance,
// dividends, P&L. All inputs are deterministic (explicit `now`), so tests pin
// exact numbers.
// ============================================================================

import { describe, expect, it } from 'vitest';
import type {
  Budget,
  Dividend,
  Disposal,
  Expense,
  Liability,
  ManualAsset,
  Recurring,
} from '../src/domain/types';

// ---- budgets -------------------------------------------------------------
import {
  budgetReport,
  monthlyCap,
  periodToMonthlyFactor,
  rolloverCap,
} from '../src/insights/budgets';

const NOW = 1_760_000_000_000;
const expense = (over: Partial<Expense>): Expense =>
  ({
    id: 'e1',
    originalAmount: 100,
    originalCurrency: 'MYR',
    baseAmount: 100,
    fxRate: 1,
    baseCurrency: 'MYR',
    category: 'Dining',
    merchant: 'Kopitiam',
    timestamp: NOW,
    paymentMethod: 'applepay',
    ...over,
  }) as Expense;

describe('budgets', () => {
  it('periodToMonthlyFactor', () => {
    expect(periodToMonthlyFactor('monthly')).toBe(1);
    expect(periodToMonthlyFactor('daily')).toBeCloseTo(30.4);
    expect(periodToMonthlyFactor('yearly')).toBeCloseTo(1 / 12);
  });

  it('monthlyCap guards non-finite/negative', () => {
    const b = (over: Partial<Budget>): Budget =>
      ({ id: 'b', category: 'Dining', cap: 1000, period: 'monthly', rollover: false, createdAt: NOW, ...over }) as Budget;
    expect(monthlyCap(b({ cap: 1000 }))).toBe(1000);
    expect(monthlyCap(b({ cap: 100, period: 'weekly' }))).toBeCloseTo(434.5);
    expect(monthlyCap(b({ cap: Number.NaN }))).toBe(0);
    expect(monthlyCap(b({ cap: -5 }))).toBe(0);
  });

  it('budgetReport statuses', () => {
    const b: Budget = { id: 'b', category: 'Dining', cap: 300, period: 'monthly', rollover: false, createdAt: NOW };
    const expenses = [
      expense({ id: 'a', category: 'Dining', baseAmount: 200, timestamp: NOW - 86_400_000 }),
      expense({ id: 'b', category: 'Income', baseAmount: 5000, timestamp: NOW }), // excluded
      expense({ id: 'c', category: 'Other', baseAmount: 999, timestamp: NOW }), // other cat
      expense({ id: 'd', category: 'Dining', baseAmount: 1, timestamp: NOW - 40 * 86_400_000 }), // out of window
    ];
    const [line] = budgetReport([b], expenses, NOW);
    expect(line.spent).toBe(200);
    expect(line.status).toBe('on-track');
    expect(line.pct).toBeCloseTo(2 / 3);
  });

  it('rolloverCap carries unused prior cap only when enabled', () => {
    const b: Budget = { id: 'b', category: 'S', cap: 1000, period: 'monthly', rollover: true, createdAt: NOW };
    expect(rolloverCap(b, 1000, 300).effectiveCap).toBe(1700); // carry 700
    expect(rolloverCap({ ...b, rollover: false }, 1000, 300).effectiveCap).toBe(1000);
    expect(rolloverCap(b, 1000, 1500).carry).toBe(0); // overspent prior -> no carry
  });
});

// ---- debt ----------------------------------------------------------------
import { bestStrategy, simulatePayoff } from '../src/insights/debt';

const liab = (over: Partial<Liability>): Liability =>
  ({ id: 'l', name: 'CC', balance: 1200, apr: 24, minPayment: 100, ...over }) as Liability;

describe('debt payoff', () => {
  it('single debt pays off; total interest finite', () => {
    const plan = simulatePayoff([liab({})], 'avalanche');
    expect(plan.months).toBeGreaterThan(0);
    expect(plan.months).toBeLessThan(24); // 1200 @24% min 100/month
    expect(plan.totalInterest).toBeGreaterThan(0);
    expect(Number.isFinite(plan.totalInterest)).toBe(true);
    expect(plan.retired).toEqual([{ name: 'CC', month: plan.months }]);
  });

  it('empty/invalid liabilities produce empty plan', () => {
    const plan = simulatePayoff([liab({ balance: Number.NaN }), liab({ balance: 0 })], 'snowball');
    expect(plan.months).toBe(0);
    expect(plan.steps).toEqual([]);
  });

  it('avalanche beats snowball on total interest for spread APRs', () => {
    const debts = [liab({ id: 'a', name: 'A', balance: 5000, apr: 3, minPayment: 100 }), liab({ id: 'b', name: 'B', balance: 2000, apr: 28, minPayment: 80 })];
    const a = simulatePayoff(debts, 'avalanche', 500);
    const s = simulatePayoff(debts, 'snowball', 500);
    expect(a.totalInterest).toBeLessThanOrEqual(s.totalInterest + 1e-9);
    expect(bestStrategy(debts, 500).strategy).toBe('avalanche');
  });
});

// ---- net worth -----------------------------------------------------------
import { netWorthNow } from '../src/insights/networth';

describe('net worth', () => {
  it('sums investments + assets - liabilities, NaN-proof', () => {
    const toBase = (_amt: number, from: string) => (from === 'USD' ? _amt * 4.5 : from === 'MYR' ? _amt : 0);
    const holdings = [
      { id: 'h1', accountId: 'a1', symbol: 'AAPL', assetClass: 'equity', holdingCurrency: 'USD', units: 10, averageEntryPrice: 100, currentPriceLocal: 110, currentPriceBase: 495 } as any,
      { id: 'h2', accountId: 'a1', symbol: 'BTC', assetClass: 'crypto', holdingCurrency: 'USD', units: Number.NaN, averageEntryPrice: 0, currentPriceLocal: 0, currentPriceBase: 0 } as any, // corrupt row
    ];
    const assets = [{ id: 'm1', name: 'Savings', value: 5000, kind: 'bank' } as ManualAsset];
    const liabilities = [liab({ balance: 3000 })];
    const nw = netWorthNow(holdings, {}, assets, liabilities, toBase);
    expect(nw.investments).toBe(4950); // 495 * 10
    expect(nw.net).toBe(4950 + 5000 - 3000);
    expect(nw.hasData).toBe(true);
  });

  it('empty vault -> hasData false, zero net', () => {
    const nw = netWorthNow([], {}, [], [], () => 0);
    expect(nw.hasData).toBe(false);
    expect(nw.net).toBe(0);
  });
});

// ---- forecast ------------------------------------------------------------
import { forecastCashFlow } from '../src/insights/forecast';

describe('cash-flow forecast', () => {
  it('projects a deficit to first-negative month', () => {
    // Income 3000/mo, expenses 4000/mo -> -1000/mo; start 2500 -> negative at month 3.
    const expenses: Expense[] = [];
    const plan = forecastCashFlow(2500, 12, expenses, [
      {
        id: 'r1', name: 'Rent', merchant: 'Landlord', amount: 4000, currency: 'MYR', baseAmount: 4000, fxRate: 1,
        period: 'monthly', nextDue: NOW, category: 'Housing', active: true,
      } as Recurring,
    ], 'MYR', NOW);
    // No expense income in history -> monthlyIncome 0; expenses 4000 -> net -4000/mo
    expect(plan.firstNegativeMonth).toBe(1);
    expect(plan.points.length).toBe(12);
    expect(plan.netPerMonth).toBe(-4000);
  });

  it('surplus never goes negative', () => {
    const plan = forecastCashFlow(1000, 6, [], [], 'MYR', NOW);
    expect(plan.firstNegativeMonth).toBeNull();
    expect(plan.points[5].balance).toBe(1000);
  });

  it('start balance already negative -> firstNegativeMonth is null (already broke)', () => {
    const plan = forecastCashFlow(-500, 6, [], [], 'MYR', NOW);
    expect(plan.firstNegativeMonth).toBeNull();
    // Balance just drifts further negative each month.
    expect(plan.points[0].balance).toBe(-500);
  });

  it('start negative but recovering -> still null (never "first went" negative in-horizon)', () => {
    // start -500, income 3000/mo -> net +3000/mo, recovers to positive by month 1.
    const exps = [expense({ id: 'inc1', category: 'Income', baseAmount: 9000, timestamp: NOW - 30 * 86_400_000 })];
    const plan = forecastCashFlow(-500, 6, exps, [], 'MYR', NOW);
    expect(plan.firstNegativeMonth).toBeNull();
    expect(plan.points[1].balance).toBeGreaterThan(0);
  });
});

// ---- recurring detection --------------------------------------------------
import { detectRecurring, recurringMonthlyTotal, upcomingBills } from '../src/insights/recurring';

describe('recurring', () => {
  it('detects repeat merchants with monthly cadence', () => {
    const day = 86_400_000;
    const ex = (i: number): Expense =>
      expense({ id: `s${i}`, merchant: 'StreamingCo', originalAmount: 45, baseAmount: 45, timestamp: NOW - (3 - i) * 30 * day, category: 'Entertainment' });
    const oneOff = expense({ id: 'o', merchant: 'OneShop', category: 'Shopping' });
    const cands = detectRecurring([ex(0), ex(1), ex(2), oneOff], 3);
    expect(cands).toHaveLength(1);
    expect(cands[0].merchant).toBe('streamingco');
    expect(cands[0].period).toBe('monthly');
    expect(cands[0].typicalAmount).toBe(45);
  });

  it('upcomingBills respects window and active flag', () => {
    const day = 86_400_000;
    const rec = (over: Partial<Recurring>): Recurring =>
      ({ id: 'r', name: 'Net', merchant: 'Telecom', amount: 100, currency: 'MYR', baseAmount: 100, fxRate: 1, period: 'monthly', nextDue: NOW, category: 'Utilities', active: true, ...over }) as Recurring;
    const bills = upcomingBills(
      [rec({ id: 'soon', nextDue: NOW + 2 * day }), rec({ id: 'late', nextDue: NOW + 40 * day }), rec({ id: 'off', nextDue: NOW, active: false }), rec({ id: 'late', name: 'Old', nextDue: NOW - day })],
      NOW,
      7,
    );
    const ids = bills.map((b) => b.id);
    expect(ids).toContain('soon');
    expect(ids).toContain('late'); // the overdue one (daysUntilDue -1)
    expect(ids).not.toContain('off');
    expect(bills[0].daysUntilDue).toBe(-1); // overdue first
  });

  it('recurringMonthlyTotal converts cadences', () => {
    const rec = (over: Partial<Recurring>): Recurring =>
      ({ id: 'r', name: 'x', merchant: 'x', amount: 0, currency: 'MYR', baseAmount: 100, fxRate: 1, period: 'monthly', nextDue: NOW, category: '', active: true, ...over }) as Recurring;
    const t = recurringMonthlyTotal([rec({}), rec({ id: 'w', period: 'weekly' }), rec({ id: 'y', period: 'yearly' })]);
    expect(t).toBeCloseTo(100 + 100 * 4.345 + 100 / 12, 2);
  });
});

// ---- rebalance ------------------------------------------------------------
import { planRebalance, sizeByClass } from '../src/insights/rebalance';

describe('rebalance', () => {
  const toBase = (_a: number, from: string) => (from === 'USD' ? _a * 4.5 : _a);
  const holdings = [
    { id: 'h1', accountId: 'a', symbol: 'VTSAX', assetClass: 'etf', holdingCurrency: 'USD', units: 100, averageEntryPrice: 100, currentPriceLocal: 200, currentPriceBase: 900 } as any, // 90000
    { id: 'h2', accountId: 'a', symbol: 'BND', assetClass: 'etf', holdingCurrency: 'USD', units: 100, averageEntryPrice: 100, currentPriceLocal: 100, currentPriceBase: 450 } as any, // 45000
    { id: 'h3', accountId: 'a', symbol: 'CASH', assetClass: 'cash', holdingCurrency: 'USD', units: 2000, averageEntryPrice: 1, currentPriceLocal: 1, currentPriceBase: 4.5 } as any, // 9000
  ];
  const total = 144000;

  it('sizeByClass aggregates by class', () => {
    const s = sizeByClass(holdings, {}, toBase);
    expect(s.total).toBeCloseTo(total);
    expect(s.byClass.etf).toBeCloseTo(135000);
    expect(s.byClass.cash).toBeCloseTo(9000);
  });

  it('target drift far beyond band emits buy/sell', () => {
    const plan = planRebalance(holdings, {}, { etf: 0.6, cash: 0.4 }, toBase, 0.05);
    // current: etf 135000/144000 = 0.9375, cash 0.0625; target etf .6 -> big sell of etf, buy cash
    expect(plan.drift).toBeGreaterThan(0.3);
    const sellVts = plan.orders.find((o) => o.symbol === 'VTSAX');
    const buyCash = plan.orders.find((o) => o.symbol === 'CASH');
    expect(sellVts?.direction).toBe('sell');
    expect(buyCash?.direction).toBe('buy');
    expect(plan.turnover).toBeGreaterThan(0);
  });

  it('drift below band -> all hold, zero turnover', () => {
    const plan = planRebalance(holdings, {}, { etf: 0.94, cash: 0.06 }, toBase, 0.05);
    expect(plan.drift).toBeLessThan(0.05);
    expect(plan.orders.every((o) => o.direction === 'hold')).toBe(true);
    expect(plan.turnover).toBe(0);
  });
});

// ---- dividends ------------------------------------------------------------
import { dividendsByHolding, dividendsTotal, dividendYields } from '../src/insights/dividends';

const div = (over: Partial<Dividend>): Dividend =>
  ({ id: 'd1', holdingId: 'h1', symbol: 'AAPL', amount: 10, currency: 'USD', date: NOW - 86_400_000, reinvested: false, ...over }) as Dividend;

describe('dividends', () => {
  const toBase = (_a: number, from: string) => (from === 'USD' ? _a * 4.5 : _a);
  it('total in base currency, window respected', () => {
    const ds = [div({}), div({ id: 'd2', date: NOW - 400 * 86_400_000 })];
    expect(dividendsTotal(ds, toBase)).toBeCloseTo(90);
    expect(dividendsTotal(ds, toBase, NOW - 365 * 86_400_000)).toBeCloseTo(45);
  });

  it('byHolding splits reinvested vs cash', () => {
    const ds = [div({ reinvested: true, amount: 4 }), div({ id: 'd3', reinvested: false, amount: 6 })];
    const [row] = dividendsByHolding(ds, toBase);
    expect(row.totalReinvested).toBeCloseTo(18);
    expect(row.totalCash).toBeCloseTo(27);
    expect(row.eventCount).toBe(2);
  });

  it('yieldOnCost needs cost basis + income', () => {
    const holdings = [{ id: 'h1', accountId: 'a', symbol: 'AAPL', assetClass: 'equity', holdingCurrency: 'USD', units: 10, averageEntryPrice: 100, currentPriceLocal: 110, currentPriceBase: 495 } as any];
    const ds = [div({ amount: 100, date: NOW - 86_400_000, reinvested: false })];
    const y = dividendYields(ds, holdings, toBase, toBase, NOW);
    // 100 USD received -> 450 base; cost basis 1000 USD -> 4500 base => 10%
    expect(y[0].yieldOnCostPct).toBeCloseTo(10);
  });
});

// ---- P&L -----------------------------------------------------------------
import { pnlSummary, pnlToCsv, realisedPerDisposal } from '../src/insights/pnl';

const disp = (over: Partial<Disposal>): Disposal =>
  ({ id: 'p1', holdingId: 'h1', symbol: 'AAPL', units: 10, salePrice: 120, currency: 'USD', costBasisPerUnit: 100, date: NOW - 86_400_000, ...over }) as Disposal;

describe('P&L / disposals', () => {
  const toBase = (_a: number, from: string) => (from === 'USD' ? _a * 4.5 : _a);
  it('realised pnl = (sale - cost) * units in base', () => {
    const [r] = realisedPerDisposal([disp({})], toBase);
    expect(r.pnl).toBeCloseTo((120 - 100) * 10 * 4.5); // 900
  });

  it('summary splits winners/losers, window filters', () => {
    const ds = [disp({}), disp({ id: 'p2', symbol: 'TSLA', units: 5, salePrice: 80, costBasisPerUnit: 90 })];
    const s = pnlSummary(ds, toBase, NOW - 60 * 86_400_000);
    expect(s.countInWindow).toBe(2);
    expect(s.winners).toHaveLength(1);
    expect(s.losers).toHaveLength(1);
    expect(s.totalRealisedInWindow).toBeCloseTo(900 - 225); // 675 net
  });

  it('csv is deterministic and quotes symbols with commas', () => {
    const ds = [disp({ symbol: 'ACME, INC' })];
    const csv = pnlToCsv(ds, toBase, 'MYR');
    expect(csv.split('\n')).toHaveLength(2);
    expect(csv).toContain('"ACME, INC"');
    expect(csv.startsWith('date,symbol,units,saleValueBase,costValueBase,pnlBase')).toBe(true);
  });
});
