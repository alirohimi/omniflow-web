// ============================================================================
// OmniFlow — Cash-flow forecast engine (pure, $0, offline).
//
// Projects N months forward from *today*: monthly income and monthly expense
// rates are derived from the trailing 90 days of the expense history, then
// stepped month-by-month with a running balance. Recurring charges are
// optional and override the trailing-month expense rate when provided.
// ============================================================================

import type { Expense, Recurring } from '../domain/types';

export interface ForecastPoint {
  /** epoch ms at the start of the forecast month (i=0 = next month). */
  at: number;
  label: string; // YYYY-MM
  /** Running balance at the END of this month. */
  balance: number;
  income: number;
  expenses: number;
}

export interface ForecastResult {
  points: ForecastPoint[];
  /** Months until the running balance first turns negative (null if it never
   *  does within the horizon, or the starting balance is already negative). */
  firstNegativeMonth: number | null;
  /** Trailing-90-day derived monthly income / expense rates (base currency). */
  monthlyIncome: number;
  monthlyExpenses: number;
  netPerMonth: number;
}

function ratesPerMonth(expenses: Expense[], _baseCurrency: string, days: number, now: number) {
  const cutoff = now - days * 86_400_000;
  let sum = 0;
  let income = 0;
  for (const e of expenses) {
    if (e.timestamp < cutoff) continue;
    const a = Number.isFinite(e.baseAmount) ? e.baseAmount : 0;
    if (e.category === 'Income') income += a;
    else sum += a;
  }
  return { income, spend: sum };
}

/**
 * Build a forward cash-flow projection.
 * @param startBalance base-currency balance to start from (e.g. net worth or
 *   a chosen "starting cash").
 * @param months horizon in months (>=1).
 * @param recurring optional structured recurring charges — when present, the
 *   trailing expense rate is replaced by the recurring monthly equivalent so
 *   the forecast reflects *known* bills rather than last-month spending.
 */
export function forecastCashFlow(
  startBalance: number,
  months: number,
  expenses: Expense[],
  recurring: Recurring[] | undefined,
  baseCurrency: string,
  now: number,
): ForecastResult {
  const n = Math.max(1, Math.floor(months));
  const trailing = ratesPerMonth(expenses, baseCurrency, 90, now);
  const monthlyIncome = trailing.income / 3; // 90d -> ~3 months
  // Use recurring monthly-equivalent when any active recurring exists; it is
  // a more faithful "known bills" rate than trailing spending.
  let monthlyExpenses: number;
  if (recurring && recurring.some((r) => r.active !== false)) {
    let t = 0;
    for (const r of recurring) {
      if (r.active === false) continue;
      const factor = r.period === 'daily' ? 30.4 : r.period === 'weekly' ? 4.345 : r.period === 'yearly' ? 1 / 12 : 1;
      t += (Number.isFinite(r.baseAmount) ? r.baseAmount : 0) * factor;
    }
    monthlyExpenses = t;
  } else {
    monthlyExpenses = trailing.spend / 3;
  }
  const netPerMonth = monthlyIncome - monthlyExpenses;

  const points: ForecastPoint[] = [];
  let balance = startBalance;
  let firstNegativeMonth: number | null = null;
  const monthMs = 30 * 86_400_000;
  // `firstNegativeMonth` is only meaningful when the user STARTS solvent
  // (startBalance >= 0) and then *crosses* into the red. If they start
  // already negative, "months until broke" is undefined (they are already
  // broke) so it stays null per the docstring contract.
  const wasSolventAtStart = startBalance >= 0;
  for (let i = 1; i <= n; i++) {
    const at = now + (i - 0.5) * monthMs;
    balance += netPerMonth;
    if (wasSolventAtStart && firstNegativeMonth === null && balance < 0) {
      firstNegativeMonth = i;
    }
    points.push({
      at,
      label: new Date(at).toISOString().slice(0, 7),
      balance: Number.isFinite(balance) ? balance : 0,
      income: monthlyIncome,
      expenses: monthlyExpenses,
    });
  }
  return { points, firstNegativeMonth, monthlyIncome, monthlyExpenses, netPerMonth };
}
