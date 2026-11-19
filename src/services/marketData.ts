// ============================================================================
// OmniFlow — MarketDataService (free, no-key market data).
//
//   Crypto  -> CoinGecko /coins (free tier, CORS-enabled, no key needed).
//   Equities/ETFs -> Yahoo Finance v7/v8 quote endpoint. Yahoo does NOT send
//     CORS headers on browser fetch, so it is best-effort: when the fetch
//     fails, the app falls back to the user's last-stored/manual price.
//     (The PWA can only hit Yahoo from a backend; we keep the manual
//     fallback so crypto + manual entries always work.)
//   Cash/MMF -> no external data; value is units (1.0) in their currency.
//
// The service is a thin wrapper returning a unified QuoteSnapshot, so the UI
// and the portfolio aggregator don't care where a price came from.
// ============================================================================

import type { AssetClass, InvestmentHolding, QuoteSnapshot } from '../domain/types';
import { CurrencyExchangeService } from './fx';

const COINGECKO_COIN_MAP: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  USDT: 'tether',
  USDC: 'usd-coin',
  SOL: 'solana',
  BNB: 'binancecoin',
  XRP: 'ripple',
  ADA: 'cardano',
  DOGE: 'dogecoin',
};

/** StashAway model-portfolio instrument -> underlying index that the ETF
 *  actually tracks. StashAway prices each model sleeve off these broad
 *  index levels (daily, ~once a day), so the app's live quote must
 *  reference the SAME index — not a US-listed spot proxy that trades in a
 *  different currency on different hours. Values fetched here feed the
 *  crypto/ETF quote path; the PWA polls them on the same 60s cadence.
 *
 *  NOTE: These are INDEX/FUTURES reference levels, NOT per-unit ETF prices.
 *  A StashAway CSPX fund unit is ~USD 840 (iShares Core S&P500 UCITS), but
 *  ^GSPC is ~5,900 INDEX POINTS; a GLDM fund unit is ~USD 83 but GC=F is
 *  ~2,650 USD/oz. Using the index level as the per-unit ETF price overstates
 *  the value by 7–32x (the "messy calculation" bug). quote() guards against
 *  this with a magnitude-vs-stored-price sanity check (see MAX_PRICE_RATIO)
 *  and falls back to the stored per-unit price when the fetched quote is
 *  implausible relative to the user's recorded entry price. */
const STASHAWAY_INDEX_MAP: Record<string, string> = {
  CSPX:  '^GSPC', // S&P 500 (Developed Market / US sleeve)
  GLDM:  'GC=F',  // Gold (commodity sleeve)
  GLD:   'GC=F',  // user may type either gold ticker
};

/** StashAway money-market / short-T-bill funds that hold at par (or near-par
 *  accrued). They are entered as `assetClass:'etf'` by the import helper but
 *  are NOT tradable ETFs with a market price — fetching them from Yahoo
 *  fails and the stale seed price (1.00 / 1.08 / 119.78) drives a fake P&L.
 *  These symbols are valued at PAR (the unit IS the value), exactly like a
 *  cash holding, so their P&L is honest (~0%, no seed-driven swing). */
const PAR_FUNDS: ReadonlySet<string> = new Set([
  'ABMINCT', // AmInvest Money Market / StashAway MY cash
  'PRIMMAM', // PIMCO MMF / StashAway MY cash
  'BB3M',    // 3-month US T-bill sleeve (StashAway USD cash yield)
]);

/**
 * Live-quote sanity gate. A UCITS/ETF fund unit price is close to its
 * index level ONLY when the fund happens to be priced per index point
 * (rare). More often the fund price and the index differ by an order of
 * magnitude (S&P500 index ~5,900 vs ETF ~840). When the fetched quote is
 * more than this ratio above or below the user's stored per-unit entry
 * price, the quote is almost certainly a reference index/commodity level
 * rather than a tradable fund unit — so we reject it and use the stored
 * price instead. This prevents a 7–32x overstatement of portfolio value.
 */
const MAX_PRICE_RATIO = 3;

/** True when `quote` is a plausible per-unit price for a holding whose
 *  recorded entry price is `stored`. A quote with no stored reference (or
 *  a zero/NaN stored price) always passes — we have nothing to compare. */
function plausiblePrice(quote: number, stored: number): boolean {
  if (!Number.isFinite(stored) || stored <= 0) return true;
  if (!Number.isFinite(quote) || quote <= 0) return false;
  const ratio = quote / stored;
  return ratio >= 1 / MAX_PRICE_RATIO && ratio <= MAX_PRICE_RATIO;
}

/** Per-fetch wall clock. A junk symbol (or a flaky network) must never be
 *  allowed to hang the whole batch: after this many ms the request aborts
 *  and we fall back to the stored price. */
const FETCH_TIMEOUT_MS = 12_000;

/** Strip a trailing ISO-currency code from a crypto symbol to recover the
 *  underlying coin. HATA (and other MYR exchanges) name their products
 *  "<COIN><CURRENCY>" — e.g. `BTCMYR`, `ETHMYR`, `SOLUSD` — which is NOT a
 *  valid CoinGecko id. Without this the crypto quote path fetched the
 *  literal junk id (`btcmyr`) and got no price, so the holding silently fell
 *  back to its stale stored price and diverged from the real coin. This maps
 *  the FX-suffixed form back to the base coin so the live quote tracks the
 *  real asset (and prices it in the holding's currency directly). Returns
 *  the input unchanged when it has no recognised currency suffix. */
const CURRENCY_SUFFIX = /(MYR|USD|EUR|SGD|JPY|GBP|CNY|HKD|IDR|AUD|CAD)\b$/;
function baseCoin(symbol: string): string {
  const up = symbol.toUpperCase();
  const m = up.match(CURRENCY_SUFFIX);
  if (m) {
    const base = up.slice(0, m.index);
    if (base.length >= 1) return base;
  }
  return up;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error(`timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export type QuoteSource = 'coingecko' | 'yahoo' | 'manual' | 'cache' | 'failed';

export interface QuoteResult {
  ok: boolean;
  symbol: string;
  assetClass: AssetClass;
  price: number;
  currency: string;
  source: QuoteSource;
  asOf: number;
  note?: string;
}

export class MarketDataService {
  constructor(private readonly fx: CurrencyExchangeService) {}

  /** Resolve the "best effort" price for a holding.
   *  - crypto: live CoinGecko in the holding's OWN currency when the FX
   *    table covers it directly (e.g. a MYR-denominated BTC -> MYR,
   *    1 decimal, exactly what the Malaysian exchanges show); otherwise
   *    USD + FX conversion. On failure, holding.currentPriceLocal.
   *  - equity/etf: Yahoo (attempted). On failure, holding.currentPriceLocal.
   *  - cash/mmf: price = 1 (the unit IS the value), currency = holding's.
   */
  async quote(h: InvestmentHolding): Promise<QuoteResult> {
    const fallback = (): QuoteResult => ({
      ok: true,
      symbol: h.symbol,
      assetClass: h.assetClass,
      price: h.currentPriceLocal || 0,
      currency: h.holdingCurrency,
      source: 'cache',
      asOf: Date.now(),
      note: 'using last stored / manual price',
    });

    try {
      switch (h.assetClass) {
        case 'crypto':
          return await this.cryptoQuote(h.symbol, h.holdingCurrency);
        case 'equity-us':
        case 'equity-local':
        case 'etf':
          // StashAway money-market / T-bill funds hold at par — value them
          // like cash (unit = value) instead of fetching a non-tradable
          // ticker from Yahoo, which would fall back to a stale seed price.
          if (PAR_FUNDS.has(h.symbol.toUpperCase())) {
            return {
              ok: true,
              symbol: h.symbol,
              assetClass: h.assetClass,
              price: 1,
              currency: h.holdingCurrency,
              source: 'manual',
              asOf: Date.now(),
              note: 'money-market fund valued at par',
            };
          }
          // StashAway model sleeves (CSPX, GLDM, …) price off the BROAD
          // INDEX their UCITS fund tracks — the same reference the fund's
          // daily NAV uses. Fetch THAT index so our live quote tracks the
          // same thing (minimal drift = fund fee + FX only, no instrument
          // mismatch). Unknown symbols fall through to the raw ticker.
          {
            const idx = STASHAWAY_INDEX_MAP[h.symbol.toUpperCase()] ?? h.symbol;
            const yq = await this.yahooQuote(idx, h.holdingCurrency, h.symbol);
            // Magnitude guard — ONLY when the symbol was mapped to a BROAD
            // REFERENCE INDEX (CSPX → ^GSPC). A reference index can be an
            // order of magnitude off from the fund's per-unit price (5,900
            // index vs ~840 ETF unit). If the fetched index level is
            // implausible vs the user's recorded price, reject it and use
            // the stored price — a 7–32x overstatement is worse than a
            // stale-but-right number. A plain ticker (idx === symbol) has no
            // index-vs-unit mismatch, so the guard is skipped for it.
            if (idx !== h.symbol) {
              if (plausiblePrice(yq.price, h.currentPriceLocal)) return yq;
              const f = fallback();
              f.note = `live ${idx} level ${yq.price} ${yq.currency} is implausible vs stored ${h.currentPriceLocal}; using stored price`;
              return f;
            }
            return yq;
          }
        case 'gold':
          // Gold: track the spot reference the StashAway gold sleeve uses.
          // 'GC=F' = front-month COMEX gold futures (close proxy for spot).
          // A user who types GLD/GLDM/GOLD gets the same gold reference so
          // the quote lines up with the fund's daily NAV (drift = fee only).
          {
            const g = STASHAWAY_INDEX_MAP[h.symbol.toUpperCase()]
              ?? (h.symbol === 'GOLD' || h.symbol === 'GLD' || h.symbol === 'GLDM' ? 'GC=F' : h.symbol);
            const yq = await this.yahooQuote(g, h.holdingCurrency, h.symbol === g ? undefined : h.symbol);
            // Magnitude guard only when g is a REFERENCE (GC=F / index), not
            // the user's own gold ticker — a futures level (~4,074) vs a fund
            // unit (~83) is a 49x mismatch that would overstate the position.
            if (g !== h.symbol) {
              if (plausiblePrice(yq.price, h.currentPriceLocal)) return yq;
              const f = fallback();
              f.note = `live ${g} level ${yq.price} ${yq.currency} is implausible vs stored ${h.currentPriceLocal}; using stored price`;
              return f;
            }
            return yq;
          }
        case 'cash':
        case 'mmf':
          return {
            ok: true,
            symbol: h.symbol,
            assetClass: h.assetClass,
            price: 1,
            currency: h.holdingCurrency,
            source: 'manual',
            asOf: Date.now(),
            note: 'cash/mmf valued at par',
          };
        default:
          return fallback();
      }
    } catch (e) {
      const r = fallback();
      r.note = `live fetch failed (${e instanceof Error ? e.message : e}); using stored price`;
      return r;
    }
  }

  private async cryptoQuote(symbol: string, holdingCurrency?: string): Promise<QuoteResult> {
    // Resolve the underlying coin: `BTC`/`ETH` map by name; a currency-
    // suffixed form like `BTCMYR` is stripped to its base coin first. The
    // base coin (or the raw symbol as a last resort) is then used as the
    // CoinGecko id when no named mapping exists.
    const base = baseCoin(symbol);
    const coin =
      COINGECKO_COIN_MAP[base] ?? COINGECKO_COIN_MAP[symbol.toUpperCase()] ?? symbol.toLowerCase();
    // Price in the holding's own currency when CoinGecko covers it directly
    // (a MYR-denominated BTC -> MYR, 1 decimal — exactly what the local
    // exchanges show). USD is the fallback, converted via the FX table.
    // CoinGecko's MYR endpoint rounds to 1 decimal; that's the intended
    // precision for a ringgit display, not an error to "fix".
    const prefer = (holdingCurrency && holdingCurrency.toUpperCase() !== 'USD')
      ? holdingCurrency.toUpperCase()
      : null;
    const vs = prefer ? `${prefer.toLowerCase()},usd` : 'usd';
    const res = await fetchWithTimeout(
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coin)}&vs_currencies=${encodeURIComponent(vs)}&include_24hr_change=true`,
    );
    if (!res.ok) throw new Error(`coingecko ${res.status}`);
    const j = await res.json();
    const key = Object.keys(j)[0];
    const cell = j[key];
    const localPrice = prefer ? cell?.[prefer.toLowerCase()] : undefined;
    const price = typeof localPrice === 'number' ? localPrice : cell?.usd;
    if (typeof price !== 'number') throw new Error('coingecko: no price');
    return {
      ok: true,
      symbol,
      assetClass: 'crypto',
      price,
      currency: typeof localPrice === 'number' ? prefer! : 'USD',
      source: 'coingecko',
      asOf: Date.now(),
      note: cell?.usd_24h_change !== undefined
        ? `24h change ${cell.usd_24h_change}%`
        : undefined,
    };
  }

  private async yahooQuote(symbol: string, holdingCurrency: string, displaySymbol?: string): Promise<QuoteResult> {
    const res = await fetchWithTimeout(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) throw new Error(`yahoo ${res.status}`);
    const j = await res.json();
    const meta = j?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    if (typeof price !== 'number') throw new Error('yahoo: no regularMarketPrice');
    const cur = meta.currency || holdingCurrency || 'USD';
    // Report the holding's symbol (e.g. 'CSPX') so the UI shows what the user
    // entered; the fetch may have used a reference index ('^GSPC') behind it.
    return {
      ok: true,
      symbol: displaySymbol ?? symbol,
      assetClass: 'equity-us',
      price,
      currency: cur,
      source: 'yahoo',
      asOf: meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now(),
      note: displaySymbol && displaySymbol !== symbol
        ? `tracked ${symbol} index`
        : undefined,
    };
  }

  /** Batch quote (used by the portfolio aggregator). Returns a snapshot map
   *  keyed by symbol.
   *
   *  Quotes are fetched in PARALLEL (Promise.allSettled) so a single junk
   *  symbol — unknown ticker, dead endpoint, rate limit — can never stall
   *  every other quote or hang the KPI panel: each request has its own
   *  12s abort timeout, and a rejected/failing fetch degrades to the
   *  stored price with a `note` explaining why, instead of throwing. */
  async batch(holdings: InvestmentHolding[]): Promise<Record<string, QuoteSnapshot>> {
    // Dedupe: two holdings of the same symbol only need one fetch.
    const bySymbol = new Map<string, InvestmentHolding>();
    for (const h of holdings) bySymbol.set(h.symbol, h);
    const unique = [...bySymbol.values()];

    const settled = await Promise.allSettled(unique.map((h) => this.quote(h)));
    const out: Record<string, QuoteSnapshot> = {};
    unique.forEach((h, i) => {
      const s = settled[i];
      if (s.status === 'fulfilled') {
        const q = s.value;
        out[h.symbol] = {
          symbol: q.symbol,
          assetClass: h.assetClass,
          price: q.price,
          currency: q.currency,
          asOf: q.asOf,
          source: q.source,
          note: q.note,
        };
      } else {
        // `quote()` should never reject (it catches internally), but be
        // safe: fall back to the stored price and say so.
        const reason = s.reason instanceof Error ? s.reason.message : String(s.reason);
        out[h.symbol] = {
          symbol: h.symbol,
          assetClass: h.assetClass,
          price: h.currentPriceLocal || 0,
          currency: h.holdingCurrency,
          asOf: Date.now(),
          source: 'failed',
          note: `live fetch failed (${reason}); using stored price`,
        };
      }
    });
    return out;
  }
}

// Note: the app wires a single MarketDataService instance to fxService in
// services/index.ts (`marketDataService`). Do NOT import the class here
// and construct a second instance — that is the bug this file used to ship.

export { baseCoin, plausiblePrice, PAR_FUNDS };
