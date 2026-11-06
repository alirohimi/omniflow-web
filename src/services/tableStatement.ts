// ============================================================================
// OmniFlow — bank-statement table parser (deterministic, $0, no LLM).
//
// Many bank statements (Maybank/M2U, CIMB, RHB, bank cards) lay transactions
// out as a 4-column table:
//
//     ENTRY DATE | TRANSACTION DESCRIPTION | TRANSACTION AMOUNT | STATEMENT BALANCE
//     01/09/26   | SALE DEBIT             | 23.33-             | 275.02
//
//   The generic regex in `statement.ts` grabs the LAST number on the row,
//   which is the STATEMENT BALANCE, not the TRANSACTION AMOUNT. That is the
//   bug this module fixes: it recognises the signed-amount-then-balance shape
//   and pulls the correct column.
//
//   M2U/Maybank additionally print the REAL merchant name on the 2-3 indented
//   detail lines directly under each table row:
//
//     01/09/26 SALE DEBIT 23.33- 275.02
//        Shopee Mobile Malay*
//        0327779222, MY
//        SALE DEBIT
//
//   so this parser also walks the following detail lines and promotes the
//   most-likely-merchant token to `merchant` (falling back to the table's
//   description when no detail line names one).
//
// Pure + unit-testable: no pdf.js, no DOM, no network. `parseStatementText`
// in `./statement` calls this FIRST; only when it finds nothing does the
// generic regex / LLM path run.
// ============================================================================

import type { ParsedStatementLine, Direction } from '../domain/types';

/** A parsed bank-table transaction row. */
export interface TableTx {
  date: number;
  merchant: string;
  description?: string;
  amount: number;
  direction: Direction;
  /** The running STATEMENT BALANCE that followed the row (kept for the
   *  user's reference + as an LLM-verification hint, never imported). */
  balance?: number;
}

// ---------------------------------------------------------------------------
// Date helpers. DD/MM/YY (or DD/MM/YYYY) is the Malaysian-bank convention.
// dateFromParts is keyed (year, month, day).
// ---------------------------------------------------------------------------

function dateFromParts(year: number, month: number, day: number): number | undefined {
  // 2-digit years: 00-99 -> 2000-2099 (bank statements are recent).
  const y = year < 100 ? 2000 + year : year;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const t = Date.UTC(y, month - 1, day);
  return isNaN(t) ? undefined : t;
}

/** Parse a DD/MM/YY(or YYYY) string -> epoch ms, or undefined. */
export function parseDDMY(dateStr: string): number | undefined {
  const p = dateStr.split(/[\/\-.]/).map(Number);
  if (p.length < 3) return undefined;
  // p[0]=day, p[1]=month, p[2]=year (2 or 4 digits).
  return dateFromParts(p[2], p[1], p[0]);
}

// DD/MM/YY or DD/MM/YYYY (the M2U/Maybank/Malaysian-bank convention).
const DATE_LINE_RE = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\s/;

// A full bank-table transaction row: date, description, signed amount, balance.
// The AMOUNT column carries an explicit +/- sign right after the digits, which
// is the signature that separates it from the (unsigned) BALANCE column.
const TX_ROW_RE =
  /^(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})\s+(.+?)\s+(\d[\d,]*\.?\d*)\s*([+\-])\s+(\d[\d,]*\.?\d*)\s*$/;

// ---------------------------------------------------------------------------
// 1. Split raw statement text into "table rows" + their detail lines.
// ---------------------------------------------------------------------------

/**
 * Detect whether this statement uses a signed-amount + trailing-balance table
 * layout (M2U/Maybank/CIMB/RHB style). Returns true when at least one line
 * matches the 4-column tx-row shape — that's enough to switch the whole parse
 * to table mode, because the generic regex would grab the balance column.
 */
export function looksLikeTableStatement(text: string): boolean {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let hits = 0;
  for (const l of lines) {
    if (TX_ROW_RE.test(l)) hits++;
    if (hits >= 2) return true;
  }
  return false;
}

/**
 * Parse a table-layout statement into ParsedStatementLine[].
 *
 * Two-pass, order-independent (pdf.js text extraction does NOT guarantee the
 * detail lines of a row sit immediately after it — they can land before it or
 * be interleaved, so a greedy forward walk under- or over-counts rows):
 *
 *   Pass 1: find every tx row (TX_ROW_RE) in file order and record its index.
 *   Pass 2: for each row, the "detail block" is the contiguous run of
 *           non-tx-row lines between this row's index and the next tx row's
 *           index. From that block we pick the real merchant name; the table
 *           description is kept as `description`. This works whether the
 *           details physically precede or follow the row, because we only
 *           ever look at the block that belongs to THIS row.
 *
 * The critical fix: the TRANSACTION AMOUNT is the signed column (m[3] with a
 * trailing +/-), NOT the trailing STATEMENT BALANCE (m[5]). The generic
 * regex in statement.ts grabs the last number (= balance); here we keep the
 * two columns separate.
 */
export function parseTableStatement(text: string): ParsedStatementLine[] {
  const rawLines = text.split(/\r?\n/).map((l) => l.replace(/\t/g, ' '));
  // Keep the original (possibly-blank) lines so index arithmetic is stable,
  // but only non-empty lines matter for matching.
  const lines = rawLines;

  // Pass 1: locate every tx row and capture its fields.
  interface TxRef {
    index: number;
    date: number;
    description: string;
    amount: number;
    direction: Direction;
    balance?: number;
  }
  const refs: TxRef[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const m = t.match(TX_ROW_RE);
    if (!m) continue;
    const date = parseDDMY(m[1]);
    if (date == null) continue;
    const amount = Number(m[3].replace(/,/g, ''));
    if (!isFinite(amount) || amount === 0) continue;
    refs.push({
      index: i,
      date,
      description: m[2].trim(),
      amount: Math.abs(amount),
      direction: m[4] === '+' ? 'in' : 'out',
      balance: (() => {
        const b = Number(m[5].replace(/,/g, ''));
        return isFinite(b) ? b : undefined;
      })(),
    });
  }
  if (refs.length === 0) return [];

  // Pass 2: for each row, gather the detail block (lines strictly between this
  // row and the next row) and pick the merchant.
  const out: ParsedStatementLine[] = [];
  for (let k = 0; k < refs.length; k++) {
    const ref = refs[k];
    const nextIndex = k + 1 < refs.length ? refs[k + 1].index : lines.length;
    const detail: string[] = [];
    for (let j = ref.index + 1; j < nextIndex; j++) {
      const t = lines[j].trim();
      if (t === '') continue;
      if (isNoiseLine(t)) continue; // headers / footers / totals / fine print
      detail.push(t);
    }
    const merchant =
      pickMerchant(ref.description, detail) ||
      ref.description ||
      'Unknown merchant';
    out.push({
      raw: lines[ref.index].trim(),
      date: ref.date,
      merchant,
      description: ref.description !== merchant ? ref.description : undefined,
      amount: ref.amount,
      direction: ref.direction,
      balance: ref.balance,
    });
  }
  return out;
}

/** A line that is bank chrome (page headers, footers, fine print, totals),
 *  not a transaction detail. */
function isNoiseLine(t: string): boolean {
  return (
    /^ENDING BALANCE/i.test(t) ||
    /^TOTAL (CREDIT|DEBIT)/i.test(t) ||
    /^BEGINNING BALANCE/i.test(t) ||
    /^(TARIKH PENYATA|STATEMENT DATE|MUKA|NOMBOR AKAUN|ACCOUNT\s+NUMBER)/i.test(t) ||
    /^PROTECTED BY PIDM/i.test(t) ||
    /^Maybank Islamic/i.test(t) ||
    /^Perhation/i.test(t) ||
    /^Semua maklumat/i.test(t) ||
    /^All items and balances/i.test(t) ||
    /^Sila beritahui?/i.test(t) ||
    /^Please notify us/i.test(t) ||
    /^Faedah/i.test(t) ||
    /^Interest refers/i.test(t) ||
    /^15th Floor, Tower A/i.test(t) ||
    /^DUITNOW QR$/i.test(t) ||
    /^SALE DEBIT$/i.test(t) ||
    /^IBS MID VALLEY/i.test(t) ||
    /^ICHSAN ALI RACHIMI$/i.test(t) ||
    /^PACIFIC PLACA/i.test(t) ||
    /^PETALING JAYA ,/i.test(t)
  );
}

// ---------------------------------------------------------------------------
// 2. Merchant selection from the detail lines.
// ---------------------------------------------------------------------------

// Tokens that are NOT merchant names: QR codes, PANs, card-issuer tags,
// place names that are pure "CITY, MY", and the literal "SALE DEBIT" style
// tags. The real merchant is the first detail line that is a proper name.
const NON_MERCHANT_RE =
  /^(QR|MAE|MBB|DUITNOW|SALE DEBIT|IBK FUND|FUND|WANT|TRANSFER|PAYMENT|FRA|W\d{1,2}D\d{3}|PTXP|MBBCT|MAYBANK|MAE QR|QR PAY|MONTHLY|WANTS?|CASH JAR|DUITNOW QR|MBB CT|MBB QR|DUITNOW|T24|IBS |TP01|FUND\b|WTDRW|FUND WANTS|SALE\b|DEBIT\b|CREDIT\b|\d{4,}(\.\d+)?\d*|MY$|,\s*MY$)/i;

/** Pick the best merchant from a table description + its detail lines.
 *  Preference: a detail line that is alphabetic-dominant (a name), then the
 *  table description, then anything left. */
function pickMerchant(description: string, detail: string[]): string {
  // First pass: a detail line that is mostly letters (>= 50% alphabetic),
  // has 3+ letters, and isn't a known non-merchant token.
  const cand = detail.filter((d) => {
    const letters = (d.match(/[A-Za-z]/g) || []).length;
    if (letters < 3) return false;
    if (NON_MERCHANT_RE.test(d)) return false;
    // Reject pure QR / numeric / pan tokens and bare "CITY, MY" place lines.
    if (/^\d/.test(d) && letters / d.length < 0.4) return false;
    if (/^[\d,.\s]+$/.test(d)) return false;
    return letters / d.length >= 0.5;
  });
  if (cand.length) return tidy(cand[0]);
  // Fall back to the table description (e.g. "FUND TRANSFER TO A/" -> keep as
  // a readable label), or 'Unknown merchant'.
  return tidy(description);
}

/** Normalise a merchant token: collapse whitespace, trim a trailing '*' the
 *  bank uses to mark "card-present", keep it readable. */
function tidy(s: string): string {
  return s
    .replace(/\*+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim() || '';
}

// ---------------------------------------------------------------------------
// 3. Verification hook (the LLM is used ONLY to sanity-check, not to do the
//    extraction — extraction is 100% deterministic here).
// ---------------------------------------------------------------------------

/**
 * Given a parsed table row, ask the LLM to CONFIRM or CORRECT the merchant +
 * direction + amount from the raw context. Returns the corrected fields or
 * the original ones when the LLM is unavailable / disagrees ambiguously.
 *
 * This is the "use AI just to verify / complex cases" path: the deterministic
 * parser already has the right amount (the signed column, not the balance),
 * so the LLM only refines the merchant when it's still "Unknown"/"SALE
 * DEBIT" or when direction is ambiguous.
 */
export interface VerifyResult {
  merchant?: string;
  direction?: Direction;
  amount?: number;
  /** true when the LLM actually changed something. */
  changed: boolean;
}

export function shouldVerify(row: ParsedStatementLine): boolean {
  // Only bother the LLM for rows that still look unresolved.
  const weak =
    !row.merchant ||
    row.merchant === 'Unknown merchant' ||
    /^(SALE DEBIT|IBK FUND TFR|FUND TRANSFER|TRANSFER FROM|FPX PAYMENT|PRE-AUTH DEBIT|DUITNOW PAYMENT|MAS PAYMENT)/i.test(
      row.merchant,
    );
  return weak;
}
