// ============================================================================
// OmniFlow — PDF statement import: pure engine tests (no DOM, no pdf.js).
// Covers the regex statement parser, the LLM JSON-extraction helpers, and
// date/currency heuristics that the import preview screen relies on.
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  parseStatement,
  extractJsonArray,
  parseISODate,
  buildLLMPrompt,
  parseStatementText,
  __test,
} from '../src/services/statement';
import {
  looksLikeTableStatement,
  parseTableStatement,
  parseDDMY,
} from '../src/services/tableStatement';

const { parseLine, dateFromParts } = __test;

// ---------------------------------------------------------------------------
// Bank-table (M2U / Maybank / CIMB / RHB) deterministic parser
// ---------------------------------------------------------------------------

describe('parseTableStatement (4-column bank table)', () => {
  // A realistic M2U/Maybank flat-text layout: each tx is a 4-column row
  // (date | desc | amount± | balance) followed by 2-3 detail lines that carry
  // the REAL merchant name.
  const m2u = [
    '03/09/26 SALE DEBIT 21.50- 595.61',
    '   Puzzini Swedish Piz*',
    '   840516591Q',
    '03/09/26 FUND TRANSFER TO A/ 500.00+ 630.01',
    '   ICHSAN ALI RACHIMI *',
    '   00000001',
    '03/09/26 IBK FUND TFR FR A/C 12.90- 617.11',
    '   Nasi Kandar Penang *',
    '   MBBQR111113786562795',
    '   840516591Q',
    '02/09/26 SALE DEBIT 102.41- 142.51',
    '   SHOPEE - APPLEPAY-E*',
    '   0327779222, MY',
    'ENDING BALANCE :',
    '1,832.02',
  ].join('\n');

  it('detects the table layout', () => {
    expect(looksLikeTableStatement(m2u)).toBe(true);
    // A plain text receipt with no signed-amount-then-balance shape is NOT a
    // table statement.
    expect(looksLikeTableStatement('7-Eleven 15.50\nShopee 89.90')).toBe(false);
  });

  it('reads the signed AMOUNT column, not the trailing STATEMENT BALANCE', () => {
    const rows = parseTableStatement(m2u);
    expect(rows).toHaveLength(4);
    // The first tx is 21.50 (debit) with a running balance of 595.61. The old
    // bug imported 595.61 as the amount; now the amount is 21.50 and the
    // balance is kept separately.
    const first = rows[0];
    expect(first.amount).toBe(21.5);
    expect(first.direction).toBe('out');
    expect(first.balance).toBe(595.61);
    // The credit row is marked direction 'in'.
    const credit = rows.find((r) => r.amount === 500)!;
    expect(credit.direction).toBe('in');
  });

  it('DD/MM/YY parses to the correct UTC date (day-month not swapped)', () => {
    const d = parseDDMY('03/09/26');
    expect(d).toBe(Date.UTC(2026, 8, 3)); // Sep 3 2026
  });

  it('promotes the real merchant from the detail lines, not "SALE DEBIT"', () => {
    const rows = parseTableStatement(m2u);
    expect(rows[0].merchant).toContain('Puzzini');
    expect(rows[0].description).toBe('SALE DEBIT');
    // The merchant token "Puzzini Swedish Piz*" gets its trailing * trimmed.
    expect(rows[0].merchant).not.toContain('*');
  });

  it('runs before the generic regex in parseStatementText (deterministic win)', async () => {
    // No LLM: the table parser must produce the rows; the generic regex would
    // have grabbed the balance column.
    const { lines, parser } = await parseStatementText(m2u, {});
    expect(parser).toBe('regex'); // deterministic (rule) path
    expect(lines).toHaveLength(4);
    expect(lines[0].amount).toBe(21.5);
  });
});

// ---------------------------------------------------------------------------
// Regex statement parser
// ---------------------------------------------------------------------------

describe('parseStatement (regex tier)', () => {
  it('parses a typical Malaysian bank e-statement (dmy dates, amounts)', () => {
    const text = [
      '09/09/2026 7-Eleven Express 15.50',
      '10/09/2026 Shopee -89.90',
      '11/09/2026 Maxis Postpaid 99.00 MYR',
      'TOTAL SPENT 204.40',
    ].join('\n');
    const lines = parseStatement(text);
    // The totals line has no date -> skipped.
    expect(lines).toHaveLength(3);
    expect(lines[0].merchant).toBe('7-Eleven Express');
    expect(lines[0].amount).toBe(15.5);
    expect(lines[0].direction).toBe('out');
    expect(lines[0].date).toBe(Date.UTC(2026, 8, 9)); // Sep 09

    expect(lines[1].merchant).toBe('Shopee');
    expect(lines[1].amount).toBe(89.9); // magnitude, sign in direction
    expect(lines[1].direction).toBe('out');

    expect(lines[2].currency).toBe('MYR');
    expect(lines[2].date).toBe(Date.UTC(2026, 8, 11));
  });

  it('parses ISO dates (ymd order)', () => {
    const lines = parseStatement('2026-09-15 Starbucks #4432 24.90');
    expect(lines).toHaveLength(1);
    expect(lines[0].date).toBe(Date.UTC(2026, 8, 15));
    expect(lines[0].amount).toBe(24.9);
  });

  it('handles thousands separators and decimals', () => {
    const lines = parseStatement('01/09/2026 Amazon 1,234.56 MYR');
    expect(lines[0].amount).toBe(1234.56);
    expect(lines[0].currency).toBe('MYR');
    expect(lines[0].merchant).toBe('Amazon');
  });

  it('classifies income hints as direction=in', () => {
    const lines = parseStatement('05/09/2026 salary deposit 3500.00');
    expect(lines).toHaveLength(1);
    expect(lines[0].direction).toBe('in');
  });

  it('treats first field > 12 as the month (15/08 -> Aug 15)', () => {
    const lines = parseStatement('15/08/2026 Netflix 25.90');
    expect(lines[0].date).toBe(Date.UTC(2026, 7, 15));
  });

  it('skips lines without a date (headers, totals, balance lines)', () => {
    const text = [
      'CIBBERONLINE STATEMENT 01/09/2026 - 30/09/2026',
      'OPENING BALANCE 10,000.00',
      'CLOSING BALANCE 9,795.60',
      '05/09/2026 GrabFood 42.30',
    ].join('\n');
    const lines = parseStatement(text);
    expect(lines).toHaveLength(1);
    expect(lines[0].merchant).toBe('GrabFood');
  });

  it('falls back to "Unknown merchant" when only date+amount remain', () => {
    const line = parseLine('01/09/2026 15.00');
    expect(line?.merchant).toBe('Unknown merchant');
    expect(line?.amount).toBe(15);
  });

  it('detects multiple currencies but only on the matching line', () => {
    const text = ['01/09/2026 PayNow transfer 120.00 SGD', '02/09/2026 KFC 22.10'].join('\n');
    const lines = parseStatement(text);
    expect(lines[0].currency).toBe('SGD');
    expect(lines[1].currency).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// dateFromParts / parseISODate
// ---------------------------------------------------------------------------

describe('date helpers', () => {
  it('dateFromParts ymd: 4-digit year, 2-digit year rejected only if bad month/day', () => {
    expect(dateFromParts(2026, 1, 15, 'ymd')).toBe(Date.UTC(2026, 0, 15));
    expect(dateFromParts(2026, 13, 1, 'ymd')).toBeUndefined(); // month 13
    expect(dateFromParts(2026, 1, 32, 'ymd')).toBeUndefined(); // day 32
  });

  it('dateFromParts dmy: short year rolls forward +2000', () => {
    // order dmy means (a=month after caller heuristic, b=day, c=year)
    expect(dateFromParts(9, 1, 26, 'dmy')).toBe(Date.UTC(2026, 8, 1));
    expect(dateFromParts(9, 1, 2026, 'dmy')).toBe(Date.UTC(2026, 8, 1));
  });

  it('parseISODate: valid / blank / garbage', () => {
    expect(parseISODate('2026-09-01')).toBe(Date.parse('2026-09-01'));
    expect(parseISODate('')).toBeUndefined();
    expect(parseISODate('not a date')).toBeUndefined();
    expect(parseISODate(null)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// LLM JSON extraction (BYOK tier)
// ---------------------------------------------------------------------------

describe('extractJsonArray (LLM tier)', () => {
  it('parses a clean JSON array', () => {
    const raw = '[{"merchant":"7-Eleven","amount":15.5,"direction":"out"}]';
    const arr = extractJsonArray(raw);
    expect(arr).toHaveLength(1);
    expect(arr![0].merchant).toBe('7-Eleven');
  });

  it('finds the array embedded in prose or markdown fences', () => {
    const raw =
      'Sure! Here are the transactions:\n```json\n' +
      '[{"merchant":"Shopee","amount":89.9,"direction":"out"}]\n```\nLet me know if…';
    const arr = extractJsonArray(raw);
    expect(arr).toHaveLength(1);
    expect(arr![0].merchant).toBe('Shopee');
  });

  it('wraps a single JSON object into an array', () => {
    const arr = extractJsonArray('{"merchant":"Grab","amount":5}');
    expect(arr).toHaveLength(1);
    expect(arr![0].merchant).toBe('Grab');
  });

  it('returns null for garbage that has no JSON at all', () => {
    expect(extractJsonArray('no transactions found in this document')).toBeNull();
    expect(extractJsonArray('')).toBeNull();
  });

  it('buildLLMPrompt caps oversized text at 12000 chars', () => {
    const big = 'x'.repeat(20000);
    const { user } = buildLLMPrompt(big);
    expect(user.length).toBe(12000);
    expect(user).not.toContain('y');
    expect(buildLLMPrompt('small').user).toBe('small');
  });
});
