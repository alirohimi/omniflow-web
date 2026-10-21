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
  /** Trailing-30-day derived monthly income / expense rates (base currency).
   *  income = logged income over the last 30 days; spend = recurring-equiv
   *  when any active recurring exists, else the 30-day spend total. Both are
   *  the trailing observed rates, NOT a salary figure. */
  monthlyIncome: number;
  monthlyExpenses: number;
  netPerMonth: number;
  /** How many income rows fed `monthlyIncome` over the trailing window.
   *  A near-zero income with incomeCount = 0 means "not logged", not
   *  "you earn nothing" — the UI labels it accordingly. */
  incomeRowCount: number;
  /** True when no income rows were logged in the window — the monthly income
   *  rate is a floor (0), not a real salary signal. */
  incomeLogged: boolean;
}

/**
 * Trailing-window income + spend totals. Income rows are tracked in the
 * SAME `Expense` array as spend (category === 'Income'), but they are
 * CREDITS, not outflows — every spend figure in the app excludes them,
 * so income never inflates a spend/pace/budget number. The forecast just
 * needs the two totals separately.
 *
 * `days` is the trailing window (e.g. 30 to match the "pace" figure the
 * user actually trusts). Callers decide how to annualise — do NOT bake a
 * "÷3 = monthly" assumption in here, that's what made the old 90-day÷3
 * rate read as a fake monthly figure.
 */
function ratesPerMonth(expenses: Expense[], _baseCurrency: string, days: number, now: number) {
  const cutoff = now - days * 86_400_000;
  let sum = 0;
  let income = 0;
  let incomeCount = 0;
  for (const e of expenses) {
    if (e.timestamp < cutoff) continue;
    const a = Number.isFinite(e.baseAmount) ? e.baseAmount : 0;
    if (e.category === 'Income') { income += a; incomeCount += 1; }
    else sum += a;
  }
  return { income, spend: sum, incomeCount };
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
  // Match the "pace" figure the user trusts: a 30-day trailing window, not a
  // noisy 90-day÷3 rate. Income and spend are the observed trailing-30-day
  // totals; when recurring bills exist, the expense rate uses their
  // monthly-equivalent instead (a more faithful "known bills" rate).
  const trailing = ratesPerMonth(expenses, baseCurrency, 30, now);
  const monthlyIncome = trailing.income; // logged income, last 30 days
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
    monthlyExpenses = trailing.spend; // observed spend, last 30 days
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
  return {
    points,
    firstNegativeMonth,
    monthlyIncome,
    monthlyExpenses,
    netPerMonth,
    incomeRowCount: trailing.incomeCount,
    incomeLogged: trailing.incomeCount > 0,
  };
}
