// ============================================================================
// OmniFlow — CurrencyExchangeService (free, no-key FX).
//
// Primary source: open.er-api.com/v6  (free, no API key, covers MYR, JPY,
// KRW, VND, IDR, THB — everything Frankfurter/ECB misses).
// Fallback:   api.frankfurter.app      (ECB reference rates, full coverage
// for the ~30 majors; no MYR).
//
// Pure math (convert, invert) is separated from network so it is
// unit-testable. The service caches the last good rate set so the app keeps
// working offline with the most recent rates.
// ============================================================================

const ER_API = 'https://open.er-api.com/v6/latest/';
const FRANKFURTER = 'https://api.frankfurter.app/latest?from=';

export interface RatesForBase {
  base: string;
  /** units of `code` per 1 unit of base. rates[code] = 1 base = rates[code] code. */
  rates: Record<string, number>;
  asOf: number;
  source: 'er-api' | 'frankfurter' | 'cache';
}

const CACHE_KEY = 'omniflow-fx-rates';

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

async function fetchER(base: string): Promise<RatesForBase> {
  const res = await fetch(ER_API + base.toUpperCase());
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
  const res = await fetch(`${FRANKFURTER}${base.toUpperCase()}`);
  if (!res.ok) throw new Error(`frankfurter ${res.status}`);
  const j = await res.json();
  if (!j || !j.rates) throw new Error('frankfurter bad shape');
  return { base: j.base, rates: j.rates, asOf: Date.now(), source: 'frankfurter' };
}

export class CurrencyExchangeService {
  private cache: RatesForBase | null = null;

  constructor() {
    this.restoreCache();
  }

  private restoreCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) this.cache = JSON.parse(raw);
    } catch {
      this.cache = null;
    }
  }

  private persist(r: RatesForBase) {
    this.cache = r;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(r));
    } catch {
      /* storage full/blocked — non-fatal */
    }
  }

  /** Fetch freshest rates for `base`, trying er-api then frankfurter.
   *  Falls back to cached rates (flagged source='cache') if the network
   *  fails entirely, so the app never hard-breaks offline. */
  async latest(base: string): Promise<RatesForBase> {
    const errors: string[] = [];
    for (const fn of [() => fetchER(base), () => fetchFrankfurter(base)]) {
      try {
        const r = await fn();
        this.persist(r);
        return r;
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (this.cache && this.cache.base === base) {
      return { ...this.cache, source: 'cache' };
    }
    throw new Error(`FX unavailable: ${errors.join('; ')}`);
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

export const __test = { convert, retargetToBase, CACHE_KEY, fetchER, fetchFrankfurter };
