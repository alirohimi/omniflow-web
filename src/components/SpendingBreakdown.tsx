// ============================================================================
// SpendingBreakdown — the "more breakdown detail for expenses" card.
//
// An expanded, at-a-glance expense analytics panel: period-over-period delta,
// average-per-day, "biggest single cost" callout, an interactive category
// donut, per-category drill-downs (the most recent transactions that make up
// each category), payment-method split, top merchants, a trailing 14-day
// trend strip, and (when set) per-category budget-vs-cap performance.
//
// All aggregation comes from the `spendingBreakdown` engine so the math
// stays unit-testable; this component is pure presentation.
// ============================================================================

import { useMemo, useState } from 'react';
import { spendingBreakdown, paymentLabel, type SpendWindow } from '../insights';
import { CATEGORIES, currencyInfo, formatMoney } from '../domain/enums';
import type { Budget, Expense } from '../domain/types';

type Period = 'month' | '30d' | 'all';
const PERIODS: { id: Period; label: string }[] = [
  { id: 'month', label: 'This month' },
  { id: '30d', label: 'Last 30d' },
  { id: 'all', label: 'All time' },
];

/** Map a period choice to the engine's window (month = days since 1st). */
function windowFor(period: Period): SpendWindow {
  if (period === '30d') return { days: 30 };
  if (period === 'all') return { all: true };
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return { days: Math.max(1, Math.round((Date.now() - start) / 86_400_000)) };
}

const catIcon = (name: string) => CATEGORIES.find((c) => c.name === name)?.icon ?? '🧾';

/** Deterministic categorical palette for the donut + legend. Indexed by the
 *  category's rank in the sorted `byCategory` list, so colors are stable
 *  within a render pass. A 12-swatch wheel that stays legible on dark. */
const PALETTE = [
  '#6c8cff', '#4fd1c5', '#f5a97f', '#f78fb3', '#a78bfa',
  '#7dd3fc', '#facc15', '#6ee7b7', '#f87171', '#c4b5fd',
  '#fca5a5', '#5eead4',
];
const colorFor = (i: number) => PALETTE[i % PALETTE.length];

const fmtDay = (t: number) =>
  new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** One donut segment as a stroke-circle dash segment (the reliable technique
 *  — no path trig, no degenerate-arc bug). See AllocationPie for rationale. */
function donutDash(r: number, frac0: number, frac1: number) {
  const C = 2 * Math.PI * r;
  const len = (frac1 - frac0) * C;
  return { dasharray: `${len} ${C - len}`, dashoffset: -frac0 * C };
}

export function SpendingBreakdown({
  expenses,
  budgets,
  baseCurrency,
}: {
  expenses: Expense[];
  budgets: Budget[];
  baseCurrency: string;
}) {
  const [period, setPeriod] = useState<Period>('30d');
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const sym = currencyInfo(baseCurrency).symbol;

  const data = useMemo(
    () =>
      spendingBreakdown(expenses, windowFor(period), Date.now(), {
        budgets,
        topMerchants: 8,
      }),
    [expenses, budgets, period],
  );

  // Reset the pinned category when the period changes (the slice set changes).
  const selectPeriod = (p: Period) => {
    setPeriod(p);
    setActiveCat(null);
  };

  const hasSpend = data.count > 0;
  const trendMax = Math.max(1, ...data.trend.map((d) => d.amount));

  // Donut geometry + cumulative fractions over the (top-8) category buckets.
  const R = 44;
  const THICK = 16;
  const cx = 60;
  const cy = 60;
  const donutCats = data.byCategory.slice(0, 8);
  const donutTotal = donutCats.reduce((s, b) => s + b.amount, 0);
  let cum = 0;
  const segs = donutCats.map((b, i) => {
    const f0 = donutTotal > 0 ? cum / donutTotal : 0;
    cum += b.amount;
    const f1 = donutTotal > 0 ? cum / donutTotal : 0;
    return { bucket: b, i, f0, f1 };
  });
  const activeIdx = activeCat ? donutCats.findIndex((b) => b.key === activeCat) : -1;

  const delta = data.deltaPct; // period-over-period change (null when no prior data)

  return (
    <div>
      <div className="row" style={{ alignItems: 'flex-end', marginBottom: 4 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 className="section-title" style={{ marginBottom: 2 }}>Spending breakdown</h2>
          <div className="muted small" style={{ marginTop: 2 }}>
            {hasSpend
              ? `${data.count} ${data.count === 1 ? 'expense' : 'expenses'} · ${formatMoney(data.total, baseCurrency)}`
              : 'No spend recorded yet'}
          </div>
        </div>
      </div>

      {/* Window selector — themed segmented control (never a native control). */}
      <div className="seg" style={{ marginBottom: 12 }}>
        {PERIODS.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={period === p.id}
            onClick={() => selectPeriod(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {!hasSpend ? (
        <div className="empty">
          Log an expense above and your per-category, payment-method, and
          merchant breakdown will appear here.
        </div>
      ) : (
        <>
          {/* ---- Hero: total + period-over-period delta + avg/day + biggest cost ---- */}
          <div className="ex-hero">
            <div className="ex-hero-main">
              <div className="ex-lbl">Total spend</div>
              <div className="ex-num">{sym}{data.total.toFixed(0)}</div>
              <div className="ex-sub">
                {delta != null ? (
                  <span className={`ex-delta ${delta >= 0 ? 'up' : 'down'}`}>
                    {delta >= 0 ? '▲' : '▼'} {Math.abs(delta * 100).toFixed(0)}% vs previous period
                  </span>
                ) : data.prevTotal == null ? (
                  <span className="muted">no prior period to compare</span>
                ) : (
                  <span className="muted">new spending this period</span>
                )}
              </div>
            </div>
            <div className="ex-hero-stats">
              <div className="ex-stat">
                <div className="ex-stat-num">{sym}{data.avgPerDay.toFixed(0)}</div>
                <div className="ex-stat-lbl">avg / day</div>
              </div>
              <div className="ex-stat">
                <div className="ex-stat-num">{data.count}</div>
                <div className="ex-stat-lbl">{data.count === 1 ? 'expense' : 'expenses'}</div>
              </div>
            </div>
          </div>

          {/* Biggest single cost callout — "what cost the most." */}
          {data.largest && (
            <div className="ex-callout" role="note">
              <div className="ex-callout-ico">🔺</div>
              <div className="ex-callout-body">
                <div className="ex-callout-lbl">Largest single cost</div>
                <div className="ex-callout-val">
                  {data.largest.merchant || 'Unknown'}
                  <span className="ex-callout-amt">{sym}{data.largest.amount.toFixed(0)}</span>
                </div>
                <div className="muted small">
                  {data.largest.category} · {fmtDay(data.largest.timestamp)}
                  {data.total > 0 ? ` · ${Math.round((data.largest.amount / data.total) * 100)}% of this window` : ''}
                </div>
              </div>
            </div>
          )}

          {/* ---- By category: interactive donut + legend + drill-downs ---- */}
          <div className="bd-h">By category</div>
          <div className="ex-donut-wrap">
            <div
              className="ex-donut"
              role="img"
              aria-label={`Category spend: ${donutCats.map((b) => `${b.key} ${Math.round(b.share * 100)}%`).join(', ')}`}
            >
              <svg
                width={120}
                height={120}
                viewBox="0 0 120 120"
              >
                {/* Quiet base ring so the donut reads as a ring, not a pie. */}
                <circle cx={cx} cy={cy} r={R} fill="none" stroke="var(--line)" strokeWidth={THICK} opacity={0.5} />
                {segs.map(({ bucket, i, f0, f1 }) => {
                  const active = activeCat === bucket.key;
                  const dimmed = activeCat != null && !active;
                  const { dasharray, dashoffset } = donutDash(R, f0, f1);
                  return (
                    <circle
                      key={bucket.key}
                      cx={cx}
                      cy={cy}
                      r={R}
                      fill="none"
                      stroke={colorFor(i)}
                      strokeWidth={active ? THICK + 4 : THICK}
                      strokeDasharray={dasharray}
                      strokeDashoffset={dashoffset}
                      transform={`rotate(-90 ${cx} ${cy})`}
                      opacity={dimmed ? 0.25 : 1}
                      style={{ transition: 'opacity .18s, stroke-width .18s', cursor: 'pointer' }}
                      onClick={() => setActiveCat((c) => (c === bucket.key ? null : bucket.key))}
                    >
                      <title>{`${bucket.key}: ${sym}${bucket.amount.toFixed(0)} (${Math.round(bucket.share * 100)}%)`}</title>
                    </circle>
                  );
                })}
                {/* Center hole + label. */}
                <circle cx={cx} cy={cy} r={R - THICK / 2 - 2} fill="var(--card)" />
                <text
                  x={cx} y={cy - 2} textAnchor="middle"
                  fill="var(--text)" fontWeight={750}
                  style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}
                >
                  {activeIdx >= 0
                    ? `${Math.round(donutCats[activeIdx].share * 100)}%`
                    : `${sym}${data.total.toFixed(0)}`}
                </text>
                <text x={cx} y={cy + 12} textAnchor="middle" fill="var(--muted)" style={{ fontSize: 8 }}>
                  {activeIdx >= 0 ? donutCats[activeIdx].key : 'total'}
                </text>
              </svg>
            </div>

            {/* Legend + expandable per-category drill-downs. */}
            <div className="ex-drills">
              {data.drills.map((d) => {
                const rank = donutCats.findIndex((b) => b.key === d.category);
                const color = rank >= 0 ? colorFor(rank) : colorFor(donutCats.length);
                const isOpen = activeCat === d.category;
                const showItems = isOpen ? d.items : [];
                return (
                  <div key={d.category} className={`ex-drill${isOpen ? ' on' : ''}`}>
                    <button
                      type="button"
                      className="ex-drillbtn"
                      aria-expanded={isOpen}
                      onClick={() => setActiveCat((c) => (c === d.category ? null : d.category))}
                    >
                      <span className="ex-drill-dot" style={{ background: color }} />
                      <span className="ex-drill-ico">{catIcon(d.category)}</span>
                      <span className="ex-drill-name">{d.category}</span>
                      <span className="ex-drill-pct">{Math.round(d.share * 100)}%</span>
                      <span className="ex-drill-amt">{sym}{d.total.toFixed(0)}</span>
                    </button>
                    {isOpen && showItems.length > 0 && (
                      <div className="ex-drill-items">
                        {showItems.map((it) => (
                          <div key={it.id} className="ex-drill-item">
                            <span className="ex-drill-item-name">{it.merchant}</span>
                            <span className="muted small" style={{ flex: 'none' }}>{fmtDay(it.timestamp)}</span>
                            <span className="ex-drill-item-amt">{sym}{it.amount.toFixed(0)}</span>
                          </div>
                        ))}
                        {d.items.length < 5 && (
                          <div className="muted small" style={{ padding: '2px 0' }}>
                            showing the {d.items.length} most recent in this category
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ---- Trailing 14-day trend ---- */}
          <div className="bd-h">Last 14 days</div>
          <div className="bd-trend" role="img" aria-label="Daily spend, last 14 days">
            {data.trend.map((d) => (
              <i
                key={d.date}
                className={d.amount > 0 ? '' : 'zero'}
                style={{ height: `${Math.max(4, Math.round((d.amount / trendMax) * 100))}%` }}
                title={`${new Date(d.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}: ${sym}${d.amount.toFixed(0)}`}
              />
            ))}
          </div>
          <div className="bd-trend-lbl">
            <span>{new Date(data.trend[0].date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
            <span>today</span>
          </div>

          {/* ---- By payment method ---- */}
          {data.byPayment.length > 0 && (
            <>
              <div className="bd-h">Payment method</div>
              <div className="bd-pay">
                {data.byPayment.map((b) => (
                  <span className="chip" key={b.key} title={`${Math.round(b.share * 100)}% of spend`}>
                    {paymentLabel(b.key)} · {sym}{b.amount.toFixed(0)}
                  </span>
                ))}
              </div>
            </>
          )}

          {/* ---- Top merchants ---- */}
          {data.topMerchants.length > 0 && (
            <>
              <div className="bd-h">Top merchants</div>
              <div className="list" style={{ marginTop: 0 }}>
                {data.topMerchants.map((b) => (
                  <div className="item" key={b.key} style={{ padding: '10px 14px' }}>
                    <div className="grow">
                      <div className="title" style={{ fontSize: 13.5 }}>{b.key}</div>
                      <div className="meta">
                        {b.count} {b.count === 1 ? 'visit' : 'visits'} · last{' '}
                        {new Date(b.lastSeen).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      </div>
                    </div>
                    <div className="amt">{sym}{b.amount.toFixed(0)}</div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ---- Budgets vs cap (when the user has set any) ---- */}
          {data.budgets && data.budgets.length > 0 && (
            <>
              <div className="bd-h">This month vs caps</div>
              {data.budgets.map((l) => {
                const pct = l.cap > 0 ? Math.round((l.spent / l.cap) * 100) : 0;
                const state =
                  l.status === 'over' ? 'bad' : l.status === 'watch' ? 'warn' : '';
                return (
                  <div className="bd-cat" key={l.category}>
                    <div className="lbl">
                      <span className="ico">{catIcon(l.category)}</span>
                      <span className="nm">{l.category}</span>
                    </div>
                    <div className="amt">
                      {sym}{l.spent.toFixed(0)} <span className="muted">/ {sym}{l.cap.toFixed(0)}</span>
                    </div>
                    <div className="bd-track">
                      <i
                        className={state || undefined}
                        style={{ width: `${Math.min(100, pct)}%` }}
                      />
                    </div>
                    <div className="bd-pct" style={l.status === 'over' ? { color: 'var(--bad)' } : undefined}>
                      {pct}% used{l.status === 'over' ? ` · ${sym}${(l.spent - l.cap).toFixed(0)} over` : ''}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </>
      )}
    </div>
  );
}
