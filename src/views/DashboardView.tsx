// ============================================================================
// Dashboard — net worth, spending pace, advisor cards.
// ============================================================================

import { useMemo } from 'react';
import { useVaultStore } from '../store/store';
import { useLiveData } from '../hooks/useLiveData';
import { currencyInfo, formatMoney } from '../domain/enums';
import { runRules, spendOverLastDays } from '../ai';

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
  const dayOfMonth = new Date().getDate();
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

  return (
    <>
      <h2 className="section-title">Net worth</h2>
      <div className="card">
        <div className="kpi">
          <div className="cell">
            <div className="num">{formatMoney(live.portfolio?.totalValueBase ?? 0, base)}</div>
            <div className="lbl">Portfolio</div>
          </div>
          <div className="cell">
            <div className="num">
              <span className={live.portfolio?.totalReturnPct && live.portfolio.totalReturnPct >= 0 ? 'pos' : 'neg'}>
                {live.portfolio?.totalReturnPct != null
                  ? `${live.portfolio.totalReturnPct >= 0 ? '+' : ''}${live.portfolio.totalReturnPct.toFixed(1)}%`
                  : '—'}
              </span>
            </div>
            <div className="lbl">Return</div>
          </div>
        </div>
        <div className="row small muted" style={{ marginTop: 12 }}>
          <span>{live.loading ? 'Fetching live quotes…' : `${live.portfolio?.liveQuoteCount ?? 0} live · ${live.portfolio?.staleQuoteCount ?? 0} cached`}</span>
          <button className="btn ghost sm" onClick={live.refresh} disabled={live.loading}>Refresh</button>
        </div>
      </div>

      <h2 className="section-title">Spending</h2>
      <div className="card">
        <div className="kpi">
          <div className="cell">
            <div className="num">{formatMoney(spentThisMonth, base)}</div>
            <div className="lbl">This month</div>
          </div>
          <div className="cell">
            <div className="num">{sym}{dailyPace.toFixed(0)}/d</div>
            <div className="lbl">Daily pace</div>
          </div>
          <div className="cell">
            <div className="num">{formatMoney(projected, base)}</div>
            <div className="lbl">Projected mo</div>
          </div>
        </div>
      </div>

      {advice.length > 0 && (
        <>
          <h2 className="section-title">Advisor</h2>
          <div className="list">
            {advice.map((a) => (
              <div className="item" key={a.id}>
                <div className={`chip ${a.priority === 'high' ? 'neg' : ''}`}>
                  {a.priority === 'high' ? '▲' : a.priority === 'medium' ? '●' : '▽'} {a.priority}
                </div>
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

      <div className="row" style={{ marginTop: 18 }}>
        <button className="btn sm" onClick={() => onOpenTab('expenses')}>+ Add expense</button>
        <button className="btn ghost sm" onClick={() => onOpenTab('investments')}>View portfolio</button>
      </div>
    </>
  );
}
