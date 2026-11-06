// ============================================================================
// OmniFlow — CSV export tests (Task 009 P1 #3: exportCsv was untested).
// Pure-logic module (src/services/exportCsv.ts): RFC-4180-ish quoting,
// header-only empty datasets, base-currency formatting, unknown account
// fallback, symbol escaping. No DOM, no fetch, no Date.now() — deterministic.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { expensesToCsv, holdingsToCsv } from '../src/services/exportCsv';
import type { Expense, InvestmentHolding, InvestmentAccount } from '../src/domain/types';

function exp(over: Partial<Expense> = {}): Expense {
  return {
    id: 'e1',
    originalAmount: 10,
    originalCurrency: 'USD',
    baseAmount: 42.5,
    baseCurrency: 'MYR',
    fxRate: 4.25,
    category: 'Groceries',
    aiTier: 'dictionary',
    merchant: 'Shopee',
    timestamp: 1_700_000_000_000,
    paymentMethod: 'card',
    source: 'manual',
    ...over,
  };
}

function holding(over: Partial<InvestmentHolding> = {}): InvestmentHolding {
  return {
    id: 'h1',
    accountId: 'a1',
    symbol: 'BTC',
    assetClass: 'crypto',
    holdingCurrency: 'USD',
    units: 0.5,
    averageEntryPrice: 30_000,
    currentPriceLocal: 41_200.1234,
    currentPriceBase: 0,
    ...over,
  };
}

function account(over: Partial<InvestmentAccount> = {}): InvestmentAccount {
  return {
    id: 'a1',
    platformName: 'Luno',
    accountType: 'crypto',
    baseCurrencyValue: 0,
    lastUpdated: 1_700_000_000_000,
    ...over,
  };
}

describe('expensesToCsv — positive', () => {
  it('emits the header row first, exactly the 9 documented columns', () => {
    const lines = expensesToCsv([exp()]).split('\n');
    expect(lines[0]).toBe('date,merchant,category,paymentMethod,currency,originalAmount,baseAmount,fxRate,note');
  });

  it('formats originalAmount/baseAmount with 2dp and date as YYYY-MM-DD (UTC slice)', () => {
    const line = expensesToCsv([exp()]).split('\n')[1];
    const cells = line.split(',');
    expect(cells[0]).toBe('2023-11-14'); // 1700000000000 UTC
    expect(cells[5]).toBe('10.00');
    expect(cells[6]).toBe('42.50');
    expect(cells[7]).toBe('4.25');
    expect(cells[8]).toBe(''); // no note → empty cell
  });

  it('sorts newest-first (timestamp desc) without mutating the input', () => {
    const older = exp({ id: 'old', timestamp: 1_700_000_000_000 });
    const newer = exp({ id: 'new', timestamp: 1_800_000_000_000 });
    const input = [older, newer];
    const out = expensesToCsv(input);
    const lines = out.split('\n');
    // ids are not in the CSV — assert by date order (newest = later timestamp).
    expect(lines[1]).toBe(expensesToCsv([newer]).split('\n')[1]);
    expect(lines[2]).toBe(expensesToCsv([older]).split('\n')[1]);
    expect(input[0]).toBe(older); // input array not mutated
  });

  it('quotes a merchant containing a comma, double-quote, and newline', () => {
    // NOTE: the CSV row itself is joined with '\n', and a newline inside a
    // quoted note is legitimate RFC-4180 (multi-line field). So we assert on
    // the raw single output string, not on split('\n') cells.
    const out = expensesToCsv([exp({ merchant: `We, "The" Store`, note: 'line1\nline2' })]);
    expect(out).toContain('"We, ""The"" Store"');
    expect(out).toContain('"line1\nline2"');
  });

  it('does NOT quote plain values (no gratuitous quoting)', () => {
    const cell = expensesToCsv([exp({ merchant: 'Shopee', category: 'Groceries' })]).split('\n')[1];
    expect(cell).toBe('2023-11-14,Shopee,Groceries,card,USD,10.00,42.50,4.25,');
  });
});

describe('expensesToCsv — negative / edge', () => {
  it('empty dataset → header only, no trailing blank row', () => {
    expect(expensesToCsv([])).toBe('date,merchant,category,paymentMethod,currency,originalAmount,baseAmount,fxRate,note');
  });

  it('unicode merchant + note pass through unescaped (CSV is UTF-8)', () => {
    const line = expensesToCsv([exp({ merchant: 'Kopitiam ☕', note: 'café' })]).split('\n')[1];
    expect(line).toContain('Kopitiam ☕');
    expect(line).toContain('café');
  });

  it('zero amounts and zero fxRate render as 0.00 / 0, not NaN or empty', () => {
    const line = expensesToCsv([exp({ originalAmount: 0, baseAmount: 0, fxRate: 0 })]).split('\n')[1];
    const cells = line.split(',');
    expect(cells[5]).toBe('0.00');
    expect(cells[6]).toBe('0.00');
    expect(cells[7]).toBe('0');
  });

  it('empty string note is distinct from undefined note (both → empty cell, no quotes)', () => {
    const a = expensesToCsv([exp({ note: '' })]).split('\n')[1];
    const b = expensesToCsv([exp()]).split('\n')[1];
    expect(a).toBe(b);
    expect(a).not.toContain('""');
  });

  it('10k rows → one line per expense, header exactly once', () => {
    const many = Array.from({ length: 10_000 }, (_, i) => exp({ id: `e${i}`, timestamp: 1_700_000_000_000 + i }));
    const out = expensesToCsv(many);
    expect(out.split('\n').length).toBe(10_001);
    expect(out.split('\n')[0]).toBe('date,merchant,category,paymentMethod,currency,originalAmount,baseAmount,fxRate,note');
  });
});

describe('holdingsToCsv — positive', () => {
  it('resolves the account platform name for the holding', () => {
    const line = holdingsToCsv([holding()], [account()]).split('\n')[1];
    const cells = line.split(',');
    expect(cells[2]).toBe('Luno');
    expect(cells[0]).toBe('BTC');
  });

  it('formats units to 4dp and prices to 2dp / 4dp in holdingCurrency', () => {
    const line = holdingsToCsv([holding()], [account()]).split('\n')[1];
    const cells = line.split(',');
    expect(cells[4]).toBe('0.5000');
    expect(cells[5]).toBe('30000.00');
    expect(cells[6]).toBe('41200.1234');
  });
});

describe('holdingsToCsv — negative / edge', () => {
  it('unknown accountId → "unknown" platform, row still emitted', () => {
    const line = holdingsToCsv([holding({ accountId: 'ghost' })], [account()]).split('\n')[1];
    expect(line.split(',')[2]).toBe('unknown');
  });

  it('empty holdings → header only', () => {
    expect(holdingsToCsv([], [account()])).toBe('symbol,assetClass,account,currency,units,averageEntryPrice,currentPriceLocal');
  });

  it('zero-value holding (free spin / 0 units) renders 0s, not NaN', () => {
    const line = holdingsToCsv(
      [holding({ units: 0, averageEntryPrice: 0, currentPriceLocal: 0 })],
      [account()],
    ).split('\n')[1];
    const cells = line.split(',');
    expect(cells[4]).toBe('0.0000');
    expect(cells[5]).toBe('0.00');
    expect(cells[6]).toBe('0.0000');
  });

  it('symbol with comma/quote/newline is quoted (merchant-class escaping reused)', () => {
    const line = holdingsToCsv([holding({ symbol: `F, "X"\nY` })], [account()]).split('\n');
    expect(line.join('\n')).toContain('"F, ""X""\nY"');
  });

  it('platform name containing a comma is quoted; currency is emitted verbatim', () => {
    // The platform name sits in cell 2 and is quoted (comma inside) — the raw
    // row can no longer be naively split on ',', so assert on the row string.
    const row = holdingsToCsv([holding({ holdingCurrency: 'MYR' })], [account({ platformName: 'IBKR, Inc.' })]).split('\n')[1];
    expect(row).toContain('"IBKR, Inc."');
    // currency (cell 3) is unquoted and verbatim: strip the known cells.
    expect(row).toMatch(/^BTC,crypto,"IBKR, Inc\.",MYR,0\.5000,30000\.00,41200\.1234$/);
  });
});
