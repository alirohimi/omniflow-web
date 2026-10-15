// ============================================================================
// Dashboard — Monitor surface. One dominant number (net worth), a secondary
// stat, then advisor + pacing. Density and glanceable hierarchy; no hero-plus-
// three-cards, no decoration.
// ============================================================================

import { useMemo, useState, useEffect, useRef } from 'react';
import { useVaultStore } from '../store/store';
import { useLiveData } from '../hooks/useLiveData';
import { currencyInfo, formatMoney, EMERGENCY_DEFAULT } from '../domain/enums';
import { runRules, spendOverLastDays, summarizeDashboard, type DashboardSummary } from '../ai';
import {
  computeEmergency,
  forecastCashFlow,
  budgetReport,
  upcomingBills,
  bestStrategy,
  netWorthNow,
} from '../insights';
import { IPlus, IRefresh, IChevron } from '../icons';
import { fxService, type RatesForBase } from '../services';
import Markdown from '../components/Markdown';

type Tab = 'dashboard' | 'expenses' | 'investments' | 'settings';

/** Units of base per 1 of `code` — 1 when equal, falls back to 1 (no conversion)
 *  when no rate table is available, so the hero never shows NaN. */
function fromBaseRate(code: string, base: string, fx: RatesForBase | null): number {
  if (code === base) return 1;
  if (!fx) return 1;
  try {
    return fxService.toBase(1, code, fx);
  } catch {
    return 1;
  }
}

export function DashboardView({ onOpenTab }: { onOpenTab: (t: Tab) => void }) {
  const store = useVaultStore();
  const live = useLiveData();
  const { vault } = store;
  if (!vault) return null;
  const base = vault.prefs.baseCurrency;
  const sym = currencyInfo(base).symbol;
  const now = Date.now();

  const budgets = vault.budgets ?? [];
  const recurring = vault.recurring ?? [];
  const liabilities = vault.liabilities ?? [];

  // Net-worth hero: full assets − liabilities (was portfolio-only before).
  const nw = useMemo(
    () =>
      netWorthNow(
        vault.holdings,
        live.quotes,
        vault.assets ?? [],
        liabilities,
        (amt, from) => (from === base ? amt : fromBaseRate(from, base, live.fx) * amt),
      ),
    [vault, live, base],
  );

  // K1 — cashflow forecast: months-until-broke + 6-month projected balances.
  const forecast = useMemo(() => {
    if (!vault.expenses.length) return null;
    return forecastCashFlow(
      nw.net,
      6,
      vault.expenses,
      recurring,
      base,
      now,
    );
  }, [nw, vault.expenses, recurring, base, now]);

  // K2 — budget report (spend vs cap, per category, this month).
  const budgetLines = useMemo(
    () => (budgets.length ? budgetReport(budgets, vault.expenses, now) : []),
    [budgets, vault.expenses, now],
  );

  // K3 — next-5 upcoming bills.
  const nextBills = useMemo(
    () => upcomingBills(recurring, now, 30).slice(0, 5),
    [recurring, now],
  );

  // K4 — debt payoff (best strategy, total interest, months-to-debt-free).
  const debtPlan = useMemo(() => {
    if (!liabilities.length) return null;
    return bestStrategy(liabilities);
  }, [liabilities]);

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

  // Portfolio meta line: only surface live/cached/uncounted counts when there
  // is something to report (a fresh empty vault would otherwise read
  // "0 live · 0 cached" noise under the hero number).
  const liveCt = live.portfolio?.liveQuoteCount ?? 0;
  const staleCt = live.portfolio?.staleQuoteCount ?? 0;
  const unctd = live.portfolio?.uncounted ?? 0;
  const quoteMeta = live.loading
    ? 'Fetching live quotes…'
    : (liveCt || staleCt || unctd)
      ? `${liveCt} live · ${staleCt} cached${unctd ? ` · ${unctd} uncounted` : ''}`
      : '';
  const fxMeta = live.fxSource === 'offline' ? 'offline FX (cached/approx)' : '';
  const metaLine = [quoteMeta, fxMeta].filter(Boolean).join(' · ');

  const emRes = useMemo(
    () =>
      computeEmergency({
        emergency: vault.emergency ?? EMERGENCY_DEFAULT,
        expenses: vault.expenses,
        accounts: vault.accounts,
        portfolio: live.portfolio,
        fx: live.fx,
        base,
        now: Date.now(),
      }),
    [vault, live.portfolio, live.fx, base],
  );

  const [aiSummary, setAiSummary] = useState<DashboardSummary | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  // Net-worth time series: auto-capture a snapshot on each dashboard visit
  // (deduped to one point per day by captureNetWorth; capped at 365 points).
  const histRef = useRef(false);
  useEffect(() => {
    if (histRef.current) return; // only capture once per mount, not per data tick
    histRef.current = true;
    store.captureNetWorth({
      net: nw.net,
      investments: nw.investments,
      assets: nw.assets,
      liabilities: nw.liabilities,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const netWorthHistory = useMemo(() => vault.netWorthHistory ?? [], [vault.netWorthHistory]);

  useEffect(() => {
    let cancelled = false;
    setAiLoading(true);
    summarizeDashboard(
      {
        expenses: vault.expenses,
        accounts: vault.accounts,
        holdings: vault.holdings,
        quotes: live.quotes,
        prefs: vault.prefs,
      },
      live.portfolio,
      store.llmConfig,
    )
      .then((s) => { if (!cancelled) setAiSummary(s); })
      .catch(() => { if (!cancelled) setAiSummary(null); })
      .finally(() => { if (!cancelled) setAiLoading(false); });
    return () => { cancelled = true; };
  }, [vault, live.portfolio, live.quotes, store.llmConfig]);

  return (
    <>
      <h2 className="section-title">Portfolio</h2>
      <div className="card">
        <div className="hero">
          <div>
            <div className="hero-lbl">Net worth · {base}</div>
            <div className="hero-num">{formatMoney(nw.net, base)}</div>
            <div className="hero-sub">
              {nw.hasData ? (
                <>
                  <span className="muted">invest {formatMoney(nw.investments, base)} · assets {formatMoney(nw.assets, base)}</span>
                  {liabilities.length > 0 ? (
                    <span className="muted"> · debt −{formatMoney(nw.liabilities, base)}</span>
                  ) : null}
                </>
              ) : (
                <button className="link" onClick={() => onOpenTab('investments')}>
                  No data yet — add your first portfolio or asset
                </button>
              )}
            </div>
          </div>
          <button className="btn ghost sm" onClick={live.refresh} disabled={live.loading}>
            <IRefresh size={16} /> {live.loading ? '…' : 'Refresh'}
          </button>
        </div>
        {metaLine ? (
          <div className="row small muted meta-row">
            <span>{metaLine}</span>
          </div>
        ) : null}
        {netWorthHistory.length >= 2 && (
          <div style={{ marginTop: 10 }}>
            <div className="small muted" style={{ marginBottom: 4 }}>
              Net worth · {netWorthHistory.length}d history
            </div>
            <div style={{ display: 'flex', gap: 2, height: 48, alignItems: 'flex-end' }}>
              {netWorthHistory.map((p, i) => {
                const maxN = Math.max(...netWorthHistory.map((x) => x.net), 1);
                const minN = Math.min(...netWorthHistory.map((x) => x.net), 0);
                const range = maxN - minN || 1;
                const h = Math.max(3, ((p.net - minN) / range) * 44);
                return (
                  <div
                    key={i}
                    style={{
                      flex: 1,
                      height: h,
                      background: p.net < 0 ? 'var(--bad, #e5484d)' : 'var(--ok, #30a46c)',
                      opacity: 0.7,
                      borderRadius: 1,
                    }}
                    title={`${new Date(p.at).toLocaleDateString()}: ${formatMoney(p.net, base)}`}
                  />
                );
              })}
            </div>
            <div className="small muted" style={{ marginTop: 2, display: 'flex', justifyContent: 'space-between' }}>
              <span>{new Date(netWorthHistory[0].at).toLocaleDateString()}</span>
              <span>{new Date(netWorthHistory[netWorthHistory.length - 1].at).toLocaleDateString()}</span>
            </div>
          </div>
        )}
      </div>

      {aiLoading ? (
        <div className="card ai-summary-card" style={{ marginBottom: 16 }}>
          <span className="spinner sm" />
          <span className="muted" style={{ marginLeft: 8, fontSize: 13 }}>Generating AI summary…</span>
        </div>
      ) : aiSummary ? (
        <div className="card ai-summary-card" style={{ marginBottom: 16 }}>
          <div className="ai-summary-header">
            <span className={`chip sm ${aiSummary.source === 'llm' ? 'ok' : ''}`}>
              {aiSummary.source === 'llm' ? `AI · ${store.llmConfig?.provider ?? 'LLM'}` : 'On-device'}
            </span>
            {aiSummary.degraded && <span className="muted small">degraded - key call failed</span>}
          </div>
          <p className="ai-summary-text">
            <Markdown text={aiSummary.text} className="md" />
          </p>
        </div>
      ) : null}

      <h2 className="section-title">Spending pace</h2>
      <div className="card">
        <div className="hero">
          <div>
            <div className="hero-lbl">Spent this month</div>
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

      {forecast && (
        <>
          <h2 className="section-title">Cashflow forecast</h2>
          <div className="card">
            <div className="hero">
              <div>
                <div className="hero-lbl">Net {sym}{forecast.netPerMonth >= 0 ? '+' : ''}{forecast.netPerMonth.toFixed(0)}/mo</div>
                <div className="hero-num">
                  {forecast.firstNegativeMonth != null
                    ? `Broke in ~${forecast.firstNegativeMonth} mo`
                    : `Stable over ${forecast.points.length} mo`}
                </div>
                <div className="hero-sub">
                  <span className="muted">income {sym}{forecast.monthlyIncome.toFixed(0)}/mo · spend {sym}{forecast.monthlyExpenses.toFixed(0)}/mo</span>
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 4, marginTop: 10 }}>
              {forecast.points.map((p) => (
                <div key={p.label} style={{ flex: 1, textAlign: 'center', fontSize: 10 }}>
                  <div style={{
                    height: 40,
                    display: 'flex',
                    alignItems: 'flex-end',
                  }}>
                    <div style={{
                      width: '100%',
                      height: `${Math.max(4, Math.min(100, (p.balance / Math.max(1, ...forecast.points.map((x) => Math.abs(x.balance)))) * 100))}%`,
                      background: p.balance < 0 ? 'var(--bad, #e5484d)' : 'var(--ok, #30a46c)',
                      borderRadius: 2,
                    }} />
                  </div>
                  <div className="muted" style={{ fontSize: 9, marginTop: 2 }}>{p.label.slice(5)}</div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {budgetLines.length > 0 && (
        <>
          <h2 className="section-title">Budgets</h2>
          <div className="card">
            {budgetLines.map((b) => (
              <div key={b.id} style={{ marginBottom: 10 }}>
                <div className="row" style={{ marginBottom: 4 }}>
                  <span className="grow small" style={{ fontWeight: 600 }}>{b.category}</span>
                  <span className="small muted">
                    {sym}{b.spent.toFixed(0)} / {sym}{b.cap.toFixed(0)}
                    {b.status === 'over' && <span className="neg" style={{ marginLeft: 6 }}>over</span>}
                    {b.status === 'watch' && <span style={{ marginLeft: 6, color: '#e08600' }}>watch</span>}
                  </span>
                </div>
                <div className="bar" style={{ height: 5 }}>
                  <i style={{
                    width: `${Math.min(100, b.pct * 100)}%`,
                    background: b.status === 'over' ? 'var(--bad, #e5484d)' : b.status === 'watch' ? '#e08600' : 'var(--ok, #30a46c)',
                  }} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {nextBills.length > 0 && (
        <>
          <h2 className="section-title">Upcoming bills</h2>
          <div className="card list">
            {nextBills.map((b) => (
              <div key={b.id} className="item">
                <div className="grow">
                  <div className="title">{b.name}</div>
                  <div className="meta">
                    {b.daysUntilDue < 0
                      ? `overdue ${-b.daysUntilDue}d`
                      : b.daysUntilDue === 0
                        ? 'due today'
                        : `due in ${b.daysUntilDue}d`}
                  </div>
                </div>
                <div className="amt">{sym}{b.baseAmount.toFixed(0)}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {debtPlan && debtPlan.months > 0 && (
        <>
          <h2 className="section-title">Debt payoff</h2>
          <div className="card">
            <div className="hero">
              <div>
                <div className="hero-lbl">{debtPlan.strategy} plan</div>
                <div className="hero-num">
                  {Math.floor(debtPlan.months / 12) > 0 ? `${Math.floor(debtPlan.months / 12)}y ${debtPlan.months % 12}mo` : `${debtPlan.months} mo`}
                </div>
                <div className="hero-sub">
                  <span className="muted">
                    {liabilities.length} debt(s) · {sym}{debtPlan.totalInterest.toFixed(0)} total interest
                  </span>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      <h2 className="section-title">Emergency reserve</h2>
      <div className="card">
        <div className="hero">
          <div>
            <div className="hero-lbl">Reserve · {base}</div>
            <div className="hero-num">{formatMoney(emRes.reserve, base)}</div>
            <div className="hero-sub">
              {emRes.lines.length === 0 ? (
                <span className="muted">No lines yet — add one under Portfolio</span>
              ) : emRes.coverageMonths != null ? (
                <span>{emRes.coverageMonths.toFixed(1)} mo of essentials</span>
              ) : (
                <span className="muted">Coverage not measurable yet</span>
              )}
            </div>
          </div>
          <button className="btn ghost sm" onClick={() => onOpenTab('investments')}>
            Manage <IChevron size={16} />
          </button>
        </div>
        {emRes.lines.length > 0 && emRes.target > 0 ? (
          <>
            <div className="bar"><i style={{ width: `${Math.min(100, Math.round(emRes.pctOfTarget))}%` }} /></div>
            <div className="small muted" style={{ marginTop: 6 }}>
              {Math.min(100, Math.round(emRes.pctOfTarget))}% of {formatMoney(emRes.target, base)} target
              {emRes.gap > 0 ? ` · gap ${formatMoney(emRes.gap, base)}` : ' · target met'}
            </div>
          </>
        ) : null}
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
