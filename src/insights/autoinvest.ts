// ============================================================================
// OmniFlow — auto-invest settlement + portfolio P&L engine (pure, offline).
//
// Two jobs:
//   1. `dueAutoInvests` / `advanceNextDue` — which standing plans owe a
//      contribution right now, and how to push their nextDue forward by one
//      period after a cycle is settled (catch-up caps at one cycle, so a long
//      offline gap never multi-logs; the plan keeps its cadence).
//   2. `portfolioPnl` — the user-facing "did my money grow?" answer: total
//      live value vs total recorded invested capital (manual initial
//      deposits + the contribution ledger), with per-account detail.
// ============================================================================

import type {
  AutoInvest,
  AutoInvestPeriod,
  Contribution,
  InvestmentAccount,
} from '../domain/types';
import type { AccountLine, PortfolioSummary } from '../ai/portfolio';

const PERIOD_MS: Record<AutoInvestPeriod, number> = {
  weekly: 7 * 86_400_000,
  monthly: 30.4 * 86_400_000,
  quarterly: 91.3 * 86_400_000,
  yearly: 365.25 * 86_400_000,
};

/** Active plans whose next cycle is due now or overdue (oldest first). */
export function dueAutoInvests(plans: AutoInvest[], now: number): AutoInvest[] {
  // A cycle is "due" when its nextDue is in the past, or when it lands today
  // (any hour) — i.e. due at 00:00 of nextDue's calendar day.
  const dayStart = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  return plans
    .filter((p) => p.active !== false)
    .filter((p) => dayStart(p.nextDue) <= dayStart(now))
    .sort((a, b) => a.nextDue - b.nextDue);
}

/** Advance a settled plan's nextDue by one period.
 *  Catch-up cap: if the app was closed for several cycles, only ONE cycle
 *  advances past `now` — never log N contributions for N missed months.
 *  (If nextDue+period is still in the past, we jump to the FIRST cycle that
 *  lands at/after `now`, i.e. we catch up but only settle one contribution
 *  per app-load, and the *next* app load settles the one after that.) */
export function advanceNextDue(plan: AutoInvest, now: number): number {
  const step = PERIOD_MS[plan.period];
  if (!Number.isFinite(step) || step <= 0) return plan.nextDue + step || now + step;
  let next = plan.nextDue + step;
  // Jump by full steps until we're just past `now` — at most one "catch-up"
  // per load, so the plan keeps its cadence without multiplying entries.
  while (next <= now) next += step;
  return next;
}

/** How many full periods between `from` and `to` (for display "x cycles overdue"). */
export function periodsBetween(period: AutoInvestPeriod, from: number, to: number): number {
  const step = PERIOD_MS[period];
  if (to <= from || !Number.isFinite(step)) return 0;
  return Math.min(99, Math.floor((to - from) / step));
}

export interface PnlAccount {
  account: InvestmentAccount;
  valueBase: number;
  capitalBase: number;
  pnlBase: number | null;
  returnPct: number | null;
}

export interface PortfolioPnl {
  totalValueBase: number;
  totalCapitalBase: number;
  totalPnlBase: number | null;
  totalReturnPct: number | null;
  /** Accounts that have any recorded capital (manual or via contributions). */
  accounts: PnlAccount[];
  /** Count of accounts still missing a recorded initial balance. */
  missingCapitalCount: number;
}

/**
 * Aggregate P&L: live value (from the portfolio summary) vs total recorded
 * invested capital. `initialDepositBase` is cumulative — it holds the user's
 * manually-recorded starting balance AND every settled contribution (the
 * store bumps it on each addContribution), so the ledger never double-counts.
 */
export function portfolioPnl(
  summary: PortfolioSummary,
  accounts: InvestmentAccount[],
  contributions: Contribution[],
): PortfolioPnl {
  // Per-account capital from contributions only matters for accounts whose
  // manual initialDepositBase is missing but who received settled cycles.
  const capFromContribs = new Map<string, number>();
  for (const c of contributions ?? []) {
    if (!Number.isFinite(c.amountBase)) continue;
    capFromContribs.set(c.accountId, (capFromContribs.get(c.accountId) ?? 0) + c.amountBase);
  }

  // Capital is read from the vault's `accounts` array (source of truth), not
  // from the summary's account objects — so the P&L is always measured
  // against the current vault state even if the summary was built earlier.
  const accById = new Map<string, InvestmentAccount>();
  for (const a of accounts ?? []) accById.set(a.id, a);

  const lines: PnlAccount[] = (summary?.byAccount ?? []).map((l: AccountLine) => {
    const acc = accById.get(l.account.id) ?? l.account;
    const valueBase = Number.isFinite(l.valueBase) ? l.valueBase : 0;
    let capitalBase =
      Number.isFinite(acc.initialDepositBase) && (acc.initialDepositBase ?? 0) > 0
        ? acc.initialDepositBase!
        : 0;
    // Fall back to the ledger when no manual balance was recorded.
    if (capitalBase === 0) capitalBase = capFromContribs.get(acc.id) ?? 0;
    const hasCapital = capitalBase > 0;
    return {
      account: acc,
      valueBase,
      capitalBase,
      pnlBase: hasCapital ? valueBase - capitalBase : null,
      returnPct: hasCapital ? ((valueBase - capitalBase) / capitalBase) * 100 : null,
    };
  });

  const withCapital = lines.filter((l) => l.pnlBase != null);
  const totalValueBase = withCapital.length > 0
    ? withCapital.reduce((s, l) => s + l.valueBase, 0)
    : 0;
  const totalCapitalBase = withCapital.reduce((s, l) => s + l.capitalBase, 0);
  const totalPnlBase = totalCapitalBase > 0 ? totalValueBase - totalCapitalBase : null;
  const totalReturnPct = totalCapitalBase > 0 ? (totalPnlBase! / totalCapitalBase) * 100 : null;
  const missingCapitalCount = lines.filter((l) => l.pnlBase == null && l.valueBase > 0).length;

  return {
    totalValueBase,
    totalCapitalBase,
    totalPnlBase,
    totalReturnPct,
    accounts: lines,
    missingCapitalCount,
  };
}

/** Total per-period amount of active plans (for the "investing $X/mo" display). */
export function autoInvestMonthlyTotal(plans: AutoInvest[]): number {
  let total = 0;
  for (const p of plans ?? []) {
    if (p.active === false) continue;
    if (!Number.isFinite(p.baseAmount)) continue;
    const factor =
      p.period === 'weekly' ? 4.345 : p.period === 'monthly' ? 1
        : p.period === 'quarterly' ? 1 / 3 : p.period === 'yearly' ? 1 / 12 : 1;
    total += p.baseAmount * factor;
  }
  return Number.isFinite(total) ? total : 0;
}
