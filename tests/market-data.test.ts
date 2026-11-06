// ============================================================================
// OmniFlow — MarketDataService tests (Task 009 P1 #4: marketData was untested).
// The service NEVER throws from quote()/batch() — live-fetch failure degrades
// to the stored price with a note, so a flaky network or junk symbol can not
// inject NaN into the P&L. We mock global fetch to exercise the coingecko /
// yahoo / fallback / cash paths deterministically (no network in CI).
// ============================================================================

import { describe, it, expect, vi, afterEach } from 'vitest';
import { MarketDataService } from '../src/services/marketData';
import { CurrencyExchangeService } from '../src/services/fx';
import type { InvestmentHolding } from '../src/domain/types';

const svc = new MarketDataService(new CurrencyExchangeService());

function h(over: Partial<InvestmentHolding> = {}): InvestmentHolding {
  return {
    id: 'h1',
    accountId: 'a1',
    symbol: 'BTC',
    assetClass: 'crypto',
    holdingCurrency: 'USD',
    units: 1,
    averageEntryPrice: 30_000,
    currentPriceLocal: 40_000,
    currentPriceBase: 0,
    ...over,
  };
}

function mockFetchJson(body: unknown, ok = true, status = 200): ReturnType<typeof vi.fn> {
  const f = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  } as unknown as Response);
  vi.stubGlobal('fetch', f);
  return f;
}

function mockFetchFail(): ReturnType<typeof vi.fn> {
  const f = vi.fn().mockRejectedValue(new TypeError('network down'));
  vi.stubGlobal('fetch', f);
  return f;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MarketDataService.quote — cash / mmf (no network)', () => {
  it('prices cash/mmf at par with the holding currency, no fetch called', async () => {
    const f = mockFetchJson({});
    const r = await svc.quote(h({ assetClass: 'cash', symbol: 'CASH', holdingCurrency: 'MYR' }));
    expect(r.ok).toBe(true);
    expect(r.price).toBe(1);
    expect(r.currency).toBe('MYR');
    expect(r.source).toBe('manual');
    expect(f).not.toHaveBeenCalled();
  });
});

describe('MarketDataService.quote — crypto (coingecko)', () => {
  it('returns live USD price with 24h change note on a good response', async () => {
    const f = mockFetchJson({ bitcoin: { usd: 65_000, usd_24h_change: 1.5 } });
    const r = await svc.quote(h());
    expect(r.ok).toBe(true);
    expect(r.price).toBe(65_000);
    expect(r.currency).toBe('USD');
    expect(r.source).toBe('coingecko');
    expect(r.note).toBe('24h change 1.5%');
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0][0])).toContain('ids=bitcoin');
  });

  it('maps known symbols through COINGECKO_COIN_MAP (ETH → ethereum)', async () => {
    const f = mockFetchJson({ ethereum: { usd: 3_000 } });
    await svc.quote(h({ symbol: 'ETH' }));
    expect(String(f.mock.calls[0][0])).toContain('ids=ethereum');
  });

  it('unknown symbol falls through to a plain-lowercase lookup', async () => {
    const f = mockFetchJson({ dogecoin: { usd: 0.12 } });
    await svc.quote(h({ symbol: 'DOGE' }));
    expect(String(f.mock.calls[0][0])).toContain('ids=dogecoin');
  });

  it('malformed coingecko body (no usd price) → falls back to stored price', async () => {
    mockFetchJson({ bitcoin: {} });
    const r = await svc.quote(h());
    expect(r.ok).toBe(true);
    expect(r.price).toBe(40_000); // stored currentPriceLocal
    expect(r.source).toBe('cache');
    expect(r.note).toContain('live fetch failed');
  });

  it('non-2xx coingecko → falls back to stored price, no throw', async () => {
    mockFetchJson({}, false, 429);
    const r = await svc.quote(h());
    expect(r.ok).toBe(true);
    expect(r.price).toBe(40_000);
    expect(r.source).toBe('cache');
    expect(r.note).toContain('coingecko 429');
  });

  it('network failure → falls back to stored price, ok stays true', async () => {
    mockFetchFail();
    const r = await svc.quote(h());
    expect(r.ok).toBe(true);
    expect(r.price).toBe(40_000);
    expect(r.source).toBe('cache');
    expect(r.note).toContain('network down');
  });
});

describe('MarketDataService.quote — equity (yahoo)', () => {
  function yahooBody(price: number, currency = 'USD', ts = 1_700_000_000) {
    return { chart: { result: [{ meta: { regularMarketPrice: price, currency, regularMarketTime: ts } }] } };
  }

  it('returns live price + currency + epoch-ms asOf on a good response', async () => {
    mockFetchJson(yahooBody(185.2, 'USD', 1_700_000_000));
    const r = await svc.quote(h({ assetClass: 'equity-us', symbol: 'AAPL' }));
    expect(r.ok).toBe(true);
    expect(r.price).toBe(185.2);
    expect(r.currency).toBe('USD');
    expect(r.source).toBe('yahoo');
    expect(r.asOf).toBe(1_700_000_000_000);
  });

  it('yahoo meta without a currency falls back to the holding currency', async () => {
    mockFetchJson(yahooBody(12, ''));
    const r = await svc.quote(h({ assetClass: 'equity-local', symbol: '1155.KL', holdingCurrency: 'MYR' }));
    expect(r.currency).toBe('MYR');
  });

  it('missing regularMarketPrice → falls back to stored price', async () => {
    mockFetchJson({ chart: { result: [{ meta: {} }] } });
    const r = await svc.quote(h({ assetClass: 'equity-us', symbol: 'AAPL' }));
    expect(r.price).toBe(40_000);
    expect(r.source).toBe('cache');
    expect(r.note).toContain('no regularMarketPrice');
  });

  it('yahoo 5xx → falls back to stored price, no throw', async () => {
    mockFetchJson({}, false, 502);
    const r = await svc.quote(h({ assetClass: 'etf', symbol: 'VOO' }));
    expect(r.ok).toBe(true);
    expect(r.price).toBe(40_000);
    expect(r.note).toContain('yahoo 502');
  });
});

describe('MarketDataService.batch — parallel + degradation', () => {
  it('dedupes duplicate symbols: 3 holdings of BTC → 1 coingecko fetch', async () => {
    const f = mockFetchJson({ bitcoin: { usd: 60_000 } });
    const out = await svc.batch([h(), h(), h({ id: 'h2', currentPriceLocal: 59_000 })]);
    expect(Object.keys(out)).toEqual(['BTC']);
    expect(out.BTC.price).toBe(60_000);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('a failing symbol never stalls the others (allSettled + per-request fallback)', async () => {
    let calls = 0;
    const f = vi.fn(async (url: string) => {
      calls += 1;
      if (String(url).includes('bitcoin')) {
        throw new TypeError('coingecko down');
      }
      return { ok: true, status: 200, json: async () => ({ ethereum: { usd: 3_000 } }) } as Response;
    });
    vi.stubGlobal('fetch', f);
    const out = await svc.batch([
      h({ symbol: 'BTC' }),
      h({ symbol: 'ETH', assetClass: 'crypto' }),
    ]);
    expect(out.BTC.price).toBe(40_000); // stored
    expect(out.BTC.source).toBe('cache');
    expect(out.BTC.note).toContain('live fetch failed');
    expect(out.ETH.price).toBe(3_000); // live
    expect(out.ETH.source).toBe('coingecko');
    expect(calls).toBe(2);
  });

  it('empty holdings → empty snapshot map, zero fetches', async () => {
    const f = mockFetchJson({});
    const out = await svc.batch([]);
    expect(out).toEqual({});
    expect(f).not.toHaveBeenCalled();
  });
});
