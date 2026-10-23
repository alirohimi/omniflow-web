// ============================================================================
// OmniFlow — SalaryInputCard period/UX contract tests (Task 011).
//
// The salary figure is STORED as a per-month equivalent (SalaryProfile
// contract: amountPerMonth + period). The card may display it in mo/wk/yr,
// and switching units must re-express the SAME value in the new unit —
// never show a stale per-month number under a "yr" label (the reported bug:
// clicking yr read "≈ RM667/mo" while the box still held the per-month
// figure). These tests pin the conversion math and the card's source
// contract so a regression is caught.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { periodToMonthly } from '../src/insights/forecast';

const viewSrc = (() => {
  const { readFileSync } = require('node:fs');
  const { fileURLToPath } = require('node:url');
  const { dirname, join } = require('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, '../src/views/DashboardView.tsx'), 'utf8');
})();

/** Same math the card uses: express a stored per-month equivalent in a unit. */
const unitAmount = (perMonth: number, to: string) =>
  perMonth / (periodToMonthly(1, to) || 1);

describe('SalaryInputCard period conversion (Task 011)', () => {
  it('expresses a stored yearly salary in every unit without drift', () => {
    // 10,000/yr stored -> amountPerMonth = 10000/12 = 833.33...
    const perMonth = periodToMonthly(10_000, 'yearly');
    expect(perMonth).toBeCloseTo(833.333, 1);

    // Re-expressing back to yearly recovers the original figure.
    expect(unitAmount(perMonth, 'yearly')).toBeCloseTo(10_000, 0);
    // Weekly view of the same income.
    expect(unitAmount(perMonth, 'weekly')).toBeCloseTo(10_000 / 12 / 4.345, 0);
    // Monthly view is the stored value itself.
    expect(unitAmount(perMonth, 'monthly')).toBeCloseTo(perMonth, 1);
  });

  it('a weekly-declared salary round-trips through the stored value', () => {
    // User types 250/wk -> stored per-month = 250 * 4.345 = 1086.25
    const perMonth = periodToMonthly(250, 'weekly');
    expect(unitAmount(perMonth, 'weekly')).toBeCloseTo(250, 0);
    expect(unitAmount(perMonth, 'yearly')).toBeCloseTo(250 * 4.345 * 12, 0);
  });

  it('the card source pins the Task 011 UX contract', () => {
    // Unit switch re-expresses the saved value in the selected unit.
    expect(viewSrc).toMatch(/switchPeriod/);
    expect(viewSrc).toMatch(/unitAmount\(salary\.amountPerMonth/);
    // The input shows the figure in the SELECTED unit, and is read-only
    // while the draft is clean (the "always editable" confusion fix).
    expect(viewSrc).toMatch(/disabled=\{salary != null && !dirty\}/);
    expect(viewSrc).toMatch(/data-salary-input/);
    // Save converts the typed figure in the selected unit to the stored
    // per-month equivalent (NOT the raw number, which was the old bug).
    expect(viewSrc).toMatch(/amountPerMonth: periodToMonthly\(num, period\)/);
    // Remove stays reachable and clears to null.
    expect(viewSrc).toMatch(/setSalary\(null\)/);
    // Periods offered: mo / wk / yr.
    expect(viewSrc).toMatch(/\[\['monthly', 'mo'\], \['weekly', 'wk'\], \['yearly', 'yr'\]\]/);
  });

  it('periodToMonthly handles unknown/invalid cadences as monthly', () => {
    expect(periodToMonthly(100, 'monthly')).toBe(100);
    expect(periodToMonthly(100, 'nonsense')).toBe(100);
    expect(periodToMonthly(Number.NaN, 'weekly')).toBe(0);
    expect(periodToMonthly(0, 'yearly')).toBe(0);
  });
});
