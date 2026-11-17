// ============================================================================
// OmniFlow — FX daily-anchor cache regression tests.
//
// Verifies that within a UTC trading day the service reuses the same FX
// snapshot (so a broker-priced portfolio value is stable minute-to-minute),
// and that a fresh fetch happens on the first call of the day / a new day.
//
// @vitest-environment happy-dom
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CurrencyExchangeService } from '../src/services/fx';

const ER_BODY = {
  result: 'success',
  base: 'MYR',
  rates: { MYR: 1, USD: 0.24, EUR: 0.22, JPY: 36.0, SGD: 0.32 },
};

function mockErOk(rateUSD: number) {
  const f = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ...ER_BODY, rates: { ...ER_BODY.rates, USD: rateUSD } }),
  }) as unknown as Response);
  vi.stubGlobal('fetch', f);
  return f;
}

describe('CurrencyExchangeService — daily FX anchor', () => {
  let svc: CurrencyExchangeService;
  beforeEach(() => {
    // happy-dom provides sessionStorage; clear it for a clean day.
    sessionStorage.clear();
    svc = new CurrencyExchangeService();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('first call of the day fetches and tags source with a non-daily origin', async () => {
    const f = mockErOk(0.24);
    const r = await svc.latest('MYR');
    expect(r.source).toBe('er-api');
    expect(r.rates.USD).toBe(0.24);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('subsequent calls the same day reuse the snapshot (source=daily, no new fetch)', async () => {
    mockErOk(0.24);
    await svc.latest('MYR');
    const f = mockErOk(0.25); // even if a NEW rate were available...
    const r = await svc.latest('MYR');
    // ...the daily snapshot wins: stable FX within the day, same rate as the
    // first fetch, no second network call.
    expect(r.source).toBe('daily');
    expect(r.rates.USD).toBe(0.24);
    expect(f).not.toHaveBeenCalled();
  });

  it('a different base is anchored independently per currency', async () => {
    mockErOk(0.24);
    await svc.latest('MYR');
    const f = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: 'success', base: 'USD', rates: { USD: 1, MYR: 4.1 } }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', f);
    const r = await svc.latest('USD');
    expect(r.source).toBe('er-api');
    expect(r.rates.MYR).toBe(4.1);
  });

  it('sessionStorage persists the daily snapshot across a service instance (reload)', async () => {
    mockErOk(0.24);
    await svc.latest('MYR');
    // Simulate a page reload: brand-new service, same sessionStorage.
    const svc2 = new CurrencyExchangeService();
    const f = mockErOk(0.26); // new rate, but the day is anchored...
    const r = await svc2.latest('MYR');
    expect(r.source).toBe('daily');
    expect(r.rates.USD).toBe(0.24);
    expect(f).not.toHaveBeenCalled();
  });

  it('a new UTC day anchors a fresh fetch', async () => {
    mockErOk(0.24);
    await svc.latest('MYR');
    // Simulate a new day + a clean session: a FRESH service instance with
    // sessionStorage cleared has no daily anchor, so it must fetch.
    sessionStorage.clear();
    const svc2 = new CurrencyExchangeService();
    const f = mockErOk(0.27);
    const r = await svc2.latest('MYR');
    expect(r.source).toBe('er-api');
    expect(r.rates.USD).toBe(0.27);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
