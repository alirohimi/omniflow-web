// ============================================================================
// Dashboard — Monitor surface. One dominant number (net worth), a secondary
// stat, then advisor + pacing. Density and glanceable hierarchy; no hero-plus-
// three-cards, no decoration.
// ============================================================================

import { useMemo } from 'react';
import { useVaultStore } from '../store/store';
import { useLiveData } from '../hooks/useLiveData';
import { currencyInfo, formatMoney } from '../domain/enums';
import { runRules, spendOverLastDays } from '../ai';
import { IPlus, IRefresh, IChevron } from '../icons';

type Tab = 'dashboard' | 'expenses' | 'investments' | 'settings';

export function DashboardView({ onOpenTab }: { onOpenTab: (t: Tab) => void }) {
  const store = useVaultStore();
  const live = useLiveData();
  const { vault } = store;
  if (!vault) return null;
  const base = vault.prefs.baseCurrency;
  const sym = currencyInfo(base).symbol;

  const spend30 = spendOverLastDays(vault.expenses, 30, base);
  const dailyPace = spend30 / 30;
  const projected = dailyPace * 31;

  const advice = useMemo(
    () =>
      runRules({
        expenses: vault.expenses,
        accounts: vault.accounts,
        holdings: vault.holdings,
        quotes: live.quotes,
        prefs: vault.prefs,
      }),
    [vault, live.quotes],
  );

  const topExpenses = useMemo(() => {
    const cutoff = Date.now() - 7 * 86_400_000;
    return vault.expenses
      .filter((e) => e.timestamp >= cutoff && e.category !== 'Income')
      .sort((a, b) => b.baseAmount - a.baseAmount)
      .slice(0, 5);
  }, [vault.expenses]);

  const spentThisMonth = useMemo(() => {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    return vault.expenses
      .filter((e) => e.timestamp >= start.getTime() && e.category !== 'Income')
      .reduce((s, e) => s + e.baseAmount, 0);
  }, [vault.expenses]);

  const ret = live.portfolio?.totalReturnPct ?? null;
  const pacePct = projected > 0 ? Math.min(100, (spentThisMonth / projected) * 100) : 0;

  return (
    <>
      <h2 className="section-title">Portfolio</h2>
      <div className="card">
        <div className="hero">
          <div>
            <div className="hero-lbl">Net worth · {base}</div>
            <div className="hero-num">{formatMoney(live.portfolio?.totalValueBase ?? 0, base)}</div>
            <div className="hero-sub">
              {ret != null ? (
                <span className={ret >= 0 ? 'pos' : 'neg'}>
                  {ret >= 0 ? '▲' : '▼'} {Math.abs(ret).toFixed(1)}% vs cost
                </span>
              ) : (
                <span className="muted">No holdings yet</span>
              )}
            </div>
          </div>
          <button className="btn ghost sm" onClick={live.refresh} disabled={live.loading}>
            <IRefresh size={16} /> {live.loading ? '…' : 'Refresh'}
          </button>
        </div>
        <div className="row small muted meta-row">
          <span>{live.loading ? 'Fetching live quotes…' : `${live.portfolio?.liveQuoteCount ?? 0} live · ${live.portfolio?.staleQuoteCount ?? 0} cached`}</span>
        </div>
      </div>

      <h2 className="section-title">Spending this month</h2>
      <div className="card">
        <div className="hero">
          <div>
            <div className="hero-lbl">Spent</div>
            <div className="hero-num">{formatMoney(spentThisMonth, base)}</div>
            <div className="hero-sub">
              <span className="muted">{sym}{dailyPace.toFixed(0)}/d pace</span>
              {' · '}
              <span className="muted">proj {formatMoney(projected, base)}</span>
            </div>
          </div>
        </div>
        <div className="bar"><i style={{ width: `${pacePct}%` }} /></div>
      </div>

      {advice.length > 0 && (
        <>
          <h2 className="section-title">Advisor</h2>
          <div className="list">
            {advice.map((a) => (
              <div className="item" key={a.id}>
                <span className={`prio ${a.priority}`} aria-label={`${a.priority} priority`} />
                <div className="grow">
                  <div className="title">{a.title}</div>
                  <div className="meta">{a.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {topExpenses.length > 0 && (
        <>
          <h2 className="section-title">Top this week</h2>
          <div className="list">
            {topExpenses.map((e) => (
              <div className="item" key={e.id}>
                <div className="grow">
                  <div className="title">{e.merchant}</div>
                  <div className="meta">{e.category} · {e.paymentMethod}</div>
                </div>
                <div className="amt">{sym}{e.baseAmount.toFixed(2)}</div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="row" style={{ marginTop: 20, gap: 10 }}>
        <button className="btn sm" onClick={() => onOpenTab('expenses')} style={{ flex: 1, justifyContent: 'center' }}>
          <IPlus size={16} /> Add expense
        </button>
        <button className="btn ghost sm" onClick={() => onOpenTab('investments')} style={{ flex: 1, justifyContent: 'center' }}>
          Portfolio <IChevron size={16} />
        </button>
      </div>
    </>
  );
}
