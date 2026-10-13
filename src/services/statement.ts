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

import {
  callLLM,
  categorize,
  categorizeByDictionary,
  LLM_MAX_TOKENS,
  type LLMConfig,
} from '../ai/categorize';
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
// 1. LLM parser (BYOK) — chunked so big statements never send one blob
// ---------------------------------------------------------------------------

const KNOWN_CURRENCY_RE =
  /\b(MYR|SGD|USD|EUR|GBP|JPY|AUD|CAD|HKD|CNY|IDR|THB|PHP|VND|INR|KRW|CHF)\b/;

/** Hard cap per LLM call. We split the statement ourselves so the prompt
 *  stays small even for multi-year statements — one call, one chunk. */
export const LLM_CHUNK_CHARS = 12000;

const LLM_SYSTEM =
  'You are a bank/card statement parser. From the raw statement text, extract ' +
  'every individual transaction. For each, output { date (YYYY-MM-DD or null), ' +
  'merchant (short name), description (extra detail, "" if none), amount (positive ' +
  'number, no sign), direction ("out" for spend/withdrawal, "in" for deposit/salary/' +
  'refund/credit), currency (ISO-4217 or null) }. ' +
  'Skip totals, balances, headers, and non-transaction lines. ' +
  'Reply with ONLY a JSON array of these objects — no prose, no markdown.';

/** Split a big statement into LLM-sized chunks on line boundaries, so no
 *  single call ever ships the whole blob. Chunks keep whole lines: a
 *  transaction never straddles two chunks. */
export function chunkStatementText(text: string, maxChars: number = LLM_CHUNK_CHARS): string[] {
  const t = text.trim();
  if (t.length <= maxChars) return [t];
  const lines = t.split(/\r?\n/);
  const chunks: string[] = [];
  let buf = '';
  for (const line of lines) {
    // A single line longer than the cap gets its own chunk (rare: wrapped text).
    if (line.length > maxChars) {
      if (buf) { chunks.push(buf); buf = ''; }
      for (let i = 0; i < line.length; i += maxChars) {
        chunks.push(line.slice(i, i + maxChars));
      }
      continue;
    }
    if (buf && buf.length + line.length + 1 > maxChars) {
      chunks.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + '\n' + line : line;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

export function buildLLMPrompt(text: string): { system: string; user: string } {
  const chunks = chunkStatementText(text);
  // Single-chunk statements pass through unchanged; multi-chunk callers are
  // expected to feed one chunk at a time (see parseStatementWithLLM).
  const user = chunks.length === 1 ? chunks[0] : text.slice(0, LLM_CHUNK_CHARS);
  return { system: LLM_SYSTEM, user };
}

async function parseStatementWithLLM(
  text: string,
  llm: LLMConfig,
  signal?: AbortSignal,
  onProgress?: (p: number, phase: string) => void,
): Promise<{ lines: ParsedStatementLine[] | null; error?: string }> {
  const chunks = chunkStatementText(text);
  const all: ParsedStatementLine[] = [];
  for (let ci = 0; ci < chunks.length; ci++) {
    if (signal?.aborted) return { lines: null, error: 'cancelled' };
    onProgress?.(ci / chunks.length, `Extracting ${ci + 1}/${chunks.length}`);
    let raw: string;
    try {
      raw = await callLLM(llm, LLM_SYSTEM, chunks[ci], [], true, LLM_MAX_TOKENS.statementChunk);
    } catch {
      // One bad chunk must not kill the whole import: keep what we have.
      if (all.length > 0) break;
      return { lines: null, error: `chunk ${ci + 1} failed` };
    }
    const arr = extractJsonArray(raw);
    if (!arr) {
      if (all.length > 0) break;
      if (ci === chunks.length - 1) return { lines: null, error: 'no JSON found' };
      continue;
    }
    for (const o of arr) {
      if (typeof o?.merchant !== 'string' || !o.merchant.trim()) continue;
      const amount = Number(o.amount);
      if (!isFinite(amount) || amount <= 0) continue;
      const dir: Direction =
        o.direction === 'in' || o.direction === 'credit' ? 'in' : 'out';
      all.push({
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
    onProgress?.((ci + 1) / chunks.length, `Extracting ${ci + 1}/${chunks.length}`);
  }
  return all.length ? { lines: all } : { lines: null, error: 'no transactions found' };
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
// Income (inflow) hints. Strong words go first: 'credit' and 'transfer' are
// too noisy on their own (merchant names like "CREDIT UNION", "TRANSFER TO
// MUM") so they only count when followed by in/from/into — the bare forms are
// dropped. Word boundaries keep "cash in" matching but not "cashpoint".
const INCOME_HINT_RE =
  /\b(deposit|salary|payroll|refund|cashback|dividend|income|received|paid in|cash (in|back)|transfer (in|from|into)|credit(ed|ing) (in|to))\b/i;
// Outflow (spend) hints, used only as a tiebreaker when a line has both
// income and outflow words — e.g. "DEBIT CARD PURCHASE ... CREDIT UNION".
const OUTFLOW_HINT_RE =
  /\b(debit|purchase|payment to|billed|withdrawn?|charge[d]?|spent)\b/i;

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

  const hasIncome = INCOME_HINT_RE.test(line);
  const hasOutflow = OUTFLOW_HINT_RE.test(line);
  const last = amounts[amounts.length - 1];
  // Precedence: an income hint wins over an outflow hint ("DEBIT ... CREDITED
  // IN" is still an inflow); a lone outflow hint wins over nothing; otherwise
  // the sign of the final amount decides — negative = withdrawal (out), a
  // bare positive = purchase (out), because statements that show credits as
  // plus-sign usually label them "credit/deposit" and hit the income branch.
  let direction: Direction =
    hasIncome && !hasOutflow ? 'in'
    : hasOutflow ? 'out'
    : last.neg ? 'out'
    : 'out';

  // Currency hint.
  const curMatch = line.match(KNOWN_CURRENCY_RE);
  const currency = curMatch ? curMatch[0] : undefined;

  // Merchant: drop the date, the amount(s), currency code, and common noise.
  let merchant = rest
    .replace(AMOUNT_RE, ' ')
    .replace(KNOWN_CURRENCY_RE, ' ')
    .replace(
      /(debit|credit|withdraw|payment|purchase|refund|deposit|salary|payroll|dividend|income|cash ?(in|out|back)|transfer ?(in|from|out))\b/gi,
      ' ',
    )
    .replace(/\bMY\b/g, ' ') // country token, not part of a merchant name
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
 *
 * When an LLM key is present, merchants are sent in batches (one call per
 * batch, not one call per line) — a 300-transaction statement becomes ~5
 * round-trips instead of 300. Batches fall back to the dictionary per-row
 * on failure, so one bad batch never loses the rest.
 */
export async function categorizeLines(
  lines: ParsedStatementLine[],
  opts: {
    categories?: Category[];
    llm?: LLMConfig | null;
    signal?: AbortSignal;
    onProgress?: (p: number, phase: string) => void;
  },
): Promise<void> {
  const cats = opts.categories?.length ? opts.categories : CATEGORIES;
  const llm = opts.llm && opts.llm.apiKey ? opts.llm : null;

  // Income lines: deterministic, zero cost.
  for (const ln of lines) {
    if (ln.direction === 'in') {
      ln.category = 'Income';
      ln.aiTier = 'dictionary';
    }
  }

  const out = lines.filter((ln) => ln.direction !== 'in');
  if (out.length === 0) return;

  if (!llm) {
    // Dictionary tier: fast, no network.
    for (let i = 0; i < out.length; i++) {
      const r = categorizeByDictionary(out[i], cats);
      out[i].category = r.category;
      out[i].aiTier = r.tier;
      opts.onProgress?.((i + 1) / out.length, `Categorizing ${i + 1}/${out.length}`);
    }
    return;
  }

  // LLM tier: batch by distinct merchant (same merchant -> same category).
  const BATCH = 40;
  const uniq = new Map<string, { line: ParsedStatementLine; idx: number }>();
  out.forEach((ln, idx) => uniq.set(ln.merchant.toLowerCase(), { line: ln, idx }));
  const uniqMerchants = [...uniq.values()];
  for (let b = 0; b < uniqMerchants.length; b += BATCH) {
    if (opts.signal?.aborted) return;
    const batch = uniqMerchants.slice(b, b + BATCH);
    opts.onProgress?.(
      Math.min(1, b / uniqMerchants.length),
      `Categorizing batch ${Math.floor(b / BATCH) + 1}/${Math.ceil(uniqMerchants.length / BATCH)}`,
    );
    const r = await categorizeBatchLLM(batch.map((u) => u.line), cats, llm);
    const ok = r ? new Map(r.map((c, i) => [i, c])) : null;
    for (const u of batch) {
      const i = batch.indexOf(u);
      if (ok && ok.has(i)) {
        u.line.category = ok.get(i)!.category;
        u.line.aiTier = 'llm-byok';
      } else {
        // Per-row dictionary fallback: one bad batch never loses the rest.
        const d = categorizeByDictionary(u.line, cats);
        u.line.category = d.category;
        u.line.aiTier = 'dictionary';
      }
    }
  }
  opts.onProgress?.(1, 'Categorizing');
}

/** One LLM call that returns a category for up to `BATCH` merchants.
 *  Returns null when the provider fails so callers can fall back. */
async function categorizeBatchLLM(
  lines: ParsedStatementLine[],
  categories: Category[],
  llm: LLMConfig,
): Promise<{ category: string }[] | null> {
  const names = categories.map((c) => c.name);
  const sys =
    'You are a personal finance categorisation engine. Given a list of merchant ' +
    'names, pick exactly one category for each from this list: [' +
    names.join(', ') + ']. If none fit, use "Other". Reply with ONLY a JSON ' +
    'array of {"merchant":string,"category":string} in the same order, no prose.';
  const user = JSON.stringify(
    lines.map((ln) => ({
      merchant: ln.merchant,
      description: ln.description ?? '',
      currency: ln.currency ?? null,
    })),
  );
  let raw: string;
  try {
    raw = await callLLM(llm, sys, user, [], true, LLM_MAX_TOKENS.statementChunk);
  } catch {
    return null;
  }
  const arr = extractJsonArray(raw);
  if (!arr || !Array.isArray(arr) || arr.length < lines.length) {
    // Partial/invalid reply: caller falls back per-row.
    if (!arr) return null;
  }
  const out: { category: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const o = arr[i];
    if (o && typeof o.category === 'string' && o.category.trim()) {
      out.push({ category: o.category.trim() });
    } else {
      out.push({ category: 'Other' });
    }
  }
  return out;
}

/**
 * Parse raw statement text via LLM (when a key is present) or regex, then
 * categorize every line. The `pdf.ts` wrapper feeds this its extracted
 * text, but it is also directly usable for pasted statement text.
 *
 * `signal` aborts mid-parse (the user tapped Cancel). On abort the partial
 * checkpoint is cleared by the caller, not re-thrown.
 */
export async function parseStatementText(
  text: string,
  opts: {
    llm?: LLMConfig | null;
    categories?: Category[];
    signal?: AbortSignal;
    onProgress?: (p: number, phase: string) => void;
  },
): Promise<ParseStatementResult> {
  let lines: ParsedStatementLine[] | null = null;
  let parser: 'llm' | 'regex' = 'regex';
  let llmError: string | undefined;
  let llmSkipped = false;
  if (opts.llm && opts.llm.apiKey) {
    if (opts.signal?.aborted) throw new Error('import cancelled');
    const res = await parseStatementWithLLM(text, opts.llm, opts.signal, (p, ph) =>
      opts.onProgress?.(p * 0.3, ph),
    );
    if (res.error === 'cancelled') throw new Error('import cancelled');
    if (res.lines) {
      parser = 'llm';
      lines = res.lines;
    } else {
      llmSkipped = true;
      llmError =
        res.error === 'no transactions found'
          ? 'LLM found no transactions; used regex fallback.'
          : 'LLM extraction failed; used regex fallback.';
    }
  }
  if (!lines) {
    if (opts.signal?.aborted) throw new Error('import cancelled');
    lines = parseStatement(text);
  }

  if (lines.length === 0) {
    return { lines, parser, llmSkipped, llmError };
  }

  await categorizeLines(lines, {
    categories: opts.categories,
    llm: opts.llm ?? undefined,
    signal: opts.signal,
    onProgress: (p, phase) => opts.onProgress?.(0.3 + p * 0.7, phase),
  });

  return { lines, parser, llmSkipped, llmError };
}

export const __test = {
  parseLine,
  dateFromParts,
  buildLLMPrompt,
  chunkStatementText,
  categorizeBatchLLM,
};
