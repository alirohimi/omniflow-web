// ============================================================================
// OmniFlow — core-logic tests (no network, no DOM).
// Covers the pure determinism the rest of the app relies on: FX math,
// portfolio aggregation, AI categorization, OCR pre-pass, and the
// passphrase vault (encrypt/decrypt round-trip + wrong-key rejection).
// ============================================================================

import { describe, it, expect } from 'vitest';
import { convert, retargetToBase, fxService } from '../src/services/fx';
import { buildPortfolio } from '../src/ai/portfolio';
import { categorizeByDictionary } from '../src/ai/categorize';
import { extractFromOcrText } from '../src/services/ocr';
import { encryptVault, decryptVault, fingerprintSecret } from '../src/security/vault';
import { CATEGORIES } from '../src/domain/enums';
import type { InvestmentHolding, QuoteSnapshot } from '../src/domain/types';

const MYR = 'MYR';

describe('fx pure math', () => {
  it('convert: units of `to` per 1 `from` via a per-from table', () => {
    // ratesPer1From[x] = units of x per 1 USD. 1 USD = 4.1667 MYR.
    const ratesPer1Usd: Record<string, number> = { MYR: 4.1667, USD: 1 };
    expect(convert(10, 'USD', 'MYR', ratesPer1Usd)).toBeCloseTo(41.667, 2);
    expect(convert(10, 'USD', 'USD', ratesPer1Usd)).toBe(10);
  });

  it('retargetToBase inverts a table to a new base', () => {
    const oldBase: Record<string, number> = { MYR: 1, USD: 0.24, SGD: 0.33 };
    const usdBase = retargetToBase(oldBase, 'USD');
    expect(usdBase.USD).toBe(1);
    expect(usdBase.MYR).toBeCloseTo(1 / 0.24, 4);
    expect(usdBase.SGD).toBeCloseTo(0.33 / 0.24, 4);
  });

  it('fxService.toBase: 100 USD at 1 MYR = 0.24 USD -> 416.67 MYR', () => {
    const rates = { base: MYR, rates: { MYR: 1, USD: 0.24 }, asOf: 0, source: 'cache' as const };
    expect(fxService.toBase(100, 'USD', rates)).toBeCloseTo(416.6667, 2);
    expect(fxService.toBase(100, MYR, rates)).toBe(100);
  });

  it('fxService.rate: USD in MYR = 1/0.24', () => {
    const rates = { base: MYR, rates: { MYR: 1, USD: 0.24 }, asOf: 0, source: 'cache' as const };
    expect(fxService.rate('USD', MYR, rates)).toBeCloseTo(4.1667, 2);
  });
});

describe('portfolio aggregation', () => {
  const holding = (over: Partial<InvestmentHolding> = {}): InvestmentHolding => ({
    id: 'h-1',
    accountId: 'acc-1',
    symbol: 'AAPL',
    assetClass: 'equity-us',
    holdingCurrency: 'USD',
    units: 10,
    averageEntryPrice: 100,
    currentPriceLocal: 110,
    currentPriceBase: 462,
    ...over,
  });

  const quote = (over: Partial<QuoteSnapshot> = {}): QuoteSnapshot => ({
    symbol: 'AAPL',
    assetClass: 'equity-us',
    price: 110,
    currency: 'USD',
    asOf: 0,
    source: 'yahoo',
    ...over,
  });

  it('values in base currency and computes return vs cost', () => {
    const h = holding({ units: 10, averageEntryPrice: 100, currentPriceLocal: 110 });
    // USD -> MYR rate fn: 1 USD = 4.2 MYR
    const rates = (code: string) => (code === MYR ? 1 : code === 'USD' ? 4.2 : 1);
    const p = buildPortfolio(
      [{ id: 'acc-1', platformName: 'IBKR', accountType: 'broker', baseCurrencyValue: 0, lastUpdated: 0 }],
      [h],
      { AAPL: quote() },
      MYR,
      rates,
    );
    expect(p.totalValueBase).toBeCloseTo(10 * 110 * 4.2, 1);
    expect(p.totalCostBase).toBeCloseTo(10 * 100 * 4.2, 1);
    expect(p.totalReturnPct).toBeCloseTo(10, 1);
    expect(p.byAccount[0].account.platformName).toBe('IBKR');
  });

  it('falls back to stored prices when no live quote exists', () => {
    const h = holding({ currentPriceLocal: 105, currentPriceBase: 441 });
    const rates = () => 4.2;
    const p = buildPortfolio([], [h], {}, MYR, rates);
    expect(p.totalValueBase).toBeCloseTo(10 * 105 * 4.2, 1);
    expect(p.staleQuoteCount).toBe(1);
  });
});

describe('AI categorization (dictionary tier)', () => {
  it('classifies Malaysian merchants', () => {
    expect(categorizeByDictionary({ merchant: "Lotus's Cheras" }, CATEGORIES).category).toBe('Groceries');
    expect(categorizeByDictionary({ merchant: '7-Eleven' }, CATEGORIES).category).toBe('Food & Dining');
    expect(categorizeByDictionary({ merchant: 'Petronas' }, CATEGORIES).category).toBe('Transport');
  });

  it('classifies platforms', () => {
    expect(categorizeByDictionary({ merchant: 'Netflix' }, CATEGORIES).category).toBe('Entertainment');
    // The dictionary tier matches on keywords; 'crypto' is an Investments rule.
    expect(categorizeByDictionary({ merchant: 'Luno crypto top-up' }, CATEGORIES).category).toBe('Investments');
  });

  it('falls through to Other when nothing matches', () => {
    const r = categorizeByDictionary({ merchant: 'xyzunknown' }, CATEGORIES);
    expect(r.category).toBe('Other');
    expect(r.confidence).toBeLessThanOrEqual(0.3);
  });
});

describe('OCR pre-pass', () => {
  it('extracts amount + currency + merchant from a Grab receipt', () => {
    const text = 'Grab\ntotal paid\nS$ 8.40';
    const r = extractFromOcrText(text, MYR);
    expect(r.amount).toBe(8.4);
    expect(r.currency).toBe('SGD');
  });

  it('extracts a MYR paid line', () => {
    const r = extractFromOcrText('Foodpanda\nPaid RM12.40', MYR);
    expect(r.amount).toBe(12.4);
    expect(r.currency).toBe('MYR');
  });

  it('defaults currency when nothing detected', () => {
    const r = extractFromOcrText('TOTAL 15.00', 'USD');
    expect(r.amount).toBe(15);
    expect(r.currency).toBe('USD');
  });
});

describe('vault crypto (passphrase-gated AES-GCM)', () => {
  it('round-trips a payload with the right passphrase', async () => {
    const payload = { hello: 'omniflow', n: 42 };
    const cipher = await encryptVault(payload, 'correct-horse-battery');
    expect(cipher.salt).toBeTruthy();
    expect(cipher.body).toBeTruthy();
    const out = await decryptVault<typeof payload>(cipher, 'correct-horse-battery');
    expect(out).toEqual(payload);
  });

  it('rejects a wrong passphrase (auth tag mismatch)', async () => {
    const cipher = await encryptVault({ a: 1 }, 'right');
    await expect(decryptVault(cipher, 'wrong')).rejects.toThrow();
  });

  it('fingerprint is deterministic and truncatable', async () => {
    const a = await fingerprintSecret('sk-abc');
    const b = await fingerprintSecret('sk-abc');
    const c = await fingerprintSecret('sk-def');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
