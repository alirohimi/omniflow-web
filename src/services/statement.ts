// ============================================================================
// OmniFlow — statement text engine (pure, $0, offline-capable, unit-testable).
//
// This module takes raw statement TEXT and turns it into ParsedStatementLine[]:
//   - Tier 1: LLM (BYOK) — if the user stored an API key, ask it to emit a
//     strict JSON array of transactions.
//   - Tier 2: Regex       — always-available offline fallback that finds
//     date + merchant + amount on each statement line.
// Each surviving line is then run through categorize() so imported
// transactions get the same auto-category a manually typed one would.
//
// No pdf.js, no DOM, no network calls except the optional BYOK LLM — so the
// whole thing is testable under Node/vitest and importable by any future
// "paste statement text" path.
// ============================================================================

import { callLLM, categorize, type LLMConfig } from '../ai/categorize';
import { CATEGORIES } from '../domain/enums';
import type {
  Category,
  Direction,
  ParsedStatementLine,
} from '../domain/types';

// `Direction` and `ParsedStatementLine` are canonical in `domain/types` so
// they can be persisted inside the encrypted vault blob (see `PendingImport`).
// Re-exported here for the many importers that reach for them via `services`.
export type { Direction, ParsedStatementLine } from '../domain/types';

export interface ParseStatementResult {
  lines: ParsedStatementLine[];
  /** Which engine produced the structure: 'llm' or 'regex'. */
  parser: 'llm' | 'regex';
  /** True when the LLM path was available but we used regex anyway. */
  llmSkipped?: boolean;
  llmError?: string;
}

// ---------------------------------------------------------------------------
// 1. LLM parser (BYOK)
// ---------------------------------------------------------------------------

const KNOWN_CURRENCY_RE =
  /\b(MYR|SGD|USD|EUR|GBP|JPY|AUD|CAD|HKD|CNY|IDR|THB|PHP|VND|INR|KRW|CHF)\b/;

export function buildLLMPrompt(text: string): { system: string; user: string } {
  const system =
    'You are a bank/card statement parser. From the raw statement text, extract ' +
    'every individual transaction. For each, output { date (YYYY-MM-DD or null), ' +
    'merchant (short name), description (extra detail, "" if none), amount (positive ' +
    'number, no sign), direction ("out" for spend/withdrawal, "in" for deposit/salary/' +
    'refund/credit), currency (ISO-4217 or null) }. ' +
    'Skip totals, balances, headers, and non-transaction lines. ' +
    'Reply with ONLY a JSON array of these objects — no prose, no markdown.';
  // Keep the prompt bounded: statements can be long; cap to the useful part.
  const user = text.length > 12000 ? text.slice(0, 12000) : text;
  return { system, user };
}

async function parseStatementWithLLM(
  text: string,
  llm: LLMConfig,
): Promise<ParsedStatementLine[] | null> {
  const { system, user } = buildLLMPrompt(text);
  let raw: string;
  try {
    raw = await callLLM(llm, system, user, [], true);
  } catch {
    return null; // let the caller fall back to regex
  }
  const arr = extractJsonArray(raw);
  if (!arr) return null;
  const lines: ParsedStatementLine[] = [];
  for (const o of arr) {
    if (typeof o?.merchant !== 'string' || !o.merchant.trim()) continue;
    const amount = Number(o.amount);
    if (!isFinite(amount) || amount <= 0) continue;
    const dir: Direction =
      o.direction === 'in' || o.direction === 'credit' ? 'in' : 'out';
    lines.push({
      raw: '',
      merchant: o.merchant.trim(),
      description:
        typeof o.description === 'string' && o.description
          ? o.description
          : undefined,
      amount,
      direction: dir,
      currency:
        typeof o.currency === 'string' && o.currency ? o.currency : undefined,
      date: parseISODate(o.date),
    });
  }
  return lines.length ? lines : null;
}

/** Pull a JSON array out of an LLM reply that may have stray prose around it. */
export function extractJsonArray(
  raw: string,
): Array<Record<string, unknown>> | null {
  const trimmed = raw.trim();
  try {
    const p = JSON.parse(trimmed);
    if (Array.isArray(p)) return p as Array<Record<string, unknown>>;
  } catch {
    /* fall through */
  }
  const m = trimmed.match(/(\[.*\]|\{.*\})/s);
  if (!m) return null;
  try {
    const p = JSON.parse(m[0]);
    return Array.isArray(p)
      ? (p as Array<Record<string, unknown>>)
      : ([p] as Array<Record<string, unknown>>);
  } catch {
    return null;
  }
}

export function parseISODate(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s) return undefined;
  const t = Date.parse(s);
  return isNaN(t) ? undefined : t;
}

// ---------------------------------------------------------------------------
// 2. Regex parser (offline fallback, always available)
// ---------------------------------------------------------------------------

const DATE_RES = [
  /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/, // 2026-09-01
  /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/, // 01/09/2026
];
// Any date-shaped token, used to detect header lines ("STATEMENT 01/09/2026 -
// 30/09/2026" carries two). The ymd alt wins at a position, so ISO dates are
// never double-counted.
const DATE_TOKEN_RE =
  /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/g;

// Bare numbers with optional minus / thousands separators / <=2 decimals.
// Guards: not glued to letters on the left (that is a ticker or rate, e.g.
// "USD4.16") and not followed by "-<letter>" (part of a name, e.g. "7-Eleven").
const AMOUNT_RE =
  /(?<![A-Za-z0-9])(-?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)(?![A-Za-z0-9])(?!-[A-Za-z])/g;
const INCOME_HINT_RE =
  /\b(deposit|credit|salary|payroll|refund|cashback|cash ?(in|back)|dividend|income|transfer ?(in|from)|received|paid ?in)\b/i;

export function parseStatement(text: string): ParsedStatementLine[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\t/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean);

  const out: ParsedStatementLine[] = [];
  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseLine(line: string): ParsedStatementLine | null {
  // Header/range lines ("STATEMENT 01/09/2026 - 30/09/2026") carry two
  // date-shaped tokens and are not single transactions.
  const dateTokens = line.match(DATE_TOKEN_RE);
  if (dateTokens && dateTokens.length > 1) return null;

  // Find a date (two common orders). If the line has no date, skip it — a
  // transaction line without a date is almost certainly a header/total.
  let date: number | undefined;
  let dateSpan: [number, number] | null = null;
  const ymd = line.match(DATE_RES[0]);
  if (ymd) {
    date = dateFromParts(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]), 'ymd');
    dateSpan = [ymd.index ?? 0, (ymd.index ?? 0) + ymd[0].length];
  } else {
    const dmy = line.match(DATE_RES[1]);
    if (dmy) {
      // a=field1, b=field2, c=year. Both <=12 is ambiguous -> assume
      // day/month (MYR/UK style). If b > 12 it can only be a day -> month=a.
      const a = Number(dmy[1]);
      const b = Number(dmy[2]);
      const c = Number(dmy[3]);
      const month = b > 12 ? a : b;
      const day = b > 12 ? b : a;
      date = dateFromParts(month, day, c, 'dmy');
      dateSpan = [dmy.index ?? 0, (dmy.index ?? 0) + dmy[0].length];
    }
  }
  if (date == null) return null;

  // Carve out the date so the amount/merchant regexes don't eat it.
  const before = dateSpan ? line.slice(0, dateSpan[0]) : '';
  const after = dateSpan ? line.slice(dateSpan[1]) : line;
  const rest = (before + ' ' + after).trim();

  // Amounts in `rest`. Remember the raw sign — the direction below keys off
  // it rather than re-scanning the string.
  const amounts: { n: number; neg: boolean }[] = [];
  for (const m of rest.matchAll(AMOUNT_RE)) {
    const token = m[1];
    const n = Number(token.replace(/,/g, ''));
    if (!isFinite(n) || n === 0) continue;
    amounts.push({ n: Math.abs(n), neg: token.startsWith('-') });
  }
  if (amounts.length === 0) return null;

  const isIncome = INCOME_HINT_RE.test(line);
  const last = amounts[amounts.length - 1];
  // An explicit income hint (salary/deposit/refund/credit) wins; otherwise a
  // signed-negative final amount is a withdrawal, a positive one a purchase.
  let direction: Direction = isIncome ? 'in' : 'out';

  // Currency hint.
  const curMatch = line.match(KNOWN_CURRENCY_RE);
  const currency = curMatch ? curMatch[0] : undefined;

  // Merchant: drop the date, the amount(s), currency code, and common noise.
  let merchant = rest
    .replace(AMOUNT_RE, ' ')
    .replace(KNOWN_CURRENCY_RE, ' ')
    .replace(
      /(debit|credit|withdraw|payment|purchase|refund|deposit|cash ?(in|out|back))/gi,
      ' ',
    )
    .replace(/\s{2,}/g, ' ')
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
    .trim();
  // Title-case-ish cleanup: collapse to readable.
  merchant = merchant.replace(/\s{2,}/g, ' ').trim();
  if (!merchant) merchant = 'Unknown merchant';

  return {
    raw: line,
    date,
    merchant,
    amount: last.n,
    direction,
    currency,
  };
}

function dateFromParts(
  a: number,
  b: number,
  c: number,
  order: 'ymd' | 'dmy',
): number | undefined {
  let year: number, month: number, day: number;
  if (order === 'ymd') {
    year = a;
    month = b;
    day = c;
  } else {
    // `a`/`b` already normalized day/month by the caller's >12 heuristic.
    year = c < 100 ? c + 2000 : c;
    month = a;
    day = b;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const t = Date.UTC(year, month - 1, day);
  return isNaN(t) ? undefined : t;
}

// ---------------------------------------------------------------------------
// 3. Categorization pass + combined LLM-or-regex entry point
// ---------------------------------------------------------------------------

/**
 * Run every line through the app's categorize() engine so imported
 * transactions get the same auto-category a manually typed one would.
 * Income-direction lines are forced to 'Income' regardless of LLM output.
 */
export async function categorizeLines(
  lines: ParsedStatementLine[],
  opts: { categories?: Category[]; llm?: LLMConfig | null; onProgress?: (p: number) => void },
): Promise<void> {
  const cats = opts.categories?.length ? opts.categories : CATEGORIES;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.direction === 'in') {
      ln.category = 'Income';
      ln.aiTier = 'dictionary';
    } else {
      try {
        const r = await categorize(
          { merchant: ln.merchant, description: ln.description },
          cats,
          opts.llm ?? undefined,
        );
        ln.category = r.category;
        ln.aiTier = r.tier;
      } catch {
        ln.category = 'Other';
        ln.aiTier = 'llm-failed';
      }
    }
    opts.onProgress?.((i + 1) / Math.max(1, lines.length));
  }
}

/**
 * Parse raw statement text via LLM (when a key is present) or regex, then
 * categorize every line. The `pdf.ts` wrapper feeds this its extracted
 * text, but it is also directly usable for pasted statement text.
 */
export async function parseStatementText(
  text: string,
  opts: {
    llm?: LLMConfig | null;
    categories?: Category[];
    onProgress?: (p: number, phase: string) => void;
  },
): Promise<ParseStatementResult> {
  let lines: ParsedStatementLine[] | null = null;
  let parser: 'llm' | 'regex' = 'regex';
  let llmError: string | undefined;
  let llmSkipped = false;
  if (opts.llm && opts.llm.apiKey) {
    lines = await parseStatementWithLLM(text, opts.llm);
    if (lines) {
      parser = 'llm';
    } else {
      llmSkipped = true;
      llmError = 'LLM returned no usable transactions; used regex fallback.';
    }
  }
  if (!lines) {
    lines = parseStatement(text);
  }

  opts.onProgress?.(0.5, 'Categorizing');
  await categorizeLines(lines, {
    categories: opts.categories,
    llm: opts.llm ?? undefined,
    onProgress: (p) => opts.onProgress?.(0.5 + p * 0.5, 'Categorizing'),
  });

  return { lines, parser, llmSkipped, llmError };
}

export const __test = {
  parseLine,
  dateFromParts,
  buildLLMPrompt,
};
