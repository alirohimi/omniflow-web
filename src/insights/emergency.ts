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

/** Curated "essential" category names — the bills you cannot skip.
 *  Matched against `Expense.category` (the Category.name string). */
export const ESSENTIAL_CATEGORIES: string[] = [
  'Housing & Rent',
  'Utilities',
  'Groceries',
  'Food & Dining',
  'Transport',
  'Health & Beauty',
  'Education',
];

export const EMERGENCY_WINDOW_DAYS = 90; // ~3 months of essential spend

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
  /** Essential monthly spend in base currency (90-day window / 3). 0 when
   *  no essential spending is recorded. */
  monthlyEssential: number;
  /** Target reserve in base currency. From `targetOverrideBase` when the
   *  user pinned a number, else monthlyEssential * targetMonths. */
  target: number;
  targetSource: 'override' | 'derived' | 'zero-spend';
  targetMonths: number;
  /** Total reserve value in base currency. */
  reserve: number;
  /** reserve / monthlyEssential — how many months of essentials you cover.
   *  null when monthlyEssential is 0 (unknown without a spend base). */
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

/** 90-day essential spend, monthly-equivalent, base currency. */
export function essentialMonthlySpend(expenses: Expense[], base: string, now: number): number {
  const from = now - EMERGENCY_WINDOW_DAYS * 86_400_000;
  let sum = 0;
  for (const e of expenses) {
    if (e.category === 'Income') continue;
    if (!ESSENTIAL_CATEGORIES.includes(e.category)) continue;
    if (e.timestamp < from) continue;
    if (typeof e.baseAmount === 'number' && Number.isFinite(e.baseAmount)) sum += e.baseAmount;
  }
  // 90 days -> /3 = one average month. Guard divide-by-zero upstream.
  return sum / 3;
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
  const monthlyEssential = essentialMonthlySpend(expenses, base, now);

  const monthlyOverride =
    typeof emergency.targetOverrideBase === 'number' && Number.isFinite(emergency.targetOverrideBase) && emergency.targetOverrideBase > 0
      ? emergency.targetOverrideBase
      : null;

  let target: number;
  let targetSource: EmergencyResult['targetSource'];
  if (monthlyOverride != null) {
    target = monthlyOverride;
    targetSource = 'override';
  } else if (monthlyEssential > 0) {
    target = monthlyEssential * emergency.targetMonths;
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

  const coverageMonths = monthlyEssential > 0 ? reserve / monthlyEssential : null;
  const pctOfTarget = target > 0 ? (reserve / target) * 100 : reserve > 0 ? 100 : 0;
  const status: EmergencyStatus =
    lines.length === 0 ? 'none' : target > 0 && reserve >= target ? (reserve > target ? 'over' : 'ok') : 'building';
  const gap = target > 0 ? Math.max(0, target - reserve) : 0;

  return {
    monthlyEssential,
    target,
    targetSource,
    targetMonths: emergency.targetMonths,
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
