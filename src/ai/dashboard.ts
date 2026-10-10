// ============================================================================
// OmniFlow — Dashboard AI Summary (Home-tab narrative).
//
// A one-shot, non-chat narrative that appears on the Home tab.
// Uses the same 3-tier AI philosophy as the rest of the app:
//   Tier 1  BYOK LLM (OpenAI/Anthropic/Gemini) — compact brief, 2-3 sentences.
//   Tier 2  Deterministic rules + template ($0, offline) — always works.
//
// The LLM receives only the CoachBrief (aggregates, no raw ledger) — the same
// privacy contract as the Coach tab.
// ============================================================================

import { currencyInfo } from '../domain/enums';
import { callLLM } from './categorize';
import type { LLMConfig } from './categorize';
import { runRules } from './advisor';
import type { AdvisorInput, Advisory } from './advisor';
import { buildBrief } from './coach';
import type { CoachBrief, CoachContext } from './coach';
import type { PortfolioSummary } from './portfolio';

export interface DashboardSummary {
  text: string;
  source: 'llm' | 'rules' | 'system';
  /** True when an LLM key was attempted but the call failed (degraded). */
  degraded: boolean;
  llmError?: string;
}

export async function summarizeDashboard(
  input: AdvisorInput,
  portfolio: PortfolioSummary | null,
  llm: LLMConfig | null,
  transport: (cfg: LLMConfig, sys: string, user: string) => Promise<string> = callLLM,
): Promise<DashboardSummary> {
  const ctx: CoachContext = {
    expenses: input.expenses,
    accounts: input.accounts,
    holdings: input.holdings,
    quotes: input.quotes,
    prefs: input.prefs,
    portfolio,
  };
  const brief = buildBrief(ctx);
  const rules = runRules(input);

  // -- Tier 1: BYOK LLM -----------------------------------------------------
  if (llm) {
    try {
      const sys =
        'You are a concise personal-finance dashboard narrator. Given the JSON brief, ' +
        'write exactly 2-3 short sentences: (1) net worth + return, (2) spending pace, ' +
        '(3) the single most important action item. Plain language, no disclaimers, ' +
        'no markdown, no emoji. Use the user base currency symbol. Max 120 words.';
      const user = JSON.stringify({
        base: brief.baseCurrency,
        netWorth: brief.netWorthBase,
        retPct: brief.portfolioReturnPct,
        spend30: brief.spend30Base,
        dailyPace: brief.dailyPace,
        projectedMonth: brief.projectedMonthBase,
        topHolding: brief.topHolding,
        allocation: brief.allocationPct.slice(0, 4),
        topCategory: brief.topCategory,
        fxExposure: brief.fxExposurePct,
        topRule: rules[0]
          ? { p: rules[0].priority, t: rules[0].title, d: rules[0].detail }
          : null,
      });
      const raw = await transport(llm, sys, user);
      return { text: raw.trim().slice(0, 600), source: 'llm', degraded: false };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const rs = rulesSummary(brief, rules);
      return { ...rs, degraded: true, llmError: msg };
    }
  }

  // -- Tier 2/3: deterministic rules ---------------------------------------
  return rulesSummary(brief, rules);
}

/** Build a 2-3 sentence offline narrative from the brief + top rule ($0). */
export function rulesSummary(
  brief: CoachBrief,
  rules: Advisory[],
): DashboardSummary {
  const sym = currencyInfo(brief.baseCurrency).symbol;
  const lines: string[] = [];

  if (brief.netWorthBase > 0) {
    const ret = brief.portfolioReturnPct;
    const retStr = ret != null ? ` (${ret >= 0 ? '+' : ''}${ret}% vs cost)` : '';
    lines.push(`Net worth ${sym}${Math.round(brief.netWorthBase).toLocaleString()}${retStr}`);
  } else {
    lines.push('No investments tracked yet.');
  }

  if (brief.spend30Base > 0) {
    lines.push(
      `~${sym}${Math.round(brief.dailyPace)}/day pace → ${sym}${Math.round(brief.projectedMonthBase)} this month.`,
    );
  }

  if (rules.length > 0) {
    const top = rules[0];
    lines.push(`${top.title}: ${top.detail}`);
  } else if (lines.length < 3) {
    lines.push('No pacing or concentration alerts — all clear.');
  }

  return { text: lines.join(' '), source: 'rules', degraded: false };
}

export const __test = { summarizeDashboard, rulesSummary };
