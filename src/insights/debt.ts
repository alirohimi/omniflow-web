// ============================================================================
// OmniFlow — Debt payoff engine (pure, $0, offline).
//
// Two classic strategies:
//   - Avalanche: pay down the highest-APR debt first (least total interest).
//   - Snowball:   pay down the smallest-balance debt first (psychological wins).
//
// `extraPayment` is an optional accelerated monthly amount applied on top of
// each debt's minimum. The simulation is month-granular, interest computed on
// opening balance at (APR/12). All math is guarded: non-positive balances,
// APRs, or NaN inputs produce a sane empty/zero schedule rather than NaN.
// ============================================================================

import type { Liability } from '../domain/types';

export type PayoffStrategy = 'avalanche' | 'snowball';

export interface PayoffStep {
  /** 1-based month index. */
  month: number;
  /** Total debt paid off during this month, by name. */
  paid: Record<string, number>;
  /** Opening total balance for this month (before the payment). */
  totalOpening: number;
  /** Total interest accrued this month. */
  interest: number;
}

export interface PayoffPlan {
  strategy: PayoffStrategy;
  /** Months until every balance hits 0 (0 if no liabilities). */
  months: number;
  /** Total interest paid across the whole plan. */
  totalInterest: number;
  /** Which debt is retired in which month (calendar of wins). */
  retired: { name: string; month: number }[];
  /** Per-month schedule (capped at 600 steps for very long/zero-interest). */
  steps: PayoffStep[];
}

const MAX_STEPS = 600;

/**
 * Simulate a payoff plan. Each month:
 *   1. Accrue interest on every open balance: interest += bal * apr/12/100.
 *   2. Apply minimums; any surplus goes to the highest-priority open debt
 *      (avalanche = highest APR; snowball = lowest balance).
 *   3. Overflow pays the next-priority debt, and so on.
 */
export function simulatePayoff(
  liabilities: Liability[],
  strategy: PayoffStrategy,
  extraPayment = 0,
): PayoffPlan {
  // Normalise: keep only finite, positive-balance debts.
  const active = liabilities
    .filter((l) => Number.isFinite(l.balance) && l.balance > 0 && Number.isFinite(l.apr))
    .map((l) => ({
      name: l.name,
      balance: l.balance,
      apr: Math.max(0, l.apr),
      minPayment: Math.max(0, Number.isFinite(l.minPayment) ? l.minPayment : 0),
      extra: l.extraPayment !== undefined && Number.isFinite(l.extraPayment) ? Math.max(0, l.extraPayment) : 0,
    }));

  if (active.length === 0) {
    return { strategy, months: 0, totalInterest: 0, retired: [], steps: [] };
  }

  // Priority order: avalanche = descending APR (ties -> higher balance first);
  // snowball = ascending balance (ties -> higher APR first).
  const order = [...active];
  if (strategy === 'avalanche') {
    order.sort((a, b) => b.apr - a.apr || b.balance - a.balance);
  } else {
    order.sort((a, b) => a.balance - b.balance || b.apr - a.apr);
  }

  const balances = new Map(order.map((d) => [d.name, d.balance]));
  const minBy = new Map(order.map((d) => [d.name, d.minPayment]));
  const aprBy = new Map(order.map((d) => [d.name, d.apr]));
  // Per-debt extra only applies if that debt is still open; aggregate extra
  // is applied to the priority chain.
  let months = 0;
  let totalInterest = 0;
  const retired: PayoffPlan['retired'] = [];
  const steps: PayoffStep[] = [];
  const openKeys = () => [...balances.entries()].filter(([, b]) => b > 0.005).map(([k]) => k);

  // Safety: if total monthly payment < total interest, the plan never
  // converges -> cap at MAX_STEPS and stop.
  for (let m = 1; m <= MAX_STEPS; m++) {
    months = m;
    const open = openKeys();
    if (open.length === 0) {
      months = m - 1;
      break;
    }

    // Opening total (before this month's interest) — recorded on the step.
    const openingTotal = open.reduce((s, k) => s + (balances.get(k)! || 0), 0);

    // 1. Accrue interest on opening balances.
    let interestThisMonth = 0;
    for (const k of open) {
      const bal = balances.get(k)!;
      const i = bal * (aprBy.get(k)! / 100) / 12;
      interestThisMonth += i;
      balances.set(k, bal + i);
    }
    totalInterest += interestThisMonth;

    // 2. Build the payment pool: minimums for every open debt + aggregate extra.
    const paid: Record<string, number> = {};
    let pool = 0;
    for (const k of open) {
      const min = Math.min(minBy.get(k) ?? 0, balances.get(k)!);
      paid[k] = min;
      pool += min;
    }
    // Extra goes to the priority chain (first open in `order` first).
    const extra = Number.isFinite(extraPayment) ? Math.max(0, extraPayment) : 0;
    pool += extra;
    let leftover = extra;
    for (const k of order.map((d) => d.name)) {
      if (leftover <= 0) break;
      if (!balances.has(k) || balances.get(k)! <= 0.005) continue;
      const apply = Math.min(leftover, balances.get(k)!);
      paid[k] = (paid[k] ?? 0) + apply;
      leftover -= apply;
    }
    // (Min-payments are already applied above; `pool` tracked them.)

    // 3. Apply payments, reducing balances.
    for (const k of open) {
      const p = paid[k] ?? 0;
      const bal = balances.get(k)!;
      const newBal = Math.max(0, bal - p);
      balances.set(k, newBal);
      if (newBal <= 0.005 && !retired.some((r) => r.name === k)) {
        retired.push({ name: k, month: m });
      }
    }

    steps.push({
      month: m,
      paid,
      totalOpening: openingTotal,
      interest: interestThisMonth,
    });
  }

  // If the loop hit MAX_STEPS and debt remains, flag it via months.
  return { strategy, months, totalInterest, retired, steps };
}

/** Compare both strategies; return the cheaper one by total interest. */
export function bestStrategy(liabilities: Liability[], extra = 0): PayoffPlan {
  const a = simulatePayoff(liabilities, 'avalanche', extra);
  const s = simulatePayoff(liabilities, 'snowball', extra);
  return a.totalInterest <= s.totalInterest ? a : s;
}
