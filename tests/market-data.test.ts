// ============================================================================
// OmniFlow — MarketDataService tests (Task 009 P1 #4: marketData was untested).
// The service NEVER throws from quote()/batch() — live-fetch failure degrades
// to the stored price with a note, so a flaky network or junk symbol can not
// inject NaN into the P&L. We mock global fetch to exercise the coingecko /
// yahoo / fallback / cash paths deterministically (no network in CI).
// ============================================================================

import { describe, it, expect, vi, afterEach } from 'vitest';
import { MarketDataService, baseCoin, plausiblePrice } from '../src/services/marketData';
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

  it('baseCoin strips a currency suffix to the underlying coin', () => {
    expect(baseCoin('BTCMYR')).toBe('BTC');
    expect(baseCoin('ETHMYR')).toBe('ETH');
    expect(baseCoin('SOLUSD')).toBe('SOL');
    // No suffix → unchanged (upper-cased).
    expect(baseCoin('BTC')).toBe('BTC');
    expect(baseCoin('doge')).toBe('DOGE');
  });

  it('a MYR-denominated BTC (BTCMYR, HATA) resolves to the real bitcoin id, not junk', async () => {
    const f = mockFetchJson({ bitcoin: { myr: 266_634, usd: 64_708 } });
    const r = await svc.quote(h({ symbol: 'BTCMYR', holdingCurrency: 'MYR' }));
    // The URL must target `bitcoin`, NOT the literal `btcmyr` (which 404s).
    expect(String(f.mock.calls[0][0])).toContain('ids=bitcoin');
    expect(String(f.mock.calls[0][0])).not.toContain('btcmyr');
    expect(r.ok).toBe(true);
    expect(r.price).toBe(266_634); // the MYR price, priced in the holding currency
    expect(r.currency).toBe('MYR');
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

  it('a MYR-denominated crypto holding is priced directly in MYR (btcmyr)', async () => {
    const f = mockFetchJson({ bitcoin: { myr: 307_481.2, usd: 75_706, usd_24h_change: -0.8 } });
    const r = await svc.quote(h({ holdingCurrency: 'MYR' }));
    expect(r.ok).toBe(true);
    expect(r.price).toBe(307_481.2);
    expect(r.currency).toBe('MYR');
    expect(r.source).toBe('coingecko');
    // The request asks for MYR (+USD fallback) in the same call.
    expect(String(f.mock.calls[0][0])).toContain('vs_currencies=myr%2Cusd');
  });

  it('a USD crypto holding still prices in USD (no MYR lookup)', async () => {
    const f = mockFetchJson({ bitcoin: { usd: 75_706, usd_24h_change: 0.2 } });
    const r = await svc.quote(h({ holdingCurrency: 'USD' }));
    expect(r.price).toBe(75_706);
    expect(r.currency).toBe('USD');
    expect(String(f.mock.calls[0][0])).toContain('vs_currencies=usd');
    expect(String(f.mock.calls[0][0])).not.toContain('myr');
  });

  it('MYR price missing → falls back to the USD figure from the same cell', async () => {
    const f = mockFetchJson({ bitcoin: { usd: 75_706 } });
    const r = await svc.quote(h({ holdingCurrency: 'MYR' }));
    expect(r.price).toBe(75_706);
    expect(r.currency).toBe('USD'); // held USD, will be FX-converted to MYR
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

  it('a StashAway CSPX sleeve fetches the S&P 500 index when the quote is plausible vs stored', async () => {
    // Stored price 5,000; fetched index 5,600 → ratio 1.12 (within 3x) → keep.
    const f = mockFetchJson(yahooBody(5_600, 'USD'));
    const r = await svc.quote(
      h({ assetClass: 'etf', symbol: 'CSPX', holdingCurrency: 'USD', currentPriceLocal: 5_000, averageEntryPrice: 5_000 }),
    );
    expect(r.ok).toBe(true);
    expect(r.price).toBe(5_600);
    expect(r.symbol).toBe('CSPX');
    expect(String(f.mock.calls[0][0])).toContain('%5EGSPC');
    expect(r.note).toContain('tracked ^GSPC index');
  });

  it('a StashAway CSPX sleeve REJECTS an implausible index level vs a per-unit fund price', async () => {
    // The "messy calculation" bug: ^GSPC index ~5,600 vs a fund unit ~840.
    // Ratio 6.6 > MAX_PRICE_RATIO(3) → reject the index, use the stored price.
    mockFetchJson(yahooBody(5_600, 'USD'));
    const r = await svc.quote(
      h({ assetClass: 'etf', symbol: 'CSPX', holdingCurrency: 'USD', currentPriceLocal: 840, averageEntryPrice: 840 }),
    );
    expect(r.ok).toBe(true);
    expect(r.price).toBe(840); // stored, NOT the 5,600 index
    expect(r.source).toBe('cache');
    expect(r.note).toContain('implausible');
  });

  it('a StashAway GLDM gold sleeve REJECTS a futures level that overstates the fund unit', async () => {
    // GC=F ~4,074 vs a gold fund unit ~83 → ratio ~49 → reject, use stored.
    mockFetchJson(yahooBody(4_074.9, 'USD'));
    const r = await svc.quote(
      h({ assetClass: 'gold', symbol: 'GLDM', holdingCurrency: 'USD', currentPriceLocal: 83, averageEntryPrice: 81.72 }),
    );
    expect(r.ok).toBe(true);
    expect(r.price).toBe(83); // stored, not the futures level
    expect(r.note).toContain('implausible');
  });

  it('a StashAway GLDM gold sleeve accepts a plausible quote', async () => {
    mockFetchJson(yahooBody(4_074.9, 'USD'));
    const r = await svc.quote(
      h({ assetClass: 'gold', symbol: 'GLDM', holdingCurrency: 'USD', currentPriceLocal: 3_900, averageEntryPrice: 3_900 }),
    );
    expect(r.price).toBe(4_074.9); // ratio 1.05 → kept
  });
});

describe('MarketDataService.quote — money-market funds valued at par', () => {
  it.each(['ABMINCT', 'PRIMMAM', 'BB3M'])(
    '%s (entered as etf) is valued at par, no Yahoo fetch',
    async (sym) => {
      const f = mockFetchJson({});
      const r = await svc.quote(h({ assetClass: 'etf', symbol: sym, holdingCurrency: 'MYR', currentPriceLocal: 1, averageEntryPrice: 0.96 }));
      expect(r.ok).toBe(true);
      expect(r.price).toBe(1);
      expect(r.currency).toBe('MYR');
      expect(r.source).toBe('manual');
      expect(r.note).toContain('par');
      expect(f).not.toHaveBeenCalled();
    },
  );
});

describe('plausiblePrice — magnitude guard', () => {
  it('accepts a quote within 3x of the stored price', () => {
    expect(plausiblePrice(840, 800)).toBe(true);
    expect(plausiblePrice(800, 1_000)).toBe(true);
    expect(plausiblePrice(1_000, 300)).toBe(false); // 3.3x
    expect(plausiblePrice(300, 1_000)).toBe(false); // 0.3x
  });
  it('accepts anything when there is no stored reference', () => {
    expect(plausiblePrice(5_000, 0)).toBe(true);
    expect(plausiblePrice(5_000, NaN)).toBe(true);
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
