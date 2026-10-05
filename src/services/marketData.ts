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

export type QuoteSource = 'coingecko' | 'yahoo' | 'manual' | 'cache';

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
   *  - crypto: live CoinGecko (USD). On failure, holding.currentPriceLocal.
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
          return await this.cryptoQuote(h.symbol);
        case 'equity-us':
        case 'equity-local':
        case 'etf':
          return await this.yahooQuote(h.symbol, h.holdingCurrency);
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

  private async cryptoQuote(symbol: string): Promise<QuoteResult> {
    const coin = COINGECKO_COIN_MAP[symbol.toUpperCase()] ?? symbol.toLowerCase();
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coin)}&vs_currencies=usd&include_24hr_change=true`,
    );
    if (!res.ok) throw new Error(`coingecko ${res.status}`);
    const j = await res.json();
    const key = Object.keys(j)[0];
    const price = j[key]?.usd;
    if (typeof price !== 'number') throw new Error('coingecko: no usd price');
    return {
      ok: true,
      symbol,
      assetClass: 'crypto',
      price,
      currency: 'USD',
      source: 'coingecko',
      asOf: Date.now(),
      note: j[key]?.usd_24h_change !== undefined
        ? `24h change ${j[key].usd_24h_change}%`
        : undefined,
    };
  }

  private async yahooQuote(symbol: string, holdingCurrency: string): Promise<QuoteResult> {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) throw new Error(`yahoo ${res.status}`);
    const j = await res.json();
    const meta = j?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    if (typeof price !== 'number') throw new Error('yahoo: no regularMarketPrice');
    const cur = meta.currency || holdingCurrency || 'USD';
    return {
      ok: true,
      symbol,
      assetClass: 'equity-us',
      price,
      currency: cur,
      source: 'yahoo',
      asOf: meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now(),
    };
  }

  /** Batch quote (used by the portfolio aggregator). Returns a snapshot map
   *  keyed by symbol. */
  async batch(holdings: InvestmentHolding[]): Promise<Record<string, QuoteSnapshot>> {
    const out: Record<string, QuoteSnapshot> = {};
    for (const h of holdings) {
      const q = await this.quote(h);
      out[h.symbol] = {
        symbol: q.symbol,
        assetClass: h.assetClass,
        price: q.price,
        currency: q.currency,
        asOf: q.asOf,
        source: q.source,
      };
    }
    return out;
  }
}

export const marketData = new MarketDataService(undefined as unknown as CurrencyExchangeService);

// Note: `marketData` is a module-level convenience export; the app wires it
// with the real fxService at bootstrap (services/index.ts).
