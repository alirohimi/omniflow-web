// ============================================================================
// AllocationPie — SVG donut chart with a detail breakdown.
//
// Two linked views of the same aggregate:
//   1. A donut: one arc per asset class (or per holding, see `mode`),
//      colored consistently with AllocationBar.
//   2. A breakdown list: each slice's name, base value, and % share, with
//      sub-rows for individual holdings when breaking down by class.
//
// Pure SVG (no chart lib): conic-gradient tricks are avoided so the arcs
// render identically in every browser and stay crisp on mobile. Arcs are
// computed with plain trig (path A-commands); a full 100% single slice is
// drawn as a circle to avoid the degenerate zero-length arc bug.
// NaN-safe: zero/negative values are filtered, and a zero total renders an
// empty ring + a hint instead of NaN angles.
// ============================================================================

import { useMemo, useState } from 'react';
import { formatMoney } from '../domain/enums';
import type { AssetClass } from '../domain/types';

/** Same palette as AllocationBar so the stacked bar and the pie agree. */
const CLASS_COLORS: Record<string, string> = {
  'equity-us': '#5b8def',
  'equity-local': '#8b5cf6',
  etf: '#30a46c',
  crypto: '#e08600',
  cash: '#3b82f6',
  mmf: '#0ea5e9',
};
const FALLBACK_COLORS = ['#e5484d', '#14b8a6', '#a855f7', '#f59e0b', '#64748b'];

export function colorForClass(assetClass: string, index: number): string {
  return CLASS_COLORS[assetClass] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

export interface PieSlice {
  key: string;
  label: string;
  valueBase: number;
  color: string;
  /** Optional drill-down rows rendered under this slice. */
  sub?: { label: string; valueBase: number }[];
}

interface AllocationPieProps {
  slices: PieSlice[];
  total: number;
  base: string;
  /** Center label. */
  title?: string;
}

/** One donut arc as an SVG path. cx/cy/r in px; pct0..pct1 in 0..1. */
function arcPath(cx: number, cy: number, r: number, pct0: number, pct1: number): string {
  const a0 = pct0 * 2 * Math.PI - Math.PI / 2; // start at 12 o'clock
  const a1 = pct1 * 2 * Math.PI - Math.PI / 2;
  const large = pct1 - pct0 > 0.5 ? 1 : 0;
  const x0 = cx + r * Math.cos(a0);
  const y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1);
  const y1 = cy + r * Math.sin(a1);
  return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`;
}

export function AllocationPie({ slices, total, base, title }: AllocationPieProps) {
  const [active, setActive] = useState<string | null>(null);

  // Filter to real slices and compute cumulative fractions once.
  const usable = useMemo(
    () => slices.filter((s) => Number.isFinite(s.valueBase) && s.valueBase > 0),
    [slices],
  );
  const sum = useMemo(() => usable.reduce((s, x) => s + x.valueBase, 0), [usable]);

  if (usable.length === 0 || sum <= 0) {
    return (
      <div className="muted small" style={{ padding: '8px 0' }}>
        No allocation to chart yet — add holdings first.
      </div>
    );
  }

  // Cumulative start fraction per slice (in list order).
  let cum = 0;
  const arcs = usable.map((s) => {
    const f0 = cum / sum;
    const f1 = (cum + s.valueBase) / sum;
    cum += s.valueBase;
    return { slice: s, f0, f1 };
  });

  const cx = 60, cy = 60, r = 56;
  const activeSlice = active != null ? usable.find((s) => s.key === active) : null;

  return (
    <div>
      {/* Chart + legend side by side on wide, stacked on narrow. */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <svg
          width={120}
          height={120}
          viewBox="0 0 120 120"
          role="img"
          aria-label={arcs.map((a) => `${a.slice.label}: ${(a.f1 - a.f0) * 100 >= 1 ? ((a.f1 - a.f0) * 100).toFixed(0) : '<1'}%`).join(', ')}
          style={{ flexShrink: 0 }}
        >
          {arcs.map((a) => {
            // Full-circle single slice: draw a circle, not a degenerate arc.
            if (a.f1 - a.f0 >= 0.9999) {
              return (
                <circle
                  key={a.slice.key}
                  cx={cx}
                  cy={cy}
                  r={r}
                  fill={a.slice.color}
                  opacity={active == null || active === a.slice.key ? 0.9 : 0.35}
                />
              );
            }
            return (
              <path
                key={a.slice.key}
                d={arcPath(cx, cy, r, a.f0, a.f1)}
                fill={a.slice.color}
                opacity={active == null || active === a.slice.key ? 0.9 : 0.35}
                onMouseEnter={() => setActive(a.slice.key)}
                onMouseLeave={() => setActive(null)}
                onClick={() => setActive((p) => (p === a.slice.key ? null : a.slice.key))}
              >
                <title>{`${a.slice.label}: ${formatMoney(a.slice.valueBase, base)} (${((a.f1 - a.f0) * 100).toFixed(1)}%)`}</title>
              </path>
            );
          })}
          {/* Center hole + label. */}
          <circle cx={cx} cy={cy} r={r * 0.58} fill="var(--surface-1, #10121c)" />
          <text
            x={cx}
            y={cy - 4}
            textAnchor="middle"
            fill="var(--text-1, #eef1f8)"
            fontSize={11}
            fontWeight={700}
          >
            {activeSlice
              ? `${((activeSlice.valueBase / sum) * 100).toFixed(1)}%`
              : formatMoney(total > 0 ? total : sum, base)}
          </text>
          <text x={cx} y={cy + 10} textAnchor="middle" fill="var(--text-2, #9aa4b8)" fontSize={8}>
            {activeSlice ? activeSlice.label : (title ?? 'total')}
          </text>
        </svg>

        {/* Legend / detail breakdown. */}
        <div style={{ flex: 1, minWidth: 170 }}>
          {usable.map((s) => {
            const pct = (s.valueBase / sum) * 100;
            return (
              <div
                key={s.key}
                onMouseEnter={() => setActive(s.key)}
                onMouseLeave={() => setActive(null)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', cursor: 'default' }}
              >
                <span style={{ width: 10, height: 10, borderRadius: 2, background: s.color, flexShrink: 0 }} />
                <span className="grow" style={{ fontSize: 13 }}>
                  <span style={{ textTransform: 'capitalize' }}>{s.label}</span>
                  <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>{formatMoney(s.valueBase, base)}</span>
                </span>
                <span className="muted" style={{ fontSize: 12, minWidth: 40, textAlign: 'right' }}>
                  {pct.toFixed(1)}%
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Drill-down: holdings inside each class, only for the active slice
          (tap a slice or a legend row). Keeps the default view compact. */}
      {activeSlice && activeSlice.sub && activeSlice.sub.length > 0 ? (
        <div style={{ marginTop: 10 }}>
          <div className="small muted" style={{ marginBottom: 4 }}>
            {activeSlice.label} holdings
          </div>
          {activeSlice.sub.map((h) => (
            <div key={h.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0' }}>
              <span>{h.label}</span>
              <span className="muted">{formatMoney(h.valueBase, base)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
