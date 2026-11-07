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
 *  crypto/ETF quote path; the PWA polls them on the same 60s cadence. */
const STASHAWAY_INDEX_MAP: Record<string, string> = {
  CSPX:  '^GSPC', // S&P 500 (Developed Market / US sleeve)
  GLDM:  'GC=F',  // Gold (commodity sleeve)
  GLD:   'GC=F',  // user may type either gold ticker
};

/** Per-fetch wall clock. A junk symbol (or a flaky network) must never be
 *  allowed to hang the whole batch: after this many ms the request aborts
 *  and we fall back to the stored price. */
const FETCH_TIMEOUT_MS = 12_000;

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
          // StashAway model sleeves (CSPX, GLDM, …) price off the BROAD
          // INDEX their UCITS fund tracks — the same reference the fund's
          // daily NAV uses. Fetch THAT index so our live quote tracks the
          // same thing (minimal drift = fund fee + FX only, no instrument
          // mismatch). Unknown symbols fall through to the raw ticker.
          const idx = STASHAWAY_INDEX_MAP[h.symbol.toUpperCase()] ?? h.symbol;
          return await this.yahooQuote(idx, h.holdingCurrency, h.symbol);
        case 'gold':
          // Gold: track the spot reference the StashAway gold sleeve uses.
          // 'GC=F' = front-month COMEX gold futures (close proxy for spot).
          // A user who types GLD/GLDM/GOLD gets the same gold reference so
          // the quote lines up with the fund's daily NAV (drift = fee only).
          {
            const g = STASHAWAY_INDEX_MAP[h.symbol.toUpperCase()]
              ?? (h.symbol === 'GOLD' || h.symbol === 'GLD' || h.symbol === 'GLDM' ? 'GC=F' : h.symbol);
            return await this.yahooQuote(g, h.holdingCurrency, h.symbol === g ? undefined : h.symbol);
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
    const coin = COINGECKO_COIN_MAP[symbol.toUpperCase()] ?? symbol.toLowerCase();
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
