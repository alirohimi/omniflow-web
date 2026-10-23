// ============================================================================
// Dashboard — Monitor surface. One dominant number (net worth), a secondary
// stat, then advisor + pacing. Density and glanceable hierarchy; no hero-plus-
// three-cards, no decoration.
// ============================================================================

import { useMemo, useState, useEffect, useRef } from 'react';
import { useVaultStore } from '../store/store';
import { useLiveData } from '../hooks/useLiveData';
import { currencyInfo, formatMoney, EMERGENCY_DEFAULT } from '../domain/enums';
import type { SalaryPeriod } from '../domain/types';
import { runRules, spendOverLastDays, summarizeDashboard, type DashboardSummary } from '../ai';
import {
  computeEmergency,
  forecastCashFlow,
  periodToMonthly,
  budgetReport,
  upcomingBills,
  bestStrategy,
} from '../insights';
import { IPlus, IRefresh, IChevron, ITrend, IWallet } from '../icons';
import { fxService } from '../services';
import { valueInBase } from '../ai/portfolio';
import Markdown from '../components/Markdown';
import { AreaChart } from '../components/AreaChart';

type Tab = 'dashboard' | 'expenses' | 'investments' | 'settings';

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
  const salary = vault.salary ?? null;

  // Net-worth hero: full assets − liabilities.
  //
  // The investments term uses the SAME valueInBase() math the Portfolio page
  // uses (ai/portfolio.ts), so the Home "invest" figure and the Portfolio
  // "Value" figure always reconcile. The old `investmentValueNow` in
  // insights/networth.ts treated par rows (cash/MMF) with no stored price as
  // 0, while valueInBase treats them as par (=1) — that was the source of the
  // Home-vs-Portfolio duplication the user saw.
  const nw = useMemo(
    () => {
      const rateToBase = (code: string): number => {
        if (code === base) return 1;
        if (!live.fx) return 0;
        try {
          return fxService.toBase(1, code, live.fx);
        } catch {
          return 0;
        }
      };
      let investments = 0;
      for (const h of vault.holdings) {
        const q = live.quotes[h.symbol];
        const { valueBase, ok } = valueInBase(h, q, base, rateToBase);
        if (ok) investments += valueBase;
      }
      const assetsSum = (vault.assets ?? []).reduce(
        (s, a) => s + (Number.isFinite(a.value) ? a.value : 0),
        0,
      );
      const liabilitiesSum = liabilities.reduce(
        (s, l) => s + (Number.isFinite(l.balance) ? l.balance : 0),
        0,
      );
      return {
        investments,
        assets: assetsSum,
        liabilities: liabilitiesSum,
        net: investments + assetsSum - liabilitiesSum,
        hasData: vault.holdings.length > 0 || (vault.assets?.length ?? 0) > 0 || liabilities.length > 0,
      };
    },
    [vault, live.quotes, live.fx, base, liabilities],
  );

  // K1 — cash-flow forecast: months-until-broke + 6-month projected balances.
  // A declared salary (vault.salary) is the authoritative income rate and
  // overrides the sparse logged-income rate, so the forecast reflects the
  // user's real earnings rather than "income RM21/mo".
  const forecast = useMemo(() => {
    if (!vault.expenses.length) return null;
    return forecastCashFlow(
      nw.net,
      6,
      vault.expenses,
      recurring,
      base,
      now,
      salary,
    );
  }, [nw, vault.expenses, recurring, base, now, salary]);

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

  // Net-worth delta vs the previous capture (the hero "up/down" chip).
  // The last point in the history IS the just-captured now value, so the
  // previous point is the one before it; null when fewer than 2 points.
  const nwDelta = useMemo(() => {
    const h = netWorthHistory;
    if (h.length < 2) return null;
    const cur = h[h.length - 1].net;
    const prev = h[h.length - 2].net;
    const d = cur - prev;
    const pct = prev !== 0 ? (d / Math.abs(prev)) * 100 : 0;
    return { d, pct, up: d >= 0, from: prev };
  }, [netWorthHistory]);

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
      undefined,
      nw,
    )
      .then((s) => { if (!cancelled) setAiSummary(s); })
      .catch(() => { if (!cancelled) setAiSummary(null); })
      .finally(() => { if (!cancelled) setAiLoading(false); });
    return () => { cancelled = true; };
  }, [vault, live.portfolio, live.quotes, store.llmConfig]);

  return (
    <>
      <h2 className="section-title">Portfolio</h2>
      <div className="card hero-card">
        <div className="hero">
          <div>
            <div className="hero-lbl">Net worth · {base}</div>
            <div className="hero-num">{formatMoney(nw.net, base)}</div>
            <div className="hero-sub">
              {nw.hasData ? (
                <span className="muted">
                  invest {formatMoney(nw.investments, base)}
                  {nw.assets > 0 ? ` · assets ${formatMoney(nw.assets, base)}` : ''}
                  {liabilities.length > 0 ? ` · debt −${formatMoney(nw.liabilities, base)}` : ''}
                </span>
              ) : (
                <button className="link" onClick={() => onOpenTab('investments')}>
                  No data yet — add your first portfolio or asset
                </button>
              )}
            </div>
          </div>
          <div className="hero-actions">
            {ret != null && (
              <span className={`hero-delta ${ret >= 0 ? 'up' : 'down'}`} title="Portfolio return vs cost">
                <ITrend size={13} />
                {ret >= 0 ? '+' : ''}
                {ret.toFixed(1)}%
              </span>
            )}
            <button className="btn ghost sm" onClick={live.refresh} disabled={live.loading}>
              <IRefresh size={16} /> {live.loading ? '…' : 'Refresh'}
            </button>
          </div>
        </div>

        {/* Net-worth trend: polished area chart with period tabs, a
            gradient fill, and a tap-to-scrub tooltip. */}
        {netWorthHistory.length >= 2 ? (
          <div className="hero-chart">
            <AreaChart
              points={netWorthHistory.map((p) => ({ at: p.at, value: p.net }))}
              fmt={(v) => formatMoney(v, base)}
              fmtDate={(at) =>
                new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
              }
              height={148}
            />
            {nwDelta && (
              <div className="hero-delta-row">
                <span className={`hero-delta ${nwDelta.up ? 'up' : 'down'}`}>
                  {nwDelta.up ? '▲' : '▼'} {formatMoney(Math.abs(nwDelta.d), base)}
                  {Math.abs(nwDelta.pct) >= 0.05 ? ` (${nwDelta.up ? '+' : ''}${nwDelta.pct.toFixed(1)}%)` : ''}
                </span>
                <span className="muted small">vs previous day</span>
              </div>
            )}
          </div>
        ) : (
          <div className="small muted" style={{ marginTop: 10 }}>
            Trend appears after 2 days of visits — captured automatically on each Home load.
          </div>
        )}

        {metaLine ? (
          <div className="row small muted meta-row">
            <span>{metaLine}</span>
          </div>
        ) : null}
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
                  {nw.net < 0 && forecast.netPerMonth < 0
                    ? 'Already in the red'
                    : forecast.firstNegativeMonth != null
                      ? `Broke in ~${forecast.firstNegativeMonth} mo`
                      : nw.net < 0 && forecast.netPerMonth >= 0
                        ? 'Recovering (in the red)'
                        : `Holds ${forecast.points.length} mo at current pace`}
                </div>
                <div className="hero-sub">
                  <span className="muted">
                    {forecast.incomeSource === 'salary'
                      ? <>salary {sym}{forecast.monthlyIncome.toFixed(0)}/mo</>
                      : <>income {sym}{forecast.monthlyIncome.toFixed(0)}/mo{!forecast.salarySet && forecast.incomeRowCount === 0 ? ' (none logged)' : ''}</>}
                    {' · '}spend {sym}{forecast.monthlyExpenses.toFixed(0)}/mo
                  </span>
                </div>
              </div>
            </div>
            <div className="fc-bars">
              {forecast.points.map((p) => {
                const maxAbs = Math.max(1, ...forecast.points.map((x) => Math.abs(x.balance)));
                const h = Math.max(6, (Math.abs(p.balance) / maxAbs) * 100);
                const neg = p.balance < 0;
                return (
                  <div key={p.label} className="fc-col" title={`${p.label}: ${formatMoney(p.balance, base)}`}>
                    <div className={`fc-bar${neg ? ' neg' : ''}`} style={{ height: `${h}%` }} />
                    <div className="fc-lbl">{p.label.slice(5)}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* ---- Salary / income input ----------------------------------------
          The cash-flow forecast's income rate should reflect the user's REAL
          earnings, not the (often sparse) logged Income rows. A compact,
          always-visible card on the dashboard lets them declare a salary;
          the engine uses it as the authoritative income rate and the
          "salary …/mo" label appears in the hero when active. */}
      <SalaryInputCard baseCurrency={base} store={store} />

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
                <span>{emRes.coverageMonths.toFixed(1)} mo of spending</span>
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

// ============================================================================
// SalaryInputCard — declare a salary so the cashflow forecast uses real
// income instead of the (sparse) logged Income rows. Mobile-first, themed
// components only (.field / .seg / .btn primitives), touch targets >=44px.
//
// Task 011: UX rework of the period handling.
//  - The saved figure is stored as a per-month EQUIVALENT (SalaryProfile
//    contract), but the user may declare it in mo/wk/yr/daily. The input
//    always shows the number in the SELECTED unit, so "yr 10000" and
//    "wk 250" are two views of one value — no ≈-conversion shown, which
//    previously read as a wrong amount when the unit was switched.
//  - The figure is read-only while a salary is saved (editable-only draft
//    confusion is gone): Save applies the edit, Remove clears it, and the
//    action row sits directly under the field.
// ============================================================================

function SalaryInputCard({ baseCurrency, store }: {
  baseCurrency: string;
  store: ReturnType<typeof useVaultStore>;
}) {
  const sym = currencyInfo(baseCurrency).symbol;
  const salary = store.vault?.salary ?? null;

  // Draft state: the amount as the user types it, in the currently selected
  // unit. When a saved figure exists and the unit changes, the draft is
  // re-expressed in the new unit (rounded to sensible precision) so the box
  // never silently keeps showing the per-month number under a "yr" label.
  const [period, setPeriod] = useState<SalaryPeriod>(salary?.period ?? 'monthly');
  const [amount, setAmount] = useState(() =>
    salary ? humanize(unitAmount(salary.amountPerMonth, salary.period ?? 'monthly', salary.period ?? 'monthly')) : ''
  );
  // Whether the draft differs from the saved figure (drives the Save button).
  const [dirty, setDirty] = useState(false);

  /** Re-express the saved figure in unit `p` (used on save-sync + unit switch). */
  const syncAmountToUnit = (p: SalaryPeriod) =>
    salary ? String(humanize(unitAmount(salary.amountPerMonth, salary.period ?? 'monthly', p))) : '';

  // Re-sync the draft only when the SAVED figure changes (e.g. this card
  // just saved, or another surface changed it) — not on period switches.
  useEffect(() => {
    setAmount(syncAmountToUnit(period));
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salary]);

  const switchPeriod = (p: SalaryPeriod) => {
    setPeriod(p);
    if (salary) {
      // Re-express the saved value in the new unit so the input matches
      // what will be saved. A unit switch is not an edit, so it does not
      // mark the draft dirty.
      setAmount(syncAmountToUnit(p));
    }
  };

  const num = Number(amount);
  const canSave = Number.isFinite(num) && num > 0 && amount.trim() !== '';

  const save = () => {
    if (!canSave) return;
    store.setSalary({
      amountPerMonth: periodToMonthly(num, period),
      period,
      label: 'Salary',
      updatedAt: Date.now(),
    });
    setDirty(false);
  };
  const clear = () => {
    store.setSalary(null);
    setAmount('');
    setDirty(false);
  };

  const monthlyEquiv = canSave ? periodToMonthly(num, period) : 0;
  const monthlyEquivLabel = (m: number) =>
    m >= 100 ? Math.round(m).toLocaleString() : m.toFixed(2).replace(/\.00$/, '');

  // Display the saved figure in its OWN unit (never ≈), plus the /mo
  // equivalent as secondary context so the unit switch can't mislead.
  const savedDisplay = salary
    ? `${sym}${humanize(unitAmount(salary.amountPerMonth, salary.period ?? 'monthly', salary.period ?? 'monthly'))} ${salary.period === 'monthly' ? '/mo' : salary.period === 'weekly' ? '/wk' : salary.period === 'daily' ? '/day' : '/yr'}`
    : '';

  return (
    <>
      <h2 className="section-title">Monthly income</h2>
      <div className="card">
        <label className="field">
          <span className="field-label">
            <IWallet size={15} /> Salary
          </span>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              data-salary-input
              placeholder="e.g. 5000"
              value={amount}
              disabled={salary != null && !dirty}
              onChange={(e) => { setAmount(e.target.value); setDirty(true); }}
              aria-label={`Salary amount per ${period === 'monthly' ? 'month' : period === 'weekly' ? 'week' : period === 'daily' ? 'day' : 'year'}`}
            />
            <div className="seg" role="tablist" aria-label="Salary period">
              {([['monthly', 'mo'], ['weekly', 'wk'], ['yearly', 'yr']] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={period === id}
                  onClick={() => switchPeriod(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </label>

        {salary ? (
          <div className="row" style={{ gap: 10, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="small muted" style={{ flex: '1 1 180px' }}>
              <span style={{ color: 'var(--text)', fontWeight: 600 }}>{savedDisplay}</span>
              {' '}· ≈ {sym}{monthlyEquivLabel(salary.amountPerMonth)}/mo
            </span>
            <div className="row" style={{ gap: 8 }}>
              {dirty && (
                <button type="button" className="btn sm" onClick={save} aria-label="Save salary">
                  Save
                </button>
              )}
              <button type="button" className="btn ghost sm" onClick={clear} aria-label="Remove saved salary">
                Remove
              </button>
            </div>
          </div>
        ) : canSave ? (
          <div className="row" style={{ gap: 10, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="muted small" style={{ flex: '1 1 180px' }}>
              ≈ {sym}{monthlyEquivLabel(monthlyEquiv)}/mo — saved to the forecast
            </span>
            <button type="button" className="btn sm" onClick={save} aria-label="Save salary">
              Save
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}

/** Express a stored per-month equivalent as a figure in the given unit.
 *  The monthly equivalent is the single source of truth, so the raw figure
 *  in unit `to` is perMonth / factor(to) (factor = periodToMonthly(1, to)).
 *  The `from` unit only matters for what the user originally typed, which
 *  already folded into `perMonth` at save time. */
function unitAmount(perMonth: number, _from: SalaryPeriod, to: SalaryPeriod): number {
  return perMonth / (periodToMonthly(1, to) || 1);
}

/** Round a unit amount to human-friendly precision (no float noise). */
function humanize(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return n >= 1000 ? Math.round(n).toLocaleString() : String(Math.round(n * 100) / 100);
}
