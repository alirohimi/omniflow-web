// ============================================================================
// OmniFlow — Spending breakdown engine (pure, $0, offline).
//
// Aggregates a window of non-Income expenses into the dimensions a personal-
// finance app should surface: spend by category (with share), by payment
// method, top merchants, a trailing daily-spend trend, and (when budgets
// exist) per-category cap-vs-actual. Every function is NaN/Infinity-proof and
// deterministic given its inputs — `now` is injected by the caller, so the
// module carries no Date.now() and is fully unit-testable.
//
// All monetary figures are in the *base* currency: `Expense.baseAmount` is
// snapshotted at capture time, so no live FX is required and history is stable.
// ============================================================================

import type { Budget, Expense, PaymentMethod } from '../domain/types';
import { budgetLine, type BudgetLine } from './budgets';

/** A time window the breakdown is computed over. 'all' = no lower bound. */
export type SpendWindow = { days: number } | { all: true };

/** One aggregated bucket: an amount plus its share of the window total. */
export interface Bucket {
  key: string;
  amount: number; // base currency
  share: number;  // 0..1 fraction of total spend in the window
  count: number;  // number of expenses in the bucket
}

export interface MerchantBucket extends Bucket {
  /** Most recent expense in the bucket (for a "last seen" hint). */
  lastSeen: number;
}

/** A single day of the trailing trend. `date` is a local-midnight epoch-ms. */
export interface TrendDay {
  date: number;
  amount: number; // base currency
}

/** One drill-down group: a category and its most-recent transactions. */
export interface CategoryDrill {
  category: string;
  total: number;   // base currency, in-window
  share: number;   // 0..1 of window total
  items: {
    id: string;
    merchant: string;
    amount: number; // base currency
    timestamp: number;
  }[];
}

/** The single largest outflow in the window (null when there is no spend). */
export interface LargestSpend {
  id: string;
  merchant: string;
  category: string;
  amount: number; // base currency
  timestamp: number;
}

export interface SpendingBreakdown {
  /** Total non-Income spend in the window, base currency. */
  total: number;
  /** Number of expenses in the window. */
  count: number;
  /** Spend per category, largest first. Share is of `total`. */
  byCategory: Bucket[];
  /** Spend per payment method, largest first. */
  byPayment: Bucket[];
  /** Top merchants by total spend (`limit` of them), largest first. */
  topMerchants: MerchantBucket[];
  /** Trailing daily spend (`days` buckets ending at `now`), oldest first.
   *  Produced for a fixed 14-day strip regardless of the window, so the
   *  trend stays legible; the window only scopes the totals/buckets. */
  trend: TrendDay[];
  /** Per-category budget performance when budgets are supplied. */
  budgets?: BudgetLine[];
  /** Total spend in the *preceding* window of the same length (for a fair
   *  period-over-period delta). Null when the window is `all` (no equal
   *  preceding period) or when there is no spend data. */
  prevTotal: number | null;
  /** (total - prevTotal) / prevTotal when `prevTotal > 0`, else null.
   *  Positive = spending up vs the prior period. */
  deltaPct: number | null;
  /** Number of days the window spans (for avg-per-day). 0 when `all`. */
  windowDays: number;
  /** Mean daily spend over the window (total / windowDays), 0 when no days. */
  avgPerDay: number;
  /** The single largest outflow in the window, or null when no spend. */
  largest: LargestSpend | null;
  /** Per-category drill-downs for the top N categories (by spend), each
   *  with up to 5 of its most-recent transactions. Drives the expandable
   *  "what's costing the most" detail list. */
  drills: CategoryDrill[];
}

/** Local-midnight epoch-ms for `date` (the stable day boundary for grouping). */
function startOfDay(date: number): number {
  const d = new Date(date);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function isSpend(e: Expense): boolean {
  // Income is a credit, not spend; and a non-finite base is a corrupt row.
  return e.category !== 'Income' && Number.isFinite(e.baseAmount);
}

/**
 * Compute the full spending breakdown for `expenses` over `window`, at time
 * `now`. Pass `budgets` to also get per-category cap-vs-actual lines. The
 * trend strip is always a trailing 14 days ending at `now`.
 */
export function spendingBreakdown(
  expenses: Expense[],
  window: SpendWindow,
  now: number,
  opts: { budgets?: Budget[]; topMerchants?: number; trendDays?: number } = {},
): SpendingBreakdown {
  const topLimit = opts.topMerchants ?? 8;
  const trendDays = opts.trendDays ?? 14;

  // Window bounds. 'all' only lower-bounds by "no filter"; the trend strip is
  // computed separately at a fixed 14 days so it never collapses to one bar.
  const cutoff =
    'all' in window ? 0 : now - window.days * 86_400_000;

  const inWindow = expenses.filter((e) => isSpend(e) && e.timestamp >= cutoff);

  // ---- totals + category / payment / merchant buckets -------------------
  let total = 0;
  const cat = new Map<string, { amount: number; count: number }>();
  const pay = new Map<string, { amount: number; count: number }>();
  const merch = new Map<string, { amount: number; count: number; lastSeen: number }>();

  for (const e of inWindow) {
    total += e.baseAmount;
    total = Number.isFinite(total) ? total : 0;

    const c = cat.get(e.category) ?? { amount: 0, count: 0 };
    c.amount += e.baseAmount;
    c.count += 1;
    cat.set(e.category, c);

    const p = pay.get(e.paymentMethod) ?? { amount: 0, count: 0 };
    p.amount += e.baseAmount;
    p.count += 1;
    pay.set(e.paymentMethod, p);

    if (e.merchant) {
      const m = merch.get(e.merchant) ?? { amount: 0, count: 0, lastSeen: 0 };
      m.amount += e.baseAmount;
      m.count += 1;
      m.lastSeen = Math.max(m.lastSeen, e.timestamp);
      merch.set(e.merchant, m);
    }
  }

  const shareOf = (amount: number): number =>
    Number.isFinite(total) && total > 0 ? amount / total : 0;

  const byCategory = [...cat.entries()]
    .map(([key, v]) => ({ key, amount: v.amount, share: shareOf(v.amount), count: v.count }))
    .sort((a, b) => b.amount - a.amount);

  const byPayment = [...pay.entries()]
    .map(([key, v]) => ({ key, amount: v.amount, share: shareOf(v.amount), count: v.count }))
    .sort((a, b) => b.amount - a.amount);

  const topMerchants: MerchantBucket[] = [...merch.entries()]
    .map(([key, v]) => ({ key, amount: v.amount, share: shareOf(v.amount), count: v.count, lastSeen: v.lastSeen }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, topLimit);

  // ---- trailing daily trend (fixed `trendDays`, independent of window) ----
  const trendStart = startOfDay(now - (trendDays - 1) * 86_400_000);
  const trendByDay = new Map<number, number>();
  for (const e of inWindow) {
    const day = startOfDay(e.timestamp);
    if (day < trendStart) continue;
    trendByDay.set(day, (trendByDay.get(day) ?? 0) + e.baseAmount);
  }
  const trend: TrendDay[] = [];
  for (let i = 0; i < trendDays; i++) {
    const day = trendStart + i * 86_400_000;
    trend.push({ date: day, amount: trendByDay.get(day) ?? 0 });
  }

  // ---- period-over-period delta: spend in the preceding window of the same
  //      length. A fair "am I spending more/less than before?" read. 'all'
  //      has no equal preceding period, so prevTotal stays null.
  const isAll = 'all' in window;
  const windowDays = isAll ? 0 : window.days;
  let prevTotal: number | null = null;
  if (!isAll) {
    const prevEnd = cutoff;
    const prevStart = prevEnd - window.days * 86_400_000;
    let s = 0;
    for (const e of expenses) {
      if (!isSpend(e)) continue;
      if (e.timestamp < prevStart || e.timestamp >= prevEnd) continue;
      s += e.baseAmount;
      s = Number.isFinite(s) ? s : 0;
    }
    prevTotal = s;
  }
  const deltaPct =
    prevTotal != null && prevTotal > 0 && Number.isFinite(total)
      ? (total - prevTotal) / prevTotal
      : null;
  const avgPerDay = windowDays > 0 ? total / windowDays : 0;

  // ---- largest single outflow in the window -----------------------------
  let largest: LargestSpend | null = null;
  for (const e of inWindow) {
    if (e.baseAmount <= 0) continue;
    if (!largest || e.baseAmount > largest.amount) {
      largest = {
        id: e.id,
        merchant: e.merchant,
        category: e.category,
        amount: e.baseAmount,
        timestamp: e.timestamp,
      };
    }
  }

  // ---- per-category drill-downs (top N categories, up to 5 recent items) --
  const drillLimit = Math.min(6, Math.max(1, byCategory.length));
  const drills: CategoryDrill[] = [];
  for (let i = 0; i < drillLimit; i++) {
    const b = byCategory[i];
    if (!b) break;
    const items = inWindow
      .filter((e) => e.category === b.key)
      .sort((a, c) => c.timestamp - a.timestamp)
      .slice(0, 5)
      .map((e) => ({
        id: e.id,
        merchant: e.merchant,
        amount: e.baseAmount,
        timestamp: e.timestamp,
      }));
    drills.push({
      category: b.key,
      total: b.amount,
      share: b.share,
      items,
    });
  }

  // ---- budgets: cap-vs-actual for the trailing month (the engine's window)
  const budgets: BudgetLine[] | undefined = opts.budgets?.length
    ? budgetLineAll(opts.budgets, expenses, now)
    : undefined;

  return {
    total: Number.isFinite(total) ? total : 0,
    count: inWindow.length,
    byCategory,
    byPayment,
    topMerchants,
    trend,
    budgets,
    prevTotal,
    deltaPct,
    windowDays,
    avgPerDay,
    largest,
    drills,
  };
}

/** Budget lines over the trailing month, matching `budgetReport`'s window. */
function budgetLineAll(budgets: Budget[], expenses: Expense[], now: number): BudgetLine[] {
  const windowStart = now - 30 * 86_400_000;
  return budgets.map((b) => budgetLine(b, expenses, windowStart));
}

/** Human label for a payment-method key (the enum has no display names). */
export function paymentLabel(method: string): string {
  const map: Record<PaymentMethod, string> = {
    card: 'Card',
    qr: 'QR / DuitNow',
    ewallet: 'E-wallet',
    cash: 'Cash',
    bank: 'Bank / transfer',
    other: 'Other',
  };
  return map[method as PaymentMethod] ?? method;
}
