// ============================================================================
// OmniFlow — emergency-fund engine (insights/emergency.ts).
//
// Pure, offline, deterministic. Computes the coverage position for a reserve
// that is SEPARATE from the investment portfolio: how much you have set
// aside, how many months of essential spending that covers, progress to
// the target, and the liquidity split (instantly-usable cash vs money
// parked in a brokerage account). The view layer renders it; the coach
// gets the same facts to advise on top-ups.
//
// Coverage is measured against ESSENTIAL spending (Bankrate / YNAB rule):
// bills you cannot skip — housing, utilities, groceries, food, transport,
// health, education — NOT your total spend. That is the number that
// actually matters for "can I weather 3 months without income?"
// ============================================================================

import type {
  EmergencyFund,
  Expense,
  InvestmentAccount,
} from '../domain/types';
import type { RatesForBase } from '../services/fx';
import type { PortfolioSummary, AccountLine } from '../ai/portfolio';
import { fxService } from '../services/fx';

export const EMERGENCY_WINDOW_DAYS = 90; // ~3 months of total spend
/** Default months-of-spend target. 6 per the user's rule ("emergency funds
 *  = average monthly expenses × 6"); the EmergencyPanel still lets the user
 *  pick 1-12, and a pinned override wins over both. */
export const EMERGENCY_DEFAULT_MONTHS = 6;

export interface EmergencyLine {
  id: string;
  kind: 'account' | 'manual';
  name: string;
  currency: string;
  valueLocal: number; // in the line's own currency
  valueBase: number; // converted to base
  liquid: boolean;   // instantly usable (cash / money-market) vs invested
  live: boolean;     // account lines mirror a live tracked account
}

export type EmergencyStatus = 'none' | 'building' | 'ok' | 'over';

export interface EmergencyResult {
  /** AVERAGE MONTHLY SPEND (all non-Income outflows, 90-day window / 3) in
   *  base currency. 0 when no spending is recorded. Per the user's rule the
   *  emergency target reflects total monthly expenses, not just essentials. */
  monthlySpend: number;
  /** Target reserve in base currency. From `targetOverrideBase` when the
   *  user pinned a number, else monthlySpend * targetMonths (default 6). */
  target: number;
  targetSource: 'override' | 'derived' | 'zero-spend';
  targetMonths: number;
  /** Total reserve value in base currency. */
  reserve: number;
  /** reserve / monthlySpend — how many months of average spending you cover.
   *  null when monthlySpend is 0 (unknown without a spend base). */
  coverageMonths: number | null;
  /** reserve / target * 100 (0..100+, clamped for display elsewhere). */
  pctOfTarget: number;
  status: EmergencyStatus;
  lines: EmergencyLine[];
  /** Sum of the instantly-usable pieces (cash / money-market / manual), base. */
  liquidValue: number;
  /** Sum of pieces parked inside a brokerage account, base. */
  investedValue: number;
  /** target - reserve when underfunded, else 0. */
  gap: number;
}

export interface EmergencyInput {
  emergency: EmergencyFund;
  expenses: Expense[];
  accounts: InvestmentAccount[];
  /** Live portfolio (for designated-account lines). null when not loaded. */
  portfolio: PortfolioSummary | null;
  /** FX table (for manual lines + offline fallback). null when unavailable. */
  fx: RatesForBase | null;
  base: string;
  now: number;
}

function toBase(amount: number, from: string, fx: RatesForBase | null, base: string): number {
  if (from === base) return amount;
  if (!fx) return 0; // no table, foreign currency: don't invent a rate
  return fxService.toBase(amount, from, fx);
}

/** Average MONTHLY spend in base currency (all non-Income outflows), pinned
 *  to the explicit `now` for determinism.
 *
 *  Why not `spendOverLastDays(90) / 3`? Because of the *partial current
 *  month*. A 90-day window cut at "now" straddles up to 4 calendar
 *  months: two complete ones plus a partial leading month and a partial
 *  current month. Dividing the raw 90-day sum by 3 double-counts the
 *  middle months and under-counts the edges, so the average is off by
 *  25–50% depending on where in the calendar month "now" lands.
 *
 *  The correct rule: average only *complete* calendar months, and include
 *  the current (partial) month only after prorating it to a full-month
 *  equivalent — `partialTotal / daysElapsed * daysInMonth`. Proration is
 *  exactly how the rest of the app's monthly-equivalent math works (the
 *  recurring engine's yearly÷12, the forecast's 30-day window), so this
 *  keeps one convention across the product.
 *
 *  Calendar months are derived from `now` (local time, consistent with
 *  the rest of the app's date handling). Up to 3 complete months + the
 *  current partial month are considered; fewer if the vault has less
 *  history. A vault with <30 days of history has no complete month yet,
 *  so the average is proration-only; with <1 day it's 0 ("no spending
 *  recorded yet" — same as a brand-new vault). */
export function essentialMonthlySpend(expenses: Expense[], base: string, now: number): number {
  const DAY = 86_400_000;
  const t = new Date(now);
  // Start of the CURRENT calendar month.
  const curMonthStart = new Date(t.getFullYear(), t.getMonth(), 1).getTime();
  const curMonthEnd = new Date(t.getFullYear(), t.getMonth() + 1, 1).getTime();
  const daysInCurMonth = (curMonthEnd - curMonthStart) / DAY;
  // round() not ceil(): the host's sub-day TZ offset (e.g. UTC+8) would
  // otherwise shift the integer day count. An intraday offset (< 1 day)
  // cannot change round((elapsed)/day).
  const daysElapsed = Math.max(1, Math.round((now - curMonthStart) / DAY)); // >=1

  // Candidate windows, oldest first: complete months within the 90-day
  // lookback, then the current partial month. A complete month M counts
  // only if its end is <= 90 days before `now` start-of-window... simpler:
  // include the two calendar months before the current one when they fit
  // inside 90 days of history (the classic "3 months of spend" target),
  // plus always prorate the current partial month.
  const windows: Array<{ start: number; end: number; complete: boolean; days: number; daysSoFar: number }> = [
    { start: curMonthStart, end: curMonthEnd, complete: false, days: daysInCurMonth, daysSoFar: daysElapsed },
  ];
  // Two preceding complete months, if the vault has that much history.
  for (let m = 1; m <= 2; m++) {
    const s = new Date(t.getFullYear(), t.getMonth() - m, 1);
    const e = new Date(t.getFullYear(), t.getMonth() - m + 1, 1);
    const start = s.getTime(), end = e.getTime();
    // Only include a month that started within the 90-day window and
    // ended in the past (complete).
    if (end <= curMonthStart && start >= now - EMERGENCY_WINDOW_DAYS * DAY) {
      windows.unshift({ start, end, complete: true, days: (end - start) / DAY, daysSoFar: (end - start) / DAY });
    }
  }

  let totalMonthly = 0;
  let count = 0;
  for (const w of windows) {
    let sum = 0;
    for (const e of expenses) {
      if (e.category === 'Income') continue;
      if (e.timestamp < w.start || e.timestamp >= w.end) continue;
      const amt =
        e.baseCurrency === base
          ? e.baseAmount
          : e.originalAmount * (Number.isFinite(e.fxRate) ? e.fxRate : 1);
      if (typeof amt === 'number' && Number.isFinite(amt)) sum += amt;
    }
    // Every candidate month counts toward the average — INCLUDING a month
    // with zero spending. That is the point of an average: a no-spend
    // month is a legitimate 0 that pulls the rate down. Skipping it would
    // bias the target upward whenever the user has a lean month.
    const monthlyEq = w.complete ? sum : (sum / w.daysSoFar) * w.days; // prorate partial
    totalMonthly += monthlyEq;
    count += 1;
  }
  return count === 0 ? 0 : totalMonthly / count;
}

/** Is a designated account "liquid" (instantly usable) by the asset classes
 *  it actually holds? A cash-only / money-market / empty account is liquid;
 *  any equity/ETF/crypto holding makes it invested. */
function accountIsLiquid(line: AccountLine | undefined): boolean {
  if (!line || line.lines.length === 0) return true; // empty wrapper = a cash slot
  return line.lines.every((h) => h.holding.assetClass === 'cash' || h.holding.assetClass === 'mmf');
}

export function computeEmergency(input: EmergencyInput): EmergencyResult {
  const { emergency, expenses, accounts, portfolio, fx, base, now } = input;
  const monthlySpend = essentialMonthlySpend(expenses, base, now);

  const monthlyOverride =
    typeof emergency.targetOverrideBase === 'number' && Number.isFinite(emergency.targetOverrideBase) && emergency.targetOverrideBase > 0
      ? emergency.targetOverrideBase
      : null;

  // Default target months is 6 per the user's rule ("emergency funds =
  // average monthly expenses × 6"). Old encrypted blobs carry targetMonths
  // (3) — normalize the MISSING/default case to 6, but respect an explicit
  // user-set value from the panel (which is clamped 1-12 on save).
  const targetMonths =
    typeof emergency.targetMonths === 'number' && Number.isFinite(emergency.targetMonths) && emergency.targetMonths > 0
      ? emergency.targetMonths
      : EMERGENCY_DEFAULT_MONTHS;

  let target: number;
  let targetSource: EmergencyResult['targetSource'];
  if (monthlyOverride != null) {
    target = monthlyOverride;
    targetSource = 'override';
  } else if (monthlySpend > 0) {
    target = monthlySpend * targetMonths;
    targetSource = 'derived';
  } else {
    target = 0;
    targetSource = 'zero-spend';
  }

  // Resolve each line's base value.
  const accLine = new Map<string, AccountLine>();
  if (portfolio) for (const a of portfolio.byAccount) accLine.set(a.account.id, a);

  const lines: EmergencyLine[] = [];
  let reserve = 0;
  let liquidValue = 0;
  let investedValue = 0;

  for (const item of emergency.items) {
    if (item.kind === 'account') {
      const al = item.accountId ? accLine.get(item.accountId) : undefined;
      const valueBase = al ? al.valueBase : 0;
      const liquid = accountIsLiquid(al);
      lines.push({
        id: item.id,
        kind: 'account',
        name: al?.account.platformName || item.name || 'Account',
        currency: base,
        valueLocal: valueBase,
        valueBase,
        liquid,
        live: !!al,
      });
      reserve += valueBase;
      if (liquid) liquidValue += valueBase;
      else investedValue += valueBase;
    } else {
      const amt = typeof item.amount === 'number' ? item.amount : 0;
      const valueBase = toBase(amt, item.currency || base, fx, base);
      // Manual reserves are treated as immediately usable cash on hand.
      lines.push({
        id: item.id,
        kind: 'manual',
        name: item.name || 'Manual reserve',
        currency: item.currency || base,
        valueLocal: amt,
        valueBase: Number.isFinite(valueBase) ? valueBase : 0,
        liquid: true,
        live: false,
      });
      reserve += Number.isFinite(valueBase) ? valueBase : 0;
      liquidValue += Number.isFinite(valueBase) ? valueBase : 0;
    }
  }

  const coverageMonths = monthlySpend > 0 ? reserve / monthlySpend : null;
  const pctOfTarget = target > 0 ? (reserve / target) * 100 : reserve > 0 ? 100 : 0;
  const status: EmergencyStatus =
    lines.length === 0 ? 'none' : target > 0 && reserve >= target ? (reserve > target ? 'over' : 'ok') : 'building';
  const gap = target > 0 ? Math.max(0, target - reserve) : 0;

  return {
    monthlySpend,
    target,
    targetSource,
    targetMonths,
    reserve,
    coverageMonths,
    pctOfTarget,
    status,
    lines,
    liquidValue,
    investedValue,
    gap,
  };
}
