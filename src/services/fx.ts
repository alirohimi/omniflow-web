// ============================================================================
// OmniFlow — CurrencyExchangeService (free, no-key FX).
//
// Primary source: open.er-api.com/v6  (free, no API key, covers MYR, JPY,
// KRW, VND, IDR, THB — everything Frankfurter/ECB misses).
// Fallback:   api.frankfurter.app      (ECB reference rates, full coverage
// for the ~30 majors; no MYR).
//
// Pure math (convert, invert) is separated from network so it is
// unit-testable. The service keeps the last good rate set in memory so a
// session never hard-breaks mid-offline; nothing is written to local storage.
// ============================================================================

const ER_API = 'https://open.er-api.com/v6/latest/';
const FRANKFURTER = 'https://api.frankfurter.app/latest?from=';
/** Per-fetch wall clock — a hung FX endpoint must never block the KPI panel. */
const FX_TIMEOUT_MS = 10_000;

/**
 * Static last-known approximations (1 unit of BASE = rate units of code).
 * Used ONLY when both live sources fail AND no in-session cache exists, so
 * `latest()` can never throw: a fully offline/first-load session still gets
 * usable approximate numbers (flagged source='offline') instead of a blank
 * KPI panel. These are approximations for display fallback, not quotes.
 */
const OFFLINE_FALLBACK: Record<string, Record<string, number>> = {
  USD: { USD: 1, EUR: 0.92, GBP: 0.79, JPY: 155, MYR: 4.25, SGD: 1.35, AUD: 1.5, CAD: 1.36, HKD: 7.8, CNY: 7.2 },
  EUR: { EUR: 1, USD: 1.09, GBP: 0.86, JPY: 168, MYR: 4.62, SGD: 1.47, AUD: 1.64, CAD: 1.48, HKD: 8.5, CNY: 7.85 },
  GBP: { GBP: 1, USD: 1.27, EUR: 1.17, JPY: 196, MYR: 5.38, SGD: 1.72, AUD: 1.9, CAD: 1.73, HKD: 9.9, CNY: 9.1 },
  JPY: { JPY: 1, USD: 0.0065, EUR: 0.006, GBP: 0.0051, MYR: 0.0274, SGD: 0.0087, AUD: 0.0097, CAD: 0.0088, HKD: 0.0503, CNY: 0.0465 },
  MYR: { MYR: 1, USD: 0.235, EUR: 0.216, GBP: 0.186, JPY: 36.4, SGD: 0.317, AUD: 0.352, CAD: 0.321, HKD: 1.83, CNY: 1.69 },
  SGD: { SGD: 1, USD: 0.74, EUR: 0.68, GBP: 0.58, JPY: 114, MYR: 3.15, AUD: 1.11, CAD: 1.01, HKD: 5.78, CNY: 5.34 },
  AUD: { AUD: 1, USD: 0.66, EUR: 0.61, GBP: 0.53, JPY: 102, MYR: 2.84, SGD: 0.9, CAD: 0.9, HKD: 5.2, CNY: 4.79 },
  CAD: { CAD: 1, USD: 0.74, EUR: 0.68, GBP: 0.58, JPY: 114, MYR: 3.12, SGD: 0.99, AUD: 1.11, HKD: 5.75, CNY: 5.3 },
  HKD: { HKD: 1, USD: 0.128, EUR: 0.118, GBP: 0.101, JPY: 19.8, MYR: 0.546, SGD: 0.173, AUD: 0.192, CAD: 0.174, CNY: 0.924 },
  CNY: { CNY: 1, USD: 0.139, EUR: 0.127, GBP: 0.11, JPY: 21.5, MYR: 0.592, SGD: 0.187, AUD: 0.209, CAD: 0.189, HKD: 1.08 },
};

export interface RatesForBase {
  base: string;
  /** units of `code` per 1 unit of base. rates[code] = 1 base = rates[code] code. */
  rates: Record<string, number>;
  asOf: number;
  source: 'er-api' | 'frankfurter' | 'cache' | 'offline';
}

/** Pure: convert `amount` in `from` to `to` using units-of-`to`-per-1-`from`. */
export function convert(
  amount: number,
  from: string,
  to: string,
  ratesPer1From: Record<string, number>,
): number {
  if (from === to) return amount;
  const r = ratesPer1From[to];
  if (r === undefined || !isFinite(r)) return NaN;
  return amount * r;
}

/** Pure: invert a base-rate table so it expresses 1 unit of `newBase`. */
export function retargetToBase(
  baseRates: Record<string, number>,
  newBase: string,
): Record<string, number> {
  // baseRates[x] = units of x per 1 oldBase.
  // We want units of x per 1 newBase = baseRates[x] / baseRates[newBase].
  const newBaseInOld = baseRates[newBase] ?? 1;
  const out: Record<string, number> = { [newBase]: 1 };
  for (const [code, unitsPer1Old] of Object.entries(baseRates)) {
    out[code] = unitsPer1Old / newBaseInOld;
  }
  return out;
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchER(base: string): Promise<RatesForBase> {
  const res = await fetchWithTimeout(ER_API + base.toUpperCase(), FX_TIMEOUT_MS);
  if (!res.ok) throw new Error(`er-api ${res.status}`);
  const j = await res.json();
  if (!j || j.result !== 'success' || !j.rates) throw new Error('er-api bad shape');
  return {
    base: j.base,
    rates: j.rates, // units of each currency per 1 base
    asOf: Date.now(),
    source: 'er-api',
  };
}

async function fetchFrankfurter(base: string): Promise<RatesForBase> {
  const res = await fetchWithTimeout(`${FRANKFURTER}${base.toUpperCase()}`, FX_TIMEOUT_MS);
  if (!res.ok) throw new Error(`frankfurter ${res.status}`);
  const j = await res.json();
  if (!j || !j.rates) throw new Error('frankfurter bad shape');
  return { base: j.base, rates: j.rates, asOf: Date.now(), source: 'frankfurter' };
}

export class CurrencyExchangeService {
  private cache: RatesForBase | null = null;

  private remember(r: RatesForBase) {
    this.cache = r; // session-only: never written to local storage
  }

  /** Fetch freshest rates for `base`, trying er-api then frankfurter.
   *  Falls back to the in-session rate set (flagged source='cache') if the
   *  network fails, so a session never hard-breaks offline.
   *  NEVER throws: as a last resort it returns the static OFFLINE_FALLBACK
   *  approximations (source='offline') so KPI panels always render. The
   *  UI shows the source so users know when rates are approximate. */
  async latest(base: string): Promise<RatesForBase> {
    const errors: string[] = [];
    for (const fn of [() => fetchER(base), () => fetchFrankfurter(base)]) {
      try {
        const r = await fn();
        this.remember(r);
        return r;
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (this.cache && this.cache.base === base) {
      return { ...this.cache, source: 'cache' };
    }
    // Last resort: static approximations so the app never hard-breaks with
    // zero network. `toBase`/`convert` will still return NaN for pairs the
    // table doesn't cover — the aggregator is NaN-proof and shows '—'.
    const b = base.toUpperCase();
    const known = OFFLINE_FALLBACK[b];
    // Unknown base: minimal table (only self = 1). Same-currency holdings
    // still value correctly; foreign ones show '—' rather than silently
    // WRONG numbers.
    const rates: Record<string, number> = known ? { ...known } : { [b]: 1 };
    return { base: b, rates, asOf: Date.now(), source: 'offline' };
  }

  /** Convert `amount` in `fromCurrency` to `toCurrency`. `rates` is a
   *  per-1-base table (rates[code] = units of `code` per 1 base), so units
   *  of `to` per 1 `from` = rates[to] / rates[from]. */
  convert(amount: number, from: string, to: string, rates: RatesForBase): number {
    if (from === to) return amount;
    const f = rates.rates[from];
    const t = rates.rates[to];
    if (f === undefined || t === undefined || !isFinite(f) || !isFinite(t) || f === 0) return NaN;
    return amount * (t / f);
  }

  /** Convenience: convert `amount` in `fromCurrency` to the base currency.
   *  units of base per 1 `from` = 1 / rates[from]. */
  toBase(amount: number, from: string, rates: RatesForBase): number {
    if (from === rates.base) return amount;
    const f = rates.rates[from];
    if (f === undefined || !isFinite(f) || f === 0) return NaN;
    return amount / f;
  }

  /** Rate of `from` in `to`, i.e. units of `to` per 1 `from` = rates[to] / rates[from]. */
  rate(from: string, to: string, rates: RatesForBase): number {
    if (from === to) return 1;
    const f = rates.rates[from];
    const t = rates.rates[to];
    if (f === undefined || t === undefined || f === 0) return NaN;
    return t / f;
  }
}

export const fxService = new CurrencyExchangeService();

export const __test = { convert, retargetToBase, fetchER, fetchFrankfurter };
