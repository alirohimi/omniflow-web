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
  Category,
  InvestmentAccount,
  InvestmentHolding,
  QuoteSnapshot,
  UserPreferences,
  CoachMessage,
  EmergencyFund,
} from '../domain/types';
import type { RatesForBase } from '../services/fx';
import type { PortfolioSummary } from './portfolio';
import { spendOverLastDays } from './advisor';
import type { LLMConfig } from './categorize';
import { callLLM as callLLMDefault } from './categorize';
import { currencyInfo } from '../domain/enums';
import { computeEmergency } from '../insights/emergency';
import {
  ACTION_CONTRACT,
  parseAction,
  stripActionMarker,
  type Action,
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
  /** The user's category list — the only names `add_expense` / `edit_expense`
   *  may use in a proposed action. Threaded into `buildBrief` (so the LLM is
   *  told the exact valid set) and into `parseAction` (so proposals are
   *  validated against the real list, not an empty one). */
  categories: Category[];
  /** Emergency-reserve module (separate from the portfolio). The coach gets
   *  its coverage facts so it can advise on topping up the cushion. */
  emergency?: EmergencyFund;
  /** FX table — converts manual emergency lines to base. null = offline. */
  fx?: RatesForBase | null;
  /** Clock for the essential-spend window. Defaults to Date.now(). */
  now?: number;
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
  /**
   * Ids the LLM may reference in edit/delete/patch actions. Grounded in the
   * real ledger (most recent first) so a proposed [ACTION:] target always
   * exists — the rule tier never emits actions, only the LLM tier does, and
   * it is told to use these exact ids and never invent one.
   */
  recentExpenses: { id: string; merchant: string; category: string; amountBase: number; when: string }[];
  openHoldings: { id: string; symbol: string; units: number; assetClass: string; currency: string }[];
  /** Exact category names available to the user — the only valid values for
   *  `category` in add_expense / edit_expense actions. */
  categories: string[];
  // Emergency-reserve facts (separate line from the portfolio). Absent when
  // the view didn't compute it (offline FX + no spend). The coach treats the
  // whole block as optional and never invents numbers when it's missing.
  emergency?: {
    reserve: number;         // base currency, all lines combined
    target: number;          // base currency
    coverageMonths: number | null;
    monthlySpend: number;    // average monthly spend (all outflows) the target is derived from
    targetMonths: number;    // months of spend the target expresses (default 6)
    targetSource: 'override' | 'derived' | 'zero-spend';
    status: 'none' | 'building' | 'ok' | 'over';
    liquidValue: number;
    investedValue: number;
    lineCount: number;
  };
}

const round = (n: number, d = 0): number => {
  const p = 10 ** d;
  return Math.round(n * p) / p;
};

/** Format a base-currency amount the way the UI does — symbol + locale string,
 *  rounded to the given decimals. A single source of truth so the context
 *  pack and the rule-engine answers agree on number formatting. */
const fmtMoney = (v: number, code: string, d = 2): string =>
  `${currencyInfo(code).symbol}${round(v, d).toLocaleString()}`;

/** The bounded history window the LLM tier sends. Kept small so cheap
 *  models stay inside their sweet spot; each turn is ~50-100 tokens, so 4
 *  turns (2 user + 2 coach) is ~300-400 tokens. Exported for tests. */
export const HISTORY_TURNS = 4;

/** Build a clearly-sectioned, fixed-order "context pack" string that a weak
 *  model can parse without JSON tooling. Same brief + same history -> the
 *  same string (deterministic: no timestamps, no random elements).
 *
 *  Deliberately NOT JSON: structured markdown with one fact per line is far
 *  more reliably followed by small models than a nested blob, and it costs
 *  fewer tokens. `##` section headers give a weak model clear anchors; every
 *  field is labeled in plain language so it never has to infer the meaning
 *  of a key like `spend30Base`.
 *
 *  Only derived aggregates reach the pack (never the raw ledger) — the
 *  privacy invariant. `brief.emergency` absent -> "Not set up", never
 *  invented numbers. */
export function buildContextPack(brief: CoachBrief, history?: CoachMessage[]): string {
  const cur = brief.baseCurrency;
  const lines: string[] = [];

  // ## PORTFOLIO
  lines.push('## PORTFOLIO');
  lines.push(`Net worth: **${fmtMoney(brief.netWorthBase, cur)}**`);
  if (brief.portfolioReturnPct != null)
    lines.push(`Return vs cost: ${brief.portfolioReturnPct >= 0 ? '+' : ''}${round(brief.portfolioReturnPct, 1)}%`);
  lines.push(
    brief.allocationPct.length > 0
      ? `Allocation: ${brief.allocationPct.map((a) => `${a.assetClass} ${a.pct}%`).join(' | ')}`
      : 'Allocation: no holdings tracked yet',
  );
  if (brief.topHolding)
    lines.push(`Top holding: ${brief.topHolding.symbol} (${brief.topHolding.pct}% of portfolio)`);
  lines.push(`Crypto share: ${brief.cryptoSharePct}%`);
  lines.push(`FX exposure: ${brief.fxExposurePct}% in non-base currencies`);
  lines.push('');

  // ## SPENDING
  lines.push('## SPENDING');
  lines.push(`Last 30 days: **${fmtMoney(brief.spend30Base, cur)}**`);
  lines.push(`Daily pace: ${fmtMoney(brief.dailyPace, cur)}`);
  lines.push(`Projected month (31d): ${fmtMoney(brief.projectedMonthBase, cur)}`);
  lines.push(
    brief.topCategory
      ? `Top category: ${brief.topCategory.name} (${brief.topCategory.pct}% of tracked spend)`
      : 'Top category: no spend tracked yet',
  );
  lines.push('');

  // ## SAFETY CUSHION
  lines.push('## SAFETY CUSHION');
  const e = brief.emergency;
  if (!e || e.lineCount === 0) {
    lines.push('Not set up');
  } else {
    lines.push(`Reserve: ${fmtMoney(e.reserve, cur)} / target ${fmtMoney(e.target, cur)}`);
    if (e.coverageMonths != null)
      lines.push(`Coverage: ${round(e.coverageMonths, 1)} months of average spend`);
    const statusNote: Record<string, string> = {
      building: `building — ${fmtMoney(Math.max(0, e.target - e.reserve), cur)} gap`,
      ok: 'at or past target',
      over: 'past target',
      none: 'not set up',
    };
    lines.push(`Status: ${statusNote[e.status] ?? e.status}`);
    if (e.investedValue > 0)
      lines.push(`Liquid: ${fmtMoney(e.liquidValue, cur)} · Invested: ${fmtMoney(e.investedValue, cur)}`);
  }
  lines.push('');

  // ## RECENT
  lines.push('## RECENT');
  if (brief.recentExpenses.length > 0) {
    lines.push('Transactions (id — merchant — category — amount — date):');
    for (const t of brief.recentExpenses)
      lines.push(
        `- ${t.id} — ${t.merchant || 'unknown'} — ${t.category} — ${fmtMoney(t.amountBase, cur)}${t.when ? ` — ${t.when}` : ''}`,
      );
  } else {
    lines.push('Transactions: none in the last 10 logged');
  }
  if (brief.openHoldings.length > 0) {
    lines.push('Holdings (id — symbol — units — class — currency):');
    for (const h of brief.openHoldings)
      lines.push(`- ${h.id} — ${h.symbol} — ${h.units} — ${h.assetClass} — ${h.currency}`);
  }
  lines.push('');

  // ## CATEGORIES
  lines.push('## CATEGORIES');
  lines.push(
    brief.categories.length > 0
      ? `Valid category names: ${brief.categories.join(', ')}`
      : 'Valid category names: (none defined yet)',
  );

  // ## HISTORY — only the bounded recent turns, labeled so a weak model
  // separates prior context from the current question.
  if (history && history.length > 0) {
    const tail = history.slice(-HISTORY_TURNS);
    lines.push('');
    lines.push('## HISTORY (recent turns — context, not the current question)');
    for (const m of tail)
      lines.push(`${m.role === 'user' ? 'User' : 'Coach'}: ${m.text}`);
  }

  return lines.join('\n');
}

/** Build the compact, LLM-safe brief from the full context. */
export function buildBrief(ctx: CoachContext): CoachBrief {
  const { prefs, portfolio, holdings, quotes, expenses, accounts, categories, emergency, fx, now } = ctx;
  const sym = currencyInfo(prefs.baseCurrency);
  void sym;

  let totalVal = 0;
  const perHolding: { symbol: string; val: number; assetClass: string; cur: string }[] = [];
  for (const h of holdings) {
    const q = quotes[h.symbol];
    const priceBase = q?.price ?? h.currentPriceBase;
    const val = priceBase * h.units;
    totalVal += val;
    // Par rows (cash/MMF) are always in the holding's own currency — a
    // clobbered quote from batch() can carry the wrong currency (the same
    // bug that inflated MYR cash rows in valueInBase).
    const isPar = h.assetClass === 'cash' || h.assetClass === 'mmf';
    const cur = isPar ? h.holdingCurrency : (q?.currency ?? h.holdingCurrency);
    perHolding.push({ symbol: h.symbol, val, assetClass: h.assetClass, cur });
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

  // Emergency-reserve facts (separate line from the portfolio). Only when
  // the view computed them — otherwise the block is omitted and the coach
  // must not invent a cushion number.
  let emergencyBrief: CoachBrief['emergency'];
  if (emergency) {
    const res = computeEmergency({
      emergency,
      expenses,
      accounts,
      portfolio,
      fx: fx ?? null,
      base: prefs.baseCurrency,
      now: now ?? Date.now(),
    });
    emergencyBrief = {
      reserve: round(res.reserve, 2),
      target: round(res.target, 2),
      coverageMonths: res.coverageMonths == null ? null : round(res.coverageMonths, 1),
      monthlySpend: round(res.monthlySpend, 2),
      targetMonths: res.targetMonths,
      targetSource: res.targetSource,
      status: res.status,
      liquidValue: round(res.liquidValue, 2),
      investedValue: round(res.investedValue, 2),
      lineCount: res.lines.length,
    };
  }

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
    // Id lists for grounded edit/delete/patch actions (most recent first).
    recentExpenses: [...expenses]
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
      .slice(0, 10)
      .map((e) => ({
        id: e.id,
        merchant: e.merchant ?? '',
        category: e.category,
        amountBase: round(e.baseAmount, 2),
        when: e.timestamp ? new Date(e.timestamp).toISOString().slice(0, 10) : '',
      })),
    openHoldings: holdings.map((h) => ({
      id: h.id,
      symbol: h.symbol,
      units: h.units,
      assetClass: h.assetClass,
      currency: h.holdingCurrency,
    })),
    // The exact valid category names — the LLM picks from this set for any
    // add_expense / edit_expense it proposes, and parseAction validates
    // against the same list (threaded in by coachAsk).
    categories: categories.map((c) => c.name),
    emergency: emergencyBrief,
  };
}

/** The coach persona. Injected as the system prompt of every LLM turn so
 *  the voice is stable: a value investor, not a hype man. Grounded, blunt,
 *  margin-of-safety framing, short and actionable — never a disclaimer wall. */
export function coachSystemPrompt(brief: CoachBrief): string {
  const pack = buildContextPack(brief);
  return [
    'You are OmniFlow Coach, a personal-finance advisor in the tradition of long-term value investing.',
    'Identity (hard rule): you ARE OmniFlow Coach. If the user asks who you are, which model you are, what LLM/AI you run on, or who made you, never name any underlying model, vendor, or provider (no "adaCODE", "adacode-3.0-flash", "OpenAI", "GPT", "Claude", "Gemini", etc.). Say you are the OmniFlow Coach, the advisor built into this app; decline to identify the model behind you.',
    'Voice: calm, direct, a little wry. You think in decades, not quarters. You prefer margin of safety, sensible diversification, and paying yourself first.',
    '',
    'OUTPUT STYLE (hard rules — follow exactly):',
    '- Compact: 1-3 short paragraphs OR a short bullet list. Max 120 words.',
    `- Bold (**...**) every key number. Use "-" dash bullets for comparisons or allocations. Never use # headers, tables, code blocks, [links], or emoji.`,
    `- All money in ${brief.baseCurrency} (the user's base currency), the currency shown in the data below.`,
    '- Answer using the sections in the data snapshot below; cite the relevant section when you do.',
    '- When they ask what to buy, give process (criteria, position sizing, when to act), not a single-stock call.',
    '- Flag concentrated positions, heavy crypto, or FX exposure ONLY when the data below shows it.',
    '- No legal/tax advice; one line of "general education, not advice" only on a recommendation-adjacent answer.',
    '',
    "The data snapshot below is derived aggregates only — NOT the raw ledger. Ground every answer in it; never invent numbers that are not in it.",
    pack,
    '',
    'EXAMPLES (format + grounding only; the numbers are illustrative of style, not real data for this user):',
    'Example 1',
    'User: Where should I put new money?',
    "Coach: - First, top up your cushion: you're at **RM 9,000** of a **RM 12,000** target, so direct the next installment to the emergency reserve before the growth slice.",
    '- Once the cushion is funded, redirect new money into your lightest allocation.',
    '- Buy boring, own it long — no timing, no averaging down on a thesis you cannot restate.',
    'Example 2',
    'User: Am I overspending?',
    "Coach: Your pace is **RM 137/day** — about **RM 4,258** for a 31-day month. Your heaviest slice is **Food at 41%** of tracked spend. That's the first thing to trim, not a new subscription.",
    'Example 3',
    'User: What is my currency exposure?',
    "Coach: **30%** of your portfolio sits outside your base currency. That is a position, whether you intended it or not — a deliberate hedge beats an accidental one.",
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
    id: 'cushion',
    match: /emergency|cushion|rain ?y|buffer|how much (cash|money) (do i|should i) (have|set|keep|hold)|safety net|liquidity|liquid/i,
    answer: (b) => {
      const e = b.emergency;
      if (!e || e.lineCount === 0)
        return 'You have no emergency reserve set up yet, and that is the one thing that decides whether a job loss is a blip or a crisis. Start a separate cushion — even a small one — before you let the growth slice decide your entire financial fate. Size it to your average monthly spend.';
      const cov =
        e.coverageMonths != null
          ? ` You currently cover ${round(e.coverageMonths, 1)} months of average spend.`
          : '';
      const targetLine =
        e.targetSource === 'override'
          ? ` Your pinned target is ${money(e.target, b.baseCurrency)}.`
          : e.targetSource === 'derived'
            ? ` At ${money(e.monthlySpend, b.baseCurrency)}/month average spend, a ${e.targetMonths}-month cushion lands around ${money(e.target, b.baseCurrency)}.`
            : '';
      const statusLine =
        e.status === 'over'
          ? ` You are past target — consider whether the extra belongs in the cushion or is being held hostage as "savings" that will never get spent.`
          : e.status === 'ok'
            ? ` You are at or past target. Keep it boring and liquid; the cushion earns nothing on purpose.`
            : e.status === 'building'
              ? ` You are ${money(e.reserve, b.baseCurrency)} of ${money(e.target, b.baseCurrency)} — a ${money(Math.max(0, e.target - e.reserve), b.baseCurrency)} gap. Fund the gap before the growth slice; an underfunded cushion is a liability in disguise.`
              : '';
      const liquidity =
        e.investedValue > 0
          ? ` Note: ${money(e.investedValue, b.baseCurrency)} of it is parked in a brokerage account, not instant cash — in a true emergency you need the liquid slice, not the invested one.`
          : '';
      return `Your emergency reserve is ${money(e.reserve, b.baseCurrency)}.${cov}${targetLine}${statusLine}${liquidity}`;
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
  /** A validated action proposal the user must confirm (Apply). Any of the
   *  5 verbs (add/edit/delete expense, holding patch, new portfolio).
   *  Present only on the LLM tier, only when the LLM emitted a well-formed
   *  [ACTION:] marker that parsed + validated; the rule tier can never
   *  produce one. */
  proposedAction?: Action;
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
      // Bounded, labeled history window so cheap models can separate prior
      // context from the current question. The tail is "Context so far:"
      // because the system prompt already carries the full data pack; this
      // is just the recent conversational flow.
      const tail = history
        .slice(-HISTORY_TURNS)
        .map((m) => `${m.role === 'user' ? 'User' : 'Coach'}: ${m.text}`)
        .join('\n');
      const user = tail ? `Context so far:\n${tail}\n\nUser: ${question}` : question;
      const raw = await transport(llm, sys, user, images);
      const clean = stripActionMarker(raw.trim());
      // Validate against the user's REAL category list (ctx.categories).
      // Threading it here — not defaulting to [] — is what lets
      // add_expense / edit_expense proposals pass category validation;
      // without it every expense action was silently rejected and the
      // confirm card never appeared.
      const parsed = parseAction(raw, ctx.categories);
      if (parsed.ok && parsed.action) {
        // The visible text is marker-free; the action (if any) is surfaced
        // separately for the confirm card.
        return { text: clean, source: 'llm', degraded: false, proposedAction: parsed.action };
      }
      if (clean.length === 0) {
        // The reply was ONLY an action marker and it failed validation.
        // Say so in plain words (with the reason, which names the valid
        // values) instead of silently falling through to a rule-engine
        // answer that would pretend the request was analysis.
        return {
          text: `I could not apply that — ${parsed.reason ?? 'the proposed change was invalid'}. Tell me what to adjust and I will re-propose it.`,
          source: 'llm',
          degraded: false,
        };
      }
      // The reply contained a marker we could not accept, alongside real
      // text. Keep the text (marker stripped) but say the proposal was not
      // accepted, so the user is not told something is pending when it is not.
      const why = parsed.reason && parsed.reason !== 'No [ACTION:] marker found.'
        ? ` The change I proposed was not accepted (${parsed.reason}).`
        : '';
      return { text: clean + why, source: 'llm', degraded: false };
    } catch (e) {
      // Fall through to rules — a failed BYOK call must not kill the chat —
      // but keep the provider's reason so the UI can explain the fallback.
      llmError = e instanceof Error ? e.message : String(e);
    }
  }

  const fb = coachFallback(question, brief, images.length > 0);
  return { ...fb, degraded: Boolean(llm), llmError };
}

export const __test = { buildBrief, buildContextPack, coachSystemPrompt, coachFallback, INTENTS, HISTORY_TURNS };
