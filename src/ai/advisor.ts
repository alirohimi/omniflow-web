// ============================================================================
// OmniFlow — Advisor (offline rule engine + optional LLM enrichment).
//
// The rule engine is deterministic and $0: it inspects the last 30 days of
// expenses + the portfolio and emits prioritised, plain-language suggestions
// (overspend flags, budget pacing, diversification, FX concentration).
//
// If a BYOK LLM is configured, `adviseWithLLM` augments the rule output with
// a narrative; the rules are always shown regardless of LLM availability.
// ============================================================================

import type {
  Expense,
  InvestmentAccount,
  InvestmentHolding,
  QuoteSnapshot,
  UserPreferences,
} from '../domain/types';
import { currencyInfo } from '../domain/enums';
import { LLMConfig, callLLM } from './categorize';

export interface Advisory {
  id: string;
  priority: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  source: 'rules' | 'llm';
}

export interface AdvisorInput {
  expenses: Expense[];
  accounts: InvestmentAccount[];
  holdings: InvestmentHolding[];
  quotes: Record<string, QuoteSnapshot>;
  prefs: UserPreferences;
}

/** Approximate value of all holdings in base currency. */
export function portfolioBaseValue(input: AdvisorInput): number {
  let total = 0;
  for (const h of input.holdings) {
    const q = input.quotes[h.symbol];
    const priceBase = q ? q.price : h.currentPriceBase;
    total += priceBase * h.units;
  }
  return total;
}

/** Spend over the trailing `days` days, in base currency. */
export function spendOverLastDays(expenses: Expense[], days: number, baseCurrency: string): number {
  const cutoff = Date.now() - days * 86_400_000;
  return expenses
    .filter((e) => e.timestamp >= cutoff && e.category !== 'Income')
    .reduce((sum, e) => (e.baseCurrency === baseCurrency ? sum + e.baseAmount : sum + e.baseAmount), 0);
}

/** Pure rule evaluation — always runs, $0. */
export function runRules(input: AdvisorInput): Advisory[] {
  const { prefs, expenses, holdings, accounts } = input;
  const out: Advisory[] = [];
  const base = currencyInfo(prefs.baseCurrency).symbol;
  const push = (p: Advisory['priority'], title: string, detail: string) =>
    out.push({ id: `rule-${out.length}`, priority: p, title, detail, source: 'rules' });

  const spend30 = spendOverLastDays(expenses, 30, prefs.baseCurrency);
  const dailyPace = spend30 / 30;
  const monthToGo = new Date().getDate(); // 1..31
  const projectedMonth = dailyPace * 31;

  // 1. Budget pacing
  if (spend30 > 0) {
    push(
      projectedMonth > spend30 * 1.4 ? 'high' : 'medium',
      'Spending pace',
      `You averaged ${base}${dailyPace.toFixed(0)}/day over the last 30 days; at this pace the month projects to ${base}${projectedMonth.toFixed(0)}.`,
    );
  }

  // 2. Overspend vs. median category
  const byCat = new Map<string, number>();
  for (const e of expenses) {
    if (e.category === 'Income') continue;
    byCat.set(e.category, (byCat.get(e.category) ?? 0) + e.baseAmount);
  }
  if (byCat.size > 0) {
    const sorted = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
    const [topCat, topVal] = sorted[0];
    const total = [...byCat.values()].reduce((a, b) => a + b, 0);
    const share = total > 0 ? topVal / total : 0;
    if (share > 0.35 && sorted.length > 1) {
      push(
        'medium',
        `Concentrated on ${topCat}`,
        `${topCat} is ${(share * 100).toFixed(0)}% of recent spend (${base}${topVal.toFixed(0)} of ${base}${total.toFixed(0)}). Consider trimming to rebalance.`,
      );
    }
  }

  // 3. Recurring / duplicate merchant watch
  const merch = new Map<string, number>();
  for (const e of expenses) merch.set(e.merchant, (merch.get(e.merchant) ?? 0) + 1);
  const repeat = [...merch.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1])[0];
  if (repeat) {
    push('low', 'Recurring merchant', `"${repeat[0]}" appears ${repeat[1]}x recently. Confirm it's intended (subscriptions, top-ups) to avoid accidental recurring charges.`);
  }

  // 4. Portfolio concentration / diversification
  if (holdings.length > 0) {
    const portVal = portfolioBaseValue(input);
    if (portVal > 0) {
      const perHolding = holdings.map((h) => ({
        h,
        val: (input.quotes[h.symbol]?.price ?? h.currentPriceBase) * h.units,
      }));
      perHolding.sort((a, b) => b.val - a.val);
      const top = perHolding[0];
      const topShare = top.val / portVal;
      const crypto = perHolding.filter((p) => p.h.assetClass === 'crypto').reduce((s, p) => s + p.val, 0);
      const cryptoShare = crypto / portVal;

      if (topShare > 0.5) {
        push('high', `Concentrated position: ${top.h.symbol}`, `${top.h.symbol} is ${(topShare * 100).toFixed(0)}% of your portfolio (${base}${top.val.toFixed(0)} of ${base}${portVal.toFixed(0)}). Diversifying reduces single-asset risk.`);
      }
      if (cryptoShare > 0.4) {
        push('medium', 'Crypto weight', `Crypto is ${(cryptoShare * 100).toFixed(0)}% of the portfolio. It's high-volatility; a common cap is 10–30% depending on risk tolerance.`);
      }
    }
  }

  // 5. FX concentration across holdings
  const fxByCur = new Map<string, number>();
  for (const h of holdings) {
    fxByCur.set(h.holdingCurrency, (fxByCur.get(h.holdingCurrency) ?? 0) + (input.quotes[h.symbol]?.price ?? h.currentPriceBase) * h.units);
  }
  const nonBase = [...fxByCur.entries()].filter(([c]) => c !== prefs.baseCurrency);
  if (nonBase.length > 0) {
    const fxExposure = nonBase.reduce((s, [, v]) => s + v, 0);
    const portVal = portfolioBaseValue(input);
    if (portVal > 0 && fxExposure / portVal > 0.6) {
      push('low', 'Currency concentration', `Most of your holdings are denominated in ${nonBase.map((c) => c[0]).join('/')} rather than ${prefs.baseCurrency}. Rate moves affect local value; consider hedging or rebalancing.`);
    }
  }

  // 6. Empty portfolio nudge
  if (holdings.length === 0) {
    push('low', 'No investments tracked', 'Add holdings (Luno, IBKR, StashAway, or manual) to unlock diversification and FX-concentration insights.');
  }

  return out.sort((a, b) => prio(a) - prio(b));
}

function prio(a: Advisory): number {
  return a.priority === 'high' ? 0 : a.priority === 'medium' ? 1 : 2;
}

// ---------------------------------------------------------------------------
// Optional LLM enrichment
// ---------------------------------------------------------------------------

export async function adviseWithLLM(
  input: AdvisorInput,
  rules: Advisory[],
  cfg: LLMConfig,
): Promise<Advisory[]> {
  const sys =
    'You are a concise personal-finance advisor. Given JSON of recent spend, portfolio, and rule-based flags, produce 1-3 personalised, actionable sentences. Be specific and short. No disclaimers.';
  const user = JSON.stringify({
    baseCurrency: input.prefs.baseCurrency,
    spend30: Math.round(spendOverLastDays(input.expenses, 30, input.prefs.baseCurrency)),
    rules: rules.map((r) => ({ p: r.priority, t: r.title })),
    topHolding: input.holdings[0]?.symbol,
  });

  // Reuse the LLM transport from categorize (openai/anthropic/gemini).
  try {
    const raw = await callLLM(cfg, sys, user);
    return [
      ...rules,
      {
        id: 'llm-narrative',
        priority: 'medium',
        title: 'Advisor notes',
        detail: raw.trim().slice(0, 500),
        source: 'llm',
      },
    ];
  } catch {
    return rules; // LLM optional; rules still shown.
  }
}
