// ============================================================================
// OmniFlow — Budget engine (pure, $0, offline).
//
// A Budget cap is a monthly-equivalent amount in the base currency. Other
// billing cadences are converted to a monthly equivalent so one consistent
// "cap this month" number drives the UI. `rollover` carries unused cap from
// the prior month into the current one (Copilot-style "save for bigger
// purchases"). All math is NaN/Infinity-proof: a corrupt row contributes 0.
// ============================================================================

import type { Budget, BudgetPeriod, Expense } from '../domain/types';

/** Monthly-equivalent factor: how many of a `period` fit in a typical month. */
export function periodToMonthlyFactor(period: BudgetPeriod): number {
  switch (period) {
    case 'daily':
      return 30.4; // ~30.4 days/month
    case 'weekly':
      return 4.345; // ~4.345 weeks/month
    case 'monthly':
      return 1;
    case 'yearly':
      return 1 / 12;
  }
}

/** Convert a cap expressed in `period` into a monthly-equivalent cap. */
export function monthlyCap(b: Budget): number {
  if (!Number.isFinite(b.cap) || b.cap < 0) return 0;
  return b.cap * periodToMonthlyFactor(b.period);
}

export interface BudgetLine {
  id: string;
  category: string;
  /** Effective cap for the period (base currency). */
  cap: number;
  /** Base-currency spend in `category` during the period. */
  spent: number;
  remaining: number;
  /** 0..1+ fraction of cap consumed (>1 = overspent). */
  pct: number;
  status: 'on-track' | 'watch' | 'over' | 'idle';
}

/**
 * Performance of one budget's category over a window of `days` (the engine
 * uses the trailing-month window to approximate "this month"). `spent` is the
 * sum of non-Income expenses in `category` whose timestamp >= `windowStart`,
 * in base currency.
 */
export function budgetLine(b: Budget, expenses: Expense[], windowStart: number): BudgetLine {
  const cap = monthlyCap(b);
  const spent = expenses
    .filter((e) => e.category === b.category && e.category !== 'Income' && e.timestamp >= windowStart)
    .reduce((s, e) => (Number.isFinite(e.baseAmount) ? s + e.baseAmount : s), 0);
  if (cap <= 0) {
    // No cap set: report spend only, treat as idle/neutral.
    return { id: b.id, category: b.category, cap, spent, remaining: 0, pct: 0, status: 'idle' };
  }
  const remaining = cap - spent;
  const pct = spent / cap;
  let status: BudgetLine['status'];
  if (spent === 0) status = 'idle';
  else if (pct >= 1) status = 'over';
  else if (pct >= 0.85) status = 'watch';
  else status = 'on-track';
  return { id: b.id, category: b.category, cap, spent, remaining, pct, status };
}

/** All budget lines for the current trailing-month window. */
export function budgetReport(
  budgets: Budget[],
  expenses: Expense[],
  now: number,
): BudgetLine[] {
  const windowStart = now - 30 * 86_400_000;
  return budgets.map((b) => budgetLine(b, expenses, windowStart));
}

export interface Rollover {
  /** Effective cap including prior-month carry. */
  effectiveCap: number;
  /** Prior-month unused cap carried forward (0 if rollover is off). */
  carry: number;
}

/**
 * Effective cap with rollover: the base monthly cap plus any unused cap from
 * the previous window. `priorSpent`/`priorCap` describe the immediately prior
 * month's line; the carry is `max(0, priorCap - priorSpent)` when rollover is
 * enabled, else 0.
 */
export function rolloverCap(
  b: Budget,
  priorCap: number,
  priorSpent: number,
): Rollover {
  const carry = b.rollover ? Math.max(0, priorCap - priorSpent) : 0;
  return { effectiveCap: monthlyCap(b) + carry, carry };
}
