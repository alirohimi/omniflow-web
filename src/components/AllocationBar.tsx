// ============================================================================
// AllocationBar — asset-class allocation chart for the Portfolio page.
//
// A stacked horizontal bar (one segment per asset class, sorted by value)
// plus a legend with the class name, base-currency value, and percent share.
// Driven by the same `byAssetClass` aggregate the KPI panel uses, so the
// numbers here always reconcile with the "Value" figure. NaN-safe: each item
// carries a pre-computed pct, and a missing/zero total renders an empty bar
// with a 0% legend rather than NaN.
// ============================================================================

import { formatMoney } from '../domain/enums';
import type { AssetClass } from '../domain/types';

/** Stable, distinguishable color per asset class so the legend and the bar
 *  segments always agree. Kept as a plain map (no randomness) so the chart
 *  is deterministic and accessible. */
const CLASS_COLORS: Record<string, string> = {
  'equity-us': '#5b8def',
  'equity-local': '#8b5cf6',
  etf: '#30a46c',
  crypto: '#e08600',
  cash: '#3b82f6',
  mmf: '#0ea5e9',
};
/** Fallbacks for any future asset class not in the map above. */
const FALLBACK_COLORS = ['#e5484d', '#14b8a6', '#a855f7', '#f59e0b', '#64748b'];

function colorFor(assetClass: string, index: number): string {
  return CLASS_COLORS[assetClass] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

interface AllocationBarProps {
  items: { assetClass: AssetClass; valueBase: number; pct: number }[];
  total: number;
  base: string;
}

export function AllocationBar({ items, total, base }: AllocationBarProps) {
  // Sort large->small for a stable, readable stacked bar.
  const sorted = [...items].sort((a, b) => b.valueBase - a.valueBase);
  // Guard: a zero total would divide by zero in the pct math the parent did;
  // fall back to even shares only for display so the legend never shows NaN.
  const safePct = (pct: number, i: number): number =>
    Number.isFinite(pct) ? pct : (sorted.length > 0 ? 100 / sorted.length : 0) || 0;

  return (
    <div>
      {/* Stacked bar: each segment's width = its share of the total. */}
      <div
        style={{
          display: 'flex',
          height: 16,
          width: '100%',
          borderRadius: 4,
          overflow: 'hidden',
          background: 'var(--surface-2, rgba(255,255,255,0.04))',
        }}
        role="img"
        aria-label={`Allocation: ${sorted.map((s) => `${s.assetClass} ${s.pct.toFixed(1)}%`).join(', ')}`}
      >
        {sorted.map((item, i) => {
          const w = Math.max(0, Math.min(100, safePct(item.pct, i)));
          if (w <= 0) return null;
          return (
            <div
              key={item.assetClass}
              title={`${item.assetClass} · ${formatMoney(item.valueBase, base)} (${w.toFixed(1)}%)`}
              style={{
                width: `${w}%`,
                background: colorFor(item.assetClass, i),
                opacity: 0.85,
              }}
            />
          );
        })}
      </div>

      {/* Legend: name, value, and share per class. */}
      <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 6 }}>
        {sorted.map((item, i) => {
          const w = safePct(item.pct, i);
          return (
            <div key={item.assetClass} className="row" style={{ gap: 6, fontSize: 12 }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: colorFor(item.assetClass, i),
                  flexShrink: 0,
                }}
              />
              <span className="grow">
                <div style={{ fontWeight: 600, textTransform: 'capitalize' }}>{item.assetClass}</div>
                <div className="muted" style={{ fontSize: 11 }}>
                  {formatMoney(item.valueBase, base)}
                </div>
              </span>
              <span className="muted" style={{ fontSize: 11, minWidth: 34, textAlign: 'right' }}>
                {w.toFixed(1)}%
              </span>
            </div>
          );
        })}
      </div>

      {/* Total reconciliation line so the user can verify the parts sum to
           the KPI value. */}
      <div className="muted small" style={{ marginTop: 8 }}>
        {formatMoney(total, base)} total · {sorted.length} asset class{sorted.length === 1 ? '' : 'es'}
      </div>
    </div>
  );
}
