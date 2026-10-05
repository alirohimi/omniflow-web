// ============================================================================
// OmniFlow — live market data + FX hook.
// Fetches fresh rates (er-api -> frankfurter, cached for offline) and batch
// quotes for all holdings, then exposes a computed portfolio summary.
// ============================================================================

import { useEffect, useMemo, useState } from 'react';
import type { QuoteSnapshot } from '../domain/types';
import { fxService, marketDataService, type RatesForBase } from '../services';
import { buildPortfolio, type PortfolioSummary } from '../ai/portfolio';
import { useVaultStore } from '../store/store';

export interface LiveData {
  fx: RatesForBase | null;
  fxSource: RatesForBase['source'] | null;
  quotes: Record<string, QuoteSnapshot>;
  portfolio: PortfolioSummary | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useLiveData(): LiveData {
  const store = useVaultStore();
  const base = store.vault?.prefs.baseCurrency;
  const holdings = store.vault?.holdings ?? [];
  const accounts = store.vault?.accounts ?? [];

  const [fx, setFx] = useState<RatesForBase | null>(null);
  const [quotes, setQuotes] = useState<Record<string, QuoteSnapshot>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0); // manual refresh trigger

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!store.vault || !base) return;
      setLoading(true);
      setError(null);
      try {
        const rates = await fxService.latest(base);
        if (!alive) return;
        setFx(rates);
        const batch = await marketDataService.batch(holdings);
        if (!alive) return;
        setQuotes(batch);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, holdings.length, tick]);

  const portfolio = useMemo<PortfolioSummary | null>(() => {
    if (!store.vault || !fx || !base) return null;
    const rateToBase = (code: string): number =>
      code === base ? 1 : fxService.toBase(1, code, fx);
    return buildPortfolio(accounts, holdings, quotes, base, rateToBase);
  }, [store.vault, fx, quotes, base, accounts, holdings]);

  return {
    fx,
    fxSource: fx?.source ?? null,
    quotes,
    portfolio,
    loading,
    error,
    refresh: () => setTick((t) => t + 1),
  };
}
