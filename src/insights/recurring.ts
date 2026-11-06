// ============================================================================
// OmniFlow — Recurring charge / bill engine (pure, $0, offline).
//
// Two jobs:
//   1. `upcomingBills` — which structured recurring charges fall due within
//      the next `windowDays`, ordered by due date (drives the "upcoming bills"
//      list + PWA notifications).
//   2. `detectRecurring` — mine the *expense* history for repeat merchants
//      that look recurring (3+ charges, similar amounts, evenly spaced) so the
//      advisor can suggest "turn this into a tracked bill".
// ============================================================================

import type { Expense, Recurring } from '../domain/types';

export interface UpcomingBill {
  id: string;
  name: string;
  baseAmount: number;
  nextDue: number;
  /** days from now (negative = overdue). */
  daysUntilDue: number;
}

/** Recurring charges due within `windowDays` (or already overdue), active only. */
export function upcomingBills(recurring: Recurring[], now: number, windowDays: number): UpcomingBill[] {
  return recurring
    .filter((r) => r.active !== false)
    .map((r) => ({
      id: r.id,
      name: r.name || r.merchant,
      baseAmount: r.baseAmount,
      nextDue: r.nextDue,
      daysUntilDue: Math.round((r.nextDue - now) / 86_400_000),
    }))
    .filter((b) => b.daysUntilDue <= Math.max(0, windowDays))
    .sort((a, b) => a.daysUntilDue - b.daysUntilDue);
}

/** Total of active recurring charges in `period`, as a monthly-equivalent. */
export function recurringMonthlyTotal(recurring: Recurring[]): number {
  let total = 0;
  for (const r of recurring) {
    if (r.active === false) continue;
    const factor = r.period === 'daily' ? 30.4 : r.period === 'weekly' ? 4.345 : r.period === 'yearly' ? 1 / 12 : 1;
    if (Number.isFinite(r.baseAmount)) total += r.baseAmount * factor;
  }
  return Number.isFinite(total) ? total : 0;
}

export interface RecurringCandidate {
  merchant: string;
  count: number;
  typicalAmount: number;
  typicalCurrency: string;
  /** Approximate billing cadence label derived from the median gap. */
  period: 'weekly' | 'monthly' | 'yearly';
}

/**
 * Group non-Income expenses by normalised merchant; a merchant is a
 * recurring candidate when it has >= `minCount` charges. Returns the typical
 * amount (median) and a coarse period from the median gap between charges.
 */
export function detectRecurring(expenses: Expense[], minCount = 3): RecurringCandidate[] {
  const byMerchant = new Map<string, Expense[]>();
  for (const e of expenses) {
    if (e.category === 'Income' || !e.merchant) continue;
    const key = e.merchant.trim().toLowerCase();
    if (!key) continue;
    const arr = byMerchant.get(key) ?? [];
    arr.push(e);
    byMerchant.set(key, arr);
  }
  const out: RecurringCandidate[] = [];
  for (const [merchant, list] of byMerchant) {
    if (list.length < minCount) continue;
    const sorted = [...list].sort((a, b) => a.timestamp - b.timestamp);
    const amounts = sorted.map((e) => e.originalAmount).filter(Number.isFinite);
    const typicalAmount = median(amounts);
    const typicalCurrency = mode(sorted.map((e) => e.originalCurrency));
    // Median gap between consecutive charges -> coarse period.
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const g = (sorted[i].timestamp - sorted[i - 1].timestamp) / 86_400_000;
      if (Number.isFinite(g) && g > 0) gaps.push(g);
    }
    const gapDays = gaps.length ? median(gaps) : 0;
    let period: RecurringCandidate['period'] = 'monthly';
    if (gapDays > 0) {
      if (gapDays < 21) period = 'weekly';
      else if (gapDays > 300) period = 'yearly';
      else period = 'monthly';
    }
    out.push({ merchant, count: list.length, typicalAmount, typicalCurrency, period });
  }
  return out.sort((a, b) => b.count - a.count);
}

// --- tiny numeric helpers -------------------------------------------------
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mode(xs: string[]): string {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best = xs[0] ?? '';
  let bestN = 0;
  for (const [k, n] of counts) if (n > bestN) ((best = k), (bestN = n));
  return best;
}
