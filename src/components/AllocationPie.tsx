// ============================================================================
// AllocationPie — the hero allocation chart for the Portfolio page.
//
// Design language: modern glassmorphic fintech card.
//   1. A luminous SVG donut with a soft ambient glow, rounded caps, and a
//      frosted center hole that shows the total (or the pinned slice's %).
//      Active slice gets a wider stroke + a subtle drop-shadow.
//   2. A thick rounded capsule stacked bar — the primary at-a-glance read —
//      with staggered entrance animation, gradient segments, and hover lift.
//   3. An interactive breakdown list: each row is a tappable card with a
//      colored icon tile, an inline progress bar, % + value, and an
//      animated drill-down for sub-holdings.
//
// Slices can be per-class (with a `sub` drill-down of individual holdings)
// or per-holding (no sub). Colors come from colorForClass so everything
// agrees with the rest of the app.
//
// Pure SVG (no chart lib): donut segments are stroke-circle dash arcs —
// the reliable technique that dodges the degenerate zero-length-arc bug.
// NaN-safe: zero/negative values are filtered and a zero total renders an
// empty ring + hint instead of NaN angles.
// ============================================================================

import { useMemo, useState } from 'react';
import { formatMoney } from '../domain/enums';
import type { AssetClass } from '../domain/types';

/** Same palette as the app's allocation colors so bar + donut + legend
 *  always agree. Vivid modern hues tuned for the dark-glass canvas. */
const CLASS_COLORS: Record<string, string> = {
  'equity-us': '#5b8def',
  'equity-local': '#a78bfa',
  etf: '#34d399',
  crypto: '#fbbf24',
  cash: '#38bdf8',
  mmf: '#22d3ee',
};
const FALLBACK_COLORS = ['#f472b6', '#2dd4bf', '#c084fc', '#fbbf24', '#94a3b8'];

export function colorForClass(assetClass: string, index: number): string {
  return CLASS_COLORS[assetClass] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

/** Human-friendly label per asset class, used in the breakdown rows. */
const CLASS_LABELS: Record<string, string> = {
  'equity-us': 'US Stocks',
  'equity-local': 'Local Stocks',
  etf: 'ETFs',
  crypto: 'Crypto',
  cash: 'Cash',
  mmf: 'Money Market',
};

export interface PieSlice {
  key: string;
  label: string;
  valueBase: number;
  color: string;
  /** Optional drill-down rows rendered under this slice (class mode). */
  sub?: { label: string; valueBase: number }[];
}

interface AllocationPieProps {
  slices: PieSlice[];
  total: number;
  base: string;
  /** Center label when nothing is pinned. */
  title?: string;
}

/** One donut arc as a stroke-circle dash segment. The reliable technique:
 *  draw a full circle, hide all but the slice's fraction with
 *  stroke-dasharray, and rotate it to the slice's start position with
 *  stroke-dashoffset. No path trig, no degenerate-arc bug. */
function sliceLabel(key: string, rawLabel: string): string {
  if (CLASS_LABELS[key]) return CLASS_LABELS[key];
  return rawLabel;
}

function donutDash(r: number, frac0: number, frac1: number) {
  const C = 2 * Math.PI * r;
  const len = (frac1 - frac0) * C;
  return { dasharray: `${len} ${C - len}`, dashoffset: -frac0 * C, C };
}

export function AllocationPie({ slices, total, base, title }: AllocationPieProps) {
  // pinned: a tapped row stays selected until tapped again (or another
  // row is tapped). hoverIdx: transient fine-pointer hover, takes display
  // priority but never changes `pinned`.
  const [pinned, setPinned] = useState<string | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const usable = useMemo(
    () => slices.filter((s) => Number.isFinite(s.valueBase) && s.valueBase > 0),
    [slices],
  );
  const sum = useMemo(() => usable.reduce((s, x) => s + x.valueBase, 0), [usable]);

  if (usable.length === 0 || sum <= 0) {
    return (
      <div className="alloc-empty">
        No allocation to chart yet — add holdings first.
      </div>
    );
  }

  // Cumulative fractions for the donut segments (list order = value order, big→small).
  let cum = 0;
  const arcs = usable.map((s, idx) => {
    const f0 = cum / sum;
    const f1 = (cum + s.valueBase) / sum;
    cum += s.valueBase;
    return { slice: s, f0, f1, idx };
  });

  const activeKey = hoverIdx != null ? usable[hoverIdx].key : pinned;
  const activeSlice = activeKey != null ? usable.find((s) => s.key === activeKey) : null;
  const activePct = activeSlice ? (activeSlice.valueBase / sum) * 100 : null;

  const cx = 60, cy = 60, R = 52, THICK = 14;
  const centerLabel = activeSlice ? sliceLabel(activeSlice.key, activeSlice.label) : (title ?? 'total');

  return (
    <div className="alloc">
      {/* Donut + stacked bar, side by side on wide / stacked on narrow. */}
      <div className="alloc-top">
        <div className="alloc-donut-wrap">
          <svg
            className="alloc-donut"
            width={132}
            height={132}
            viewBox="0 0 120 120"
            role="img"
            aria-label={arcs
              .map((a) => `${sliceLabel(a.slice.key, a.slice.label)} ${((a.f1 - a.f0) * 100).toFixed(1)}%`)
              .join(', ')}
          >
            <defs>
              <filter id="alloc-glow" x="-40%" y="-40%" width="180%" height="180%">
                <feDropShadow dx="0" dy="0" stdDeviation="3.5" floodColor={activeSlice?.color ?? '#8b7bff'} floodOpacity="0.55" />
              </filter>
            </defs>
            {/* Quiet base ring so the donut reads as a ring, not a pie. */}
            <circle cx={cx} cy={cy} r={R} fill="none" stroke="var(--line)" strokeWidth={THICK} opacity={0.45} />

            {arcs.map((a) => {
              const isActive = activeKey === a.slice.key;
              const dimmed = activeKey != null && !isActive;
              const { dasharray, dashoffset } = donutDash(R, a.f0, a.f1);
              // A hair of rounding via strokeLinecap only when a slice is
              // big enough to survive the cap overlap.
              const span = a.f1 - a.f0;
              return (
                <circle
                  key={a.slice.key}
                  cx={cx} cy={cy} r={R}
                  fill="none"
                  stroke={a.slice.color}
                  strokeWidth={isActive ? THICK + 4 : THICK}
                  strokeDasharray={dasharray}
                  strokeDashoffset={dashoffset}
                  strokeLinecap={span > 0.045 ? 'round' : 'butt'}
                  transform={`rotate(-90 ${cx} ${cy})`}
                  opacity={dimmed ? 0.22 : 1}
                  filter={isActive ? 'url(#alloc-glow)' : undefined}
                  className="alloc-arc"
                  onClick={() => setPinned((p) => (p === a.slice.key ? null : a.slice.key))}
                >
                  <title>{`${sliceLabel(a.slice.key, a.slice.label)}: ${formatMoney(a.slice.valueBase, base)} (${((a.f1 - a.f0) * 100).toFixed(1)}%)`}</title>
                </circle>
              );
            })}

            {/* Frosted center hole + label. */}
            <circle cx={cx} cy={cy} r={R - THICK / 2 - 4} className="alloc-hole" />
            <text
              x={cx} y={activeSlice ? cy - 4 : cy - 2} textAnchor="middle"
              className="alloc-center-num"
              fontSize={activeSlice ? 16 : 13.5}
              fontWeight={800}
              fill="var(--text)"
            >
              {activeSlice
                ? `${activePct!.toFixed(activePct! < 10 ? 1 : 0)}%`
                : formatMoney(total > 0 ? total : sum, base)}
            </text>
            <text x={cx} y={cy + 11} textAnchor="middle" className="alloc-center-lbl">
              {centerLabel}
            </text>
          </svg>
        </div>

        {/* The thick capsule stacked bar — the primary, at-a-glance read. */}
        <div className="alloc-bar" role="img"
          aria-label={`Allocation: ${usable.map((s) => `${sliceLabel(s.key, s.label)} ${((s.valueBase / sum) * 100).toFixed(1)}%`).join(', ')}`}>
          {usable.map((s, i) => {
            const pct = (s.valueBase / sum) * 100;
            if (pct <= 0) return null;
            return (
              <div
                key={s.key}
                className={`alloc-seg${activeKey === s.key ? ' on' : ''}`}
                style={{
                  width: `${pct}%`,
                  background: `linear-gradient(180deg, ${s.color} 0%, ${s.color}b3 100%)`,
                  opacity: activeKey == null || activeKey === s.key ? 1 : 0.3,
                  animationDelay: `${i * 45}ms`,
                }}
                title={`${sliceLabel(s.key, s.label)} · ${formatMoney(s.valueBase, base)} (${pct.toFixed(1)}%)`}
                onClick={() => setPinned((p) => (p === s.key ? null : s.key))}
                onMouseEnter={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx(null)}
              />
            );
          })}
        </div>
      </div>

      {/* Interactive breakdown rows. */}
      <div className="alloc-list">
        {usable.map((s, i) => {
          const pct = (s.valueBase / sum) * 100;
          const isOn = activeKey === s.key;
          const showSub = isOn && s.sub && s.sub.length > 0;
          const subMax = s.sub?.reduce((m, h) => Math.max(m, h.valueBase), 0) ?? 1;
          return (
            <div key={s.key} className={`alloc-row${isOn ? ' on' : ''}`}>
              <button
                className="alloc-rowbtn"
                onClick={() => setPinned((p) => (p === s.key ? null : s.key))}
                onMouseEnter={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx(null)}
                aria-pressed={pinned === s.key}
              >
                <span className="alloc-tile" style={{ ['--tile' as string]: s.color }}>
                  <span className="alloc-tile-pct">{pct >= 10 ? Math.round(pct) : pct.toFixed(1)}</span>
                </span>
                <span className="alloc-name">
                  {sliceLabel(s.key, s.label)}
                  <span className="alloc-progress" aria-hidden="true">
                    <i style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${s.color}, ${s.color}b3)` }} />
                  </span>
                </span>
                <span className="alloc-pct">{pct.toFixed(pct < 10 ? 1 : 0)}%</span>
                <span className="alloc-val">{formatMoney(s.valueBase, base)}</span>
              </button>

              {/* Drill-down: individual holdings inside this class (class
                  mode only). Animated collapse unless this row is active. */}
              {showSub ? (
                <div className="alloc-sub">
                  {s.sub!.map((h) => (
                    <div key={h.label} className="alloc-subrow">
                      <span className="alloc-sub-name">{h.label}</span>
                      <span className="alloc-sub-bar" aria-hidden="true">
                        <i style={{ width: `${(h.valueBase / Math.max(subMax, 1)) * 100}%`, background: s.color }} />
                      </span>
                      <span className="alloc-sub-val">{formatMoney(h.valueBase, base)}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* One-line total reconciliation. */}
      <div className="alloc-foot">
        {formatMoney(total > 0 ? total : sum, base)} total · {usable.length} {usable.length === 1 ? 'class' : 'classes'}
      </div>
    </div>
  );
}
