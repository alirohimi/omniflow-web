// ============================================================================
// SpendingBreakdown — the "more breakdown detail for expenses" card.
//
// Renders an aggregated view of spend over a selectable window: total +
// count, per-category distribution (bars + share %), payment-method split,
// top merchants, a trailing 14-day trend strip, and (when set) per-category
// budget-vs-cap performance. Purely presentational — all aggregation comes
// from the `spendingBreakdown` engine so the math stays unit-testable here
// and the component just draws it.
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
  const sym = currencyInfo(baseCurrency).symbol;

  const data = useMemo(
    () =>
      spendingBreakdown(expenses, windowFor(period), Date.now(), {
        budgets,
        topMerchants: 8,
      }),
    [expenses, budgets, period],
  );

  const hasSpend = data.count > 0;
  const trendMax = Math.max(1, ...data.trend.map((d) => d.amount));

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
            onClick={() => setPeriod(p.id)}
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
          {/* ---- By category ---- */}
          <div className="bd-h">By category</div>
          {data.byCategory.map((b) => (
            <div className="bd-cat" key={b.key}>
              <div className="lbl">
                <span className="ico">{catIcon(b.key)}</span>
                <span className="nm">{b.key}</span>
              </div>
              <div className="amt">{sym}{b.amount.toFixed(0)}</div>
              <div className="bd-track">
                <i style={{ width: `${Math.round(b.share * 100)}%` }} />
              </div>
              <div className="bd-pct">
                {Math.round(b.share * 100)}% · {b.count} {b.count === 1 ? 'item' : 'items'}
              </div>
            </div>
          ))}

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
