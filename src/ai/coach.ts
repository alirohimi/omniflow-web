// ============================================================================
// OmniFlow — Coach (conversational financial advisor agent).
//
// A user-facing chat agent grounded in the user's own encrypted data. It
// speaks like a seasoned value investor (a "Buffett-grade" voice: margin of
// safety, long time horizon, concentration, avoiding the market), and it is
// ALWAYS grounded in the caller's real numbers — net worth, allocation,
// spend pace, FX exposure — never invented prices.
//
// 3-tier, zero-cost, mirrors the app's AI philosophy:
//   Tier 1  BYOK LLM (OpenAI/Anthropic/Gemini) with the coach persona +
//           compact derived context. Only aggregates leave the device —
//           never the full ledger.
//   Tier 2  Deterministic rule engine ($0, offline): intent-matched answers
//           built from the same portfolio/spend math the dashboard uses.
//
// `coachAsk` is injectable for tests (a fake LLM transport proves the
// persona + context pipeline end to end without a real key).
// ============================================================================

import type {
  Expense,
  InvestmentAccount,
  InvestmentHolding,
  QuoteSnapshot,
  UserPreferences,
  CoachMessage,
} from '../domain/types';
import type { PortfolioSummary } from './portfolio';
import { spendOverLastDays } from './advisor';
import type { LLMConfig } from './categorize';
import { callLLM as callLLMDefault } from './categorize';
import { currencyInfo } from '../domain/enums';
import {
  ACTION_CONTRACT,
  parseAction,
  stripActionMarker,
  type CreatePortfolioAction,
} from './actions';

/** What the view hands to the engine. Built from the live store + market
 *  data hook, so the coach reasons about real, current numbers. */
export interface CoachContext {
  expenses: Expense[];
  accounts: InvestmentAccount[];
  holdings: InvestmentHolding[];
  quotes: Record<string, QuoteSnapshot>;
  prefs: UserPreferences;
  portfolio: PortfolioSummary | null;
}

/** Derived, LLM-safe brief. This — and ONLY this — is what a BYOK call may
 *  receive. No merchant-level ledger, no exact account balances beyond the
 *  aggregate snapshot; keeps the secret footprint small if the key belongs
 *  to a third-party service. */
export interface CoachBrief {
  baseCurrency: string;
  netWorthBase: number;
  portfolioReturnPct: number | null;
  allocationPct: { assetClass: string; pct: number }[];
  topHolding: { symbol: string; pct: number } | null;
  cryptoSharePct: number;
  fxExposurePct: number; // share of portfolio in non-base currencies
  spend30Base: number;
  dailyPace: number;
  projectedMonthBase: number;
  topCategory: { name: string; pct: number } | null;
  openAccounts: string[];
}

const round = (n: number, d = 0): number => {
  const p = 10 ** d;
  return Math.round(n * p) / p;
};

/** Build the compact, LLM-safe brief from the full context. */
export function buildBrief(ctx: CoachContext): CoachBrief {
  const { prefs, portfolio, holdings, quotes, expenses, accounts } = ctx;
  const sym = currencyInfo(prefs.baseCurrency);
  void sym;

  let totalVal = 0;
  const perHolding: { symbol: string; val: number; assetClass: string; cur: string }[] = [];
  for (const h of holdings) {
    const q = quotes[h.symbol];
    const priceBase = q?.price ?? h.currentPriceBase;
    const val = priceBase * h.units;
    totalVal += val;
    perHolding.push({ symbol: h.symbol, val, assetClass: h.assetClass, cur: q?.currency ?? h.holdingCurrency });
  }

  const alloc = new Map<string, number>();
  for (const p of perHolding) alloc.set(p.assetClass, (alloc.get(p.assetClass) ?? 0) + p.val);
  const allocationPct = [...alloc.entries()]
    .map(([assetClass, v]) => ({ assetClass, pct: totalVal > 0 ? round((v / totalVal) * 100, 1) : 0 }))
    .sort((a, b) => b.pct - a.pct);

  const topH = [...perHolding].sort((a, b) => b.val - a.val)[0];
  const crypto = perHolding.filter((p) => p.assetClass === 'crypto').reduce((s, p) => s + p.val, 0);
  const nonBase = perHolding
    .filter((p) => p.cur !== prefs.baseCurrency)
    .reduce((s, p) => s + p.val, 0);

  const spend30 = spendOverLastDays(expenses, 30, prefs.baseCurrency);
  const dailyPace = spend30 / 30;

  const byCat = new Map<string, number>();
  for (const e of expenses) {
    if (e.category === 'Income') continue;
    byCat.set(e.category, (byCat.get(e.category) ?? 0) + e.baseAmount);
  }
  const catTotal = [...byCat.values()].reduce((a, b) => a + b, 0);
  const topCat = [...byCat.entries()].sort((a, b) => b[1] - a[1])[0];

  return {
    baseCurrency: prefs.baseCurrency,
    netWorthBase: round(portfolio?.totalValueBase ?? totalVal, 2),
    portfolioReturnPct: portfolio?.totalReturnPct != null ? round(portfolio.totalReturnPct, 1) : null,
    allocationPct,
    topHolding: topH && totalVal > 0
      ? { symbol: topH.symbol, pct: round((topH.val / totalVal) * 100, 1) }
      : null,
    cryptoSharePct: totalVal > 0 ? round((crypto / totalVal) * 100, 1) : 0,
    fxExposurePct: totalVal > 0 ? round((nonBase / totalVal) * 100, 1) : 0,
    spend30Base: round(spend30, 2),
    dailyPace: round(dailyPace, 2),
    projectedMonthBase: round(dailyPace * 31, 2),
    topCategory: topCat && catTotal > 0
      ? { name: topCat[0], pct: round((topCat[1] / catTotal) * 100, 1) }
      : null,
    openAccounts: accounts.map((a) => a.platformName),
  };
}

/** The coach persona. Injected as the system prompt of every LLM turn so
 *  the voice is stable: a value investor, not a hype man. Grounded, blunt,
 *  margin-of-safety framing, short and actionable — never a disclaimer wall. */
export function coachSystemPrompt(brief: CoachBrief): string {
  return [
    'You are OmniFlow Coach, a personal-finance advisor in the tradition of long-term value investing.',
    'Voice: calm, direct, a little wry. You think in decades, not quarters. You prefer margin of safety, sensible diversification, and paying yourself first.',
    'Rules:',
    '- Ground every answer ONLY in the user data below. Never invent prices, returns, or holdings that are not in it.',
    '- Short. 1-4 tight paragraphs or a short list. Concrete numbers from the data, not platitudes.',
    `- Money always in ${brief.baseCurrency}, the user's base currency.`,
    '- When they ask what to buy, give process (criteria, position sizing, when to act), not a single-stock call.',
    '- Flag concentrated positions, heavy crypto, and FX exposure when the data shows them.',
    '- No legal/tax advice; one line of "general education, not advice" only when a recommendation-adjacent answer is given.',
    '',
    'User data (derived snapshot — not the raw ledger):',
    JSON.stringify(brief),
    '',
    ACTION_CONTRACT,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Tier 2 — deterministic fallback. $0, offline, same math as the dashboard.
// Intent matching is deliberately simple: keyword buckets, longest-context
// answer wins; the brief keeps every sentence grounded.
// ---------------------------------------------------------------------------

interface Intent {
  id: string;
  match: RegExp;
  answer: (b: CoachBrief) => string | null;
}

const money = (v: number, code: string): string =>
  `${currencyInfo(code).symbol}${round(v, 2).toLocaleString()}`;

const INTENTS: Intent[] = [
  {
    id: 'net-worth',
    match: /net ?worth|worth ?of|how much (do i )?(have|own)|total (assets?|portfolio|value)/i,
    answer: (b) => {
      if (b.netWorthBase <= 0)
        return `You don't have any holdings tracked yet, so your net worth is ${money(0, b.baseCurrency)}. Add a portfolio (Luno, IBKR, StashAway, or manual) under Portfolio and I'll start weighing it in.`;
      const ret =
        b.portfolioReturnPct != null
          ? ` Since your average cost basis, that's ${b.portfolioReturnPct >= 0 ? '+' : ''}${b.portfolioReturnPct}% — the return you'd keep if markets froze today. The number that matters is your cost basis, not today's tick.`
          : '';
      return `Your tracked portfolio is worth ${money(b.netWorthBase, b.baseCurrency)} across ${b.openAccounts.length || 'your'} account(s).${ret} I'd judge you by the pace, not the size: consistent contributions beat lump-sum luck.`;
    },
  },
  {
    id: 'allocation',
    match: /allocat|diversif|asset (class|mix)|spread|risk/i,
    answer: (b) => {
      if (b.allocationPct.length === 0)
        return 'No holdings yet, so there is no allocation to talk about. Start small: a diversified index position plus a cash sleeve you actually control beats a big bet on one ticker.';
      const list = b.allocationPct.map((a) => `${a.assetClass} ${a.pct}%`).join(', ');
      let note = '';
      if (b.cryptoSharePct > 40)
        note = ` Crypto at ${b.cryptoSharePct}% is above the 10-30% range most long-term portfolios use; volatility of that size will decide your sleep quality, not your returns.`;
      else if (b.cryptoSharePct > 0) note = ``;
      if (b.topHolding && b.topHolding.pct > 50)
        note += ` Your single largest position is ${b.topHolding.symbol} at ${b.topHolding.pct}% — when one holding can take the whole portfolio down with it, the portfolio is the holding.`;
      return `Your mix: ${list}.${note} The discipline is the point: decide the mix once, rebalance rarely, and let drift be your enemy.`;
    },
  },
  {
    id: 'spend',
    match: /spend|spending|expense|budget|pace|burn|saving|savings/i,
    answer: (b) => {
      if (b.spend30Base <= 0)
        return 'No spend tracked in the last 30 days. Log a few weeks of real transactions and I can put a number on your pace — the point of the exercise is to know your run-rate, not to feel bad about it.';
      const headroom = b.projectedMonthBase > 0 ? ' that is, projected ' + money(b.projectedMonthBase, b.baseCurrency) + ' for a 31-day month' : '';
      let cat = '';
      if (b.topCategory) cat = ` Your heaviest category is ${b.topCategory.name} at ${b.topCategory.pct}% of tracked spend.`;
      return `You're running ${money(b.spend30Base, b.baseCurrency)} over 30 days — about ${money(b.dailyPace, b.baseCurrency)}/day,${headroom}.${cat} Savings are what you pay yourself first, before rent gets a vote. Even 5% of income on autopilot compounds into the boring, reliable kind of wealth.`;
    },
  },
  {
    id: 'fx',
    match: /currenc|forex|fx|exchange|hedg|risk of (the )?(myr|usd|sgd|jpy)/i,
    answer: (b) => {
      if (b.fxExposurePct <= 5)
        return `Only ${b.fxExposurePct}% of your portfolio sits in foreign currencies, so rate moves are a rounding error. Keep it that way until you have a reason not to.`;
      return `${b.fxExposurePct}% of your portfolio is denominated in currencies other than ${b.baseCurrency}. That is a position, whether you intended it or not — when the ringgit (or your base) moves 10%, so does a slice of your "returns." A deliberate hedge or a deliberate decision beats an accidental one.`;
    },
  },
  {
    id: 'buy',
    match: /what should i (buy|invest)|best (investment|stock|etf)|where to (put|invest)|rebalanc/i,
    answer: (b) => {
      const openers: string[] = [];
      openers.push('I give process, not ticker calls — that is the only advice that cannot go wrong in advance.');
      openers.push('1. Have a 3-6 month expense buffer in cash before the growth slice. 2. Buy boring, own it long: broad index exposure sized to your risk tolerance. 3. If the portfolio is lopsided, rebalance by redirecting new money into the light positions instead of selling winners at noise. 4. Never average down on a thesis you cannot restate in one paragraph.');
      if (b.allocationPct.length === 0) openers.push('Right now you have nothing to rebalance, so start step 2 with a starter position you would still be happy holding in five bad years.');
      return openers.join(' ');
    },
  },
  {
    id: 'market',
    match: /market|crash|bull|bear|inflation|rate|fed|recession/i,
    answer: (b) => {
      const anchor =
        b.netWorthBase > 0
          ? ` Your tracked portfolio is ${money(b.netWorthBase, b.baseCurrency)}; the question is not what the market does this week but what your position lets you do when it does.`
          : '';
      return `Markets are weighing machines on the week and truth machines on the decade. No forecast, mine included, has a usable track record. What survives a crash: a position size you can hold, a cost basis you chose, and a plan written before the fear arrives.${anchor}`;
    },
  },
];

/** The deterministic coach. Returns null only for truly empty briefs on
 *  intents that need data — the caller still gets a generic fallback. */
export function coachFallback(
  question: string,
  brief: CoachBrief,
  hasImage = false,
): { text: string; source: 'rules' | 'system' } {
  const imgNote = hasImage
    ? " You attached an image, but without an LLM key I can't read images on-device — tell me what it shows (amount, merchant, currency) and I'll work the numbers."
    : '';
  for (const it of INTENTS) {
    if (it.match.test(question)) {
      const ans = it.answer(brief);
      if (ans) return { text: ans + imgNote, source: 'rules' };
    }
  }
  // Generic, still grounded.
  const bits: string[] = [];
  if (brief.netWorthBase > 0)
    bits.push(`Your portfolio is ${money(brief.netWorthBase, brief.baseCurrency)}${brief.portfolioReturnPct != null ? ` (${brief.portfolioReturnPct >= 0 ? '+' : ''}${brief.portfolioReturnPct}% vs cost)` : ''}.`);
  bits.push(`You're spending ~${money(brief.dailyPace, brief.baseCurrency)}/day.`);
  bits.push('I can go deep on allocation, spending pace, currency exposure, or a buy-with-discipline plan — ask which one to look at first, and I will anchor it to those numbers.');
  return { text: bits.join(' ') + imgNote, source: 'system' };
}

// ---------------------------------------------------------------------------
// Orchestration. Tier 1 when a BYOK key exists; Tier 2 always as fallback.
// ---------------------------------------------------------------------------

export interface CoachAnswer {
  text: string;
  source: 'llm' | 'rules' | 'system';
  /** A validated create_portfolio proposal the user must confirm (Apply).
   *  Present only on the LLM tier, only when the LLM emitted a well-formed
   *  [ACTION:] marker; the rule tier can never produce one. */
  proposedAction?: CreatePortfolioAction;
}

/** Ask the coach. `llm` may be null (no key) -> pure rule engine. A
 *  transport failure is never fatal: we degrade to rules so the chat always
 *  answers, and surface the degrade flag so the UI can note it. `images`
 *  carries the user's attached data-URLs (receipt, chart, screenshot); only
 *  the LLM tier consumes them — the rule tier is told it cannot read them. */
export async function coachAsk(
  question: string,
  ctx: CoachContext,
  llm: LLMConfig | null,
  history: CoachMessage[] = [],
  images: string[] = [],
  transport: (cfg: LLMConfig, sys: string, user: string, images?: string[]) => Promise<string> = callLLMDefault,
): Promise<CoachAnswer & { degraded: boolean; llmError?: string }> {
  const brief = buildBrief(ctx);
  let llmError: string | undefined;

  if (llm) {
    try {
      const sys = coachSystemPrompt(brief);
      const tail = history
        .slice(-6)
        .map((m) => `${m.role === 'user' ? 'User' : 'Coach'}: ${m.text}`)
        .join('\n');
      const user = tail ? `${tail}\nUser: ${question}` : question;
      const raw = await transport(llm, sys, user, images);
      const clean = stripActionMarker(raw.trim());
      if (clean.length > 0) {
        const parsed = parseAction(raw);
        // The visible text is marker-free; the action (if any) is surfaced
        // separately for the confirm card. An unparseable marker is still
        // returned as text (with the marker stripped) so the user is not
        // silently told something is pending when nothing is.
        return {
          text: clean,
          source: 'llm',
          degraded: false,
          proposedAction: parsed.ok ? parsed.action : undefined,
        };
      }
    } catch (e) {
      // Fall through to rules — a failed BYOK call must not kill the chat —
      // but keep the provider's reason so the UI can explain the fallback.
      llmError = e instanceof Error ? e.message : String(e);
    }
  }

  const fb = coachFallback(question, brief, images.length > 0);
  return { ...fb, degraded: Boolean(llm), llmError };
}

export const __test = { buildBrief, coachSystemPrompt, coachFallback, INTENTS };
