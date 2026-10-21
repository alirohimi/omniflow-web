import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spendingBreakdown } from '../src/insights/expenses';
import type { Expense } from '../src/domain/types';

/**
 * Regression guard: the Expenses tab must surface a real "Spending breakdown"
 * card — selectable window, per-category distribution bars, a 14-day trend
 * strip, payment-method split, top merchants, and budget-vs-cap bars — and
 * not fall back to a native select / bare table that broke on phones.
 */

const here = dirname(fileURLToPath(new URL(import.meta.url)));
const compSrc = readFileSync(join(here, '..', 'src', 'components', 'SpendingBreakdown.tsx'), 'utf8');
const viewSrc = readFileSync(join(here, '..', 'src', 'views', 'ExpensesView.tsx'), 'utf8');
const themeSrc = readFileSync(join(here, '..', 'src', 'theme.css'), 'utf8');

describe('ExpensesView spending-breakdown card', () => {
  it('mounts the SpendingBreakdown component between the capture card and History', () => {
    expect(viewSrc).toContain("import { SpendingBreakdown } from '../components/SpendingBreakdown'");
    expect(viewSrc).toMatch(/<SpendingBreakdown[\s\S]*expenses=\{vault\.expenses\}[\s\S]*budgets=\{vault\.budgets \?\? \[\]\}[\s\S]*baseCurrency=\{base\}/);
    // The capture/imports block closes before the breakdown, and History follows it.
    const idx = viewSrc.indexOf('<SpendingBreakdown');
    expect(idx).toBeGreaterThan(-1);
    expect(viewSrc.indexOf('<h2 className="section-title">History</h2>')).toBeGreaterThan(idx);
  });

  it('is a self-contained component: owns the window selector and all aggregation', () => {
    expect(compSrc).toMatch(/const \[period, setPeriod\] = useState<Period>\('30d'\)/);
    expect(compSrc).toContain("spendingBreakdown(expenses, windowFor(period), Date.now()");
    // No native <select> control — the window picker is a themed segmented control.
    expect(compSrc).not.toContain('<select');
    expect(compSrc).toMatch(/className="seg"/);
  });

  it('renders every aggregation dimension the engine produces', () => {
    expect(compSrc).toContain('data.byCategory');
    expect(compSrc).toContain('data.byPayment');
    expect(compSrc).toContain('data.topMerchants');
    expect(compSrc).toContain('data.trend');
    expect(compSrc).toContain('data.budgets');
  });

  it('maps budget status to the themed track state (watch=warn, over=bad)', () => {
    expect(compSrc).toMatch(/l\.status === 'over' \? 'bad' : l\.status === 'watch' \? 'warn' : ''/);
  });

  it('renders the expanded expense analytics: hero total, delta, biggest-cost callout, interactive donut, and per-category drill-downs', () => {
    // Hero + stats.
    expect(compSrc).toContain('className="ex-hero"');
    expect(compSrc).toContain('data.avgPerDay');
    expect(compSrc).toContain('ex-delta');
    // "What cost the most" callout driven by the engine's largest outflow.
    expect(compSrc).toContain('Largest single cost');
    expect(compSrc).toContain('data.largest');
    // Interactive category donut (stroke-dasharray segments, tap-to-pin).
    expect(compSrc).toContain('ex-donut');
    expect(compSrc).toContain('strokeDasharray');
    expect(compSrc).toContain('setActiveCat');
    // Per-category drill-downs showing the recent transactions that make up
    // the cost (the "reflect what costs the most" detail list).
    expect(compSrc).toContain('ex-drill');
    expect(compSrc).toContain('data.drills');
    expect(compSrc).toContain('ex-drill-items');
  });

  it('styles the expanded analytics with scoped .ex-* classes on the shared glass tokens', () => {
    expect(themeSrc).toContain('.ex-hero');
    expect(themeSrc).toContain('.ex-delta');
    expect(themeSrc).toContain('.ex-callout');
    expect(themeSrc).toContain('.ex-donut');
    expect(themeSrc).toContain('.ex-drillbtn');
    expect(themeSrc).toContain('.ex-drill-items');
    // Up = spend up (bad/red), down = spend down (good/green).
    expect(themeSrc).toMatch(/\.ex-delta\.up/);
    expect(themeSrc).toMatch(/\.ex-delta\.down/);
  });

  it('still styles the legacy .bd-* aggregation rows (category bars, trend, pay, headers)', () => {
    expect(themeSrc).toContain('.bd-cat');
    expect(themeSrc).toContain('.bd-track');
    expect(themeSrc).toContain('.bd-trend');
    expect(themeSrc).toContain('.bd-pay');
    expect(themeSrc).toContain('.bd-h');
    expect(themeSrc).toMatch(/\.bd-track > i\.warn/);
    expect(themeSrc).toMatch(/\.bd-track > i\.bad/);
  });
});

// ---- engine: extended breakdown math (delta, avg/day, largest, drills) ----
const NOW = 1_760_000_000_000;
const D = 86_400_000;
const ex = (over: Partial<Expense>): Expense =>
  ({
    id: 'e1',
    originalAmount: 100,
    originalCurrency: 'MYR',
    baseAmount: 100,
    baseCurrency: 'MYR',
    fxRate: 1,
    category: 'Dining',
    aiTier: 'dictionary',
    merchant: 'Coffee Co',
    timestamp: NOW,
    paymentMethod: 'card',
    source: 'manual',
    ...over,
  }) as Expense;

describe('spendingBreakdown extended fields', () => {
  it('computes prevTotal / deltaPct over the preceding same-length window', () => {
    // 30d window. Current period (last 30d): 300. Preceding 30d: 100.
    const cur = ex({ id: 'c', category: 'Dining', baseAmount: 300, timestamp: NOW - 10 * D });
    const prev = ex({ id: 'p', category: 'Dining', baseAmount: 100, timestamp: NOW - 40 * D });
    const d = spendingBreakdown([cur, prev], { days: 30 }, NOW);
    expect(d.total).toBe(300);
    expect(d.prevTotal).toBe(100);
    expect(d.deltaPct).toBeCloseTo(2.0); // +200%
    expect(d.windowDays).toBe(30);
    expect(d.avgPerDay).toBeCloseTo(300 / 30);
  });

  it('deltaPct is null when the prior period had no spend', () => {
    const cur = ex({ id: 'c', category: 'Dining', baseAmount: 300, timestamp: NOW - 10 * D });
    const d = spendingBreakdown([cur], { days: 30 }, NOW);
    expect(d.prevTotal).toBe(0);
    expect(d.deltaPct).toBeNull();
  });

  it('all-time window has no preceding period (prevTotal / deltaPct null)', () => {
    const d = spendingBreakdown([ex({ category: 'Dining', baseAmount: 50, timestamp: NOW - 200 * D })], { all: true }, NOW);
    expect(d.prevTotal).toBeNull();
    expect(d.deltaPct).toBeNull();
    expect(d.windowDays).toBe(0);
    expect(d.avgPerDay).toBe(0);
  });

  it('picks the single largest outflow', () => {
    const small = ex({ id: 'a', category: 'Dining', baseAmount: 50, timestamp: NOW - 5 * D });
    const big = ex({ id: 'b', category: 'Shopping', baseAmount: 900, merchant: 'Boutique', timestamp: NOW - 3 * D });
    const d = spendingBreakdown([small, big], { days: 30 }, NOW);
    expect(d.largest?.id).toBe('b');
    expect(d.largest?.amount).toBe(900);
    expect(d.largest?.category).toBe('Shopping');
  });

  it('produces per-category drills with up to 5 recent items, most recent first', () => {
    const mk = (id: string, daysAgo: number) =>
      ex({ id, category: 'Groceries', baseAmount: 10, timestamp: NOW - daysAgo * D });
    const many = [mk('a', 1), mk('b', 2), mk('c', 3), mk('d', 4), mk('e', 5), mk('f', 6)];
    const other = ex({ id: 'g', category: 'Utilities', baseAmount: 100, timestamp: NOW - 1 * D });
    const d = spendingBreakdown([other, ...many], { days: 30 }, NOW);
    // Top category by spend is Utilities (100) > Groceries (60).
    expect(d.drills[0].category).toBe('Utilities');
    const groc = d.drills.find((g) => g.category === 'Groceries')!;
    expect(groc.items.length).toBe(5); // capped at 5
    expect(groc.items[0].id).toBe('a'); // most recent first
    expect(groc.total).toBe(60);
  });

  it('drills only include spend, never Income rows', () => {
    const income = ex({ id: 'inc', category: 'Income', baseAmount: 5000, timestamp: NOW - 1 * D });
    const spend = ex({ id: 's', category: 'Dining', baseAmount: 30, timestamp: NOW - 1 * D });
    const d = spendingBreakdown([income, spend], { days: 30 }, NOW);
    expect(d.total).toBe(30);
    expect(d.drills[0].category).toBe('Dining');
  });
});
