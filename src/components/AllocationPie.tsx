// ============================================================================
// AllocationPie — the single hero allocation chart for the Portfolio page.
//
// Redesigned for at-a-glance reading (simple, visual, novice-friendly):
//   1. A compact SVG donut: one rounded arc per slice, with a soft glow on
//      the active slice and the total (or active slice's %) in the hole.
//   2. A generous stacked horizontal bar — the primary read. Each segment
//      gets a subtle gradient + 1px gap so classes separate cleanly.
//   3. An interactive breakdown list: tap a row to pin its slice (the donut
//      highlights it and the hole shows its %). Tapping again unpins.
//
// Slices can be per-class (with a `sub` drill-down of individual holdings)
// or per-holding (no sub). Colors come from colorForClass so everything
// agrees with the rest of the app.
//
// Pure SVG (no chart lib): arcs are plain trig path A-commands; a full
// 100% single slice renders as a ring (two concentric circles) to dodge the
// degenerate zero-length arc. NaN-safe: zero/negative values are filtered
// and a zero total renders an empty ring + hint instead of NaN angles.
// ============================================================================

import { useMemo, useState } from 'react';
import { formatMoney } from '../domain/enums';
import type { AssetClass } from '../domain/types';

/** Same palette as the app's allocation colors so bar + donut + legend
 *  always agree. */
const CLASS_COLORS: Record<string, string> = {
  'equity-us': '#5b8def',
  'equity-local': '#8b5cf6',
  etf: '#30a46c',
  crypto: '#f59e0b',
  cash: '#3b82f6',
  mmf: '#0ea5e9',
};
const FALLBACK_COLORS = ['#e5484d', '#14b8a6', '#a855f7', '#f59e0b', '#64748b'];

export function colorForClass(assetClass: string, index: number): string {
  return CLASS_COLORS[assetClass] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

/** Human-friendly label per asset class, used in the breakdown rows. */
const CLASS_LABELS: Record<string, string> = {
  'equity-us': 'US stocks',
  'equity-local': 'Local stocks',
  etf: 'ETFs',
  crypto: 'Crypto',
  cash: 'Cash',
  mmf: 'Money market',
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
      <div className="muted small" style={{ padding: '8px 0' }}>
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

  const cx = 60, cy = 60, R = 52, THICK = 15;

  return (
    <div className="alloc">
      {/* Donut + stacked bar, side by side on wide / stacked on narrow. */}
      <div className="alloc-top">
        <svg
          className="alloc-donut"
          width={124}
          height={124}
          viewBox="0 0 120 120"
          role="img"
          aria-label={arcs
            .map((a) => `${sliceLabel(a.slice.key, a.slice.label)} ${((a.f1 - a.f0) * 100).toFixed(1)}%`)
            .join(', ')}
        >
          {/* Quiet base ring so the donut reads as a ring, not a pie. */}
          <circle cx={cx} cy={cy} r={R} fill="none" stroke="var(--line)" strokeWidth={THICK} opacity={0.5} />

          {arcs.map((a) => {
            const isActive = activeKey === a.slice.key;
            const dimmed = activeKey != null && !isActive;
            const { dasharray, dashoffset } = donutDash(R, a.f0, a.f1);
            return (
              <circle
                key={a.slice.key}
                cx={cx} cy={cy} r={R}
                fill="none"
                stroke={a.slice.color}
                strokeWidth={isActive ? THICK + 5 : THICK}
                strokeDasharray={dasharray}
                strokeDashoffset={dashoffset}
                transform={`rotate(-90 ${cx} ${cy})`}
                opacity={dimmed ? 0.25 : 1}
                style={{ transition: 'opacity .18s, stroke-width .18s', cursor: 'pointer' }}
                onClick={() => setPinned((p) => (p === a.slice.key ? null : a.slice.key))}
              >
                <title>{`${sliceLabel(a.slice.key, a.slice.label)}: ${formatMoney(a.slice.valueBase, base)} (${((a.f1 - a.f0) * 100).toFixed(1)}%)`}</title>
              </circle>
            );
          })}

          {/* Center hole + label. */}
          <circle cx={cx} cy={cy} r={R - THICK / 2 - 2} fill="var(--card)" />
          <text
            x={cx} y={cy - 3} textAnchor="middle"
            fill="var(--text)" fontSize={activeSlice ? 13 : 12.5} fontWeight={750}
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {activeSlice
              ? `${((activeSlice.valueBase / sum) * 100).toFixed(activeSlice.valueBase / sum < 0.1 ? 1 : 0)}%`
              : formatMoney(total > 0 ? total : sum, base)}
          </text>
          <text x={cx} y={cy + 11} textAnchor="middle" fill="var(--muted)" fontSize={8}>
            {activeSlice ? sliceLabel(activeSlice.key, activeSlice.label) : (title ?? 'total')}
          </text>
        </svg>

        {/* The generous stacked bar — the primary, at-a-glance read. */}
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
                  background: `linear-gradient(180deg, ${s.color} 0%, ${s.color}cc 100%)`,
                  opacity: activeKey == null || activeKey === s.key ? 1 : 0.35,
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
          return (
            <div key={s.key} className={`alloc-row${isOn ? ' on' : ''}`}>
              <button
                className="alloc-rowbtn"
                onClick={() => setPinned((p) => (p === s.key ? null : s.key))}
                onMouseEnter={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx(null)}
                aria-pressed={pinned === s.key}
              >
                <span className="alloc-dot" style={{ background: s.color }} />
                <span className="alloc-name">{sliceLabel(s.key, s.label)}</span>
                <span className="alloc-pct">{pct.toFixed(pct < 10 ? 1 : 0)}%</span>
                <span className="alloc-val">{formatMoney(s.valueBase, base)}</span>
              </button>

              {/* Drill-down: individual holdings inside this class (class
                  mode only). Collapsed unless this row is active. */}
              {showSub ? (
                <div className="alloc-sub">
                  {s.sub!.map((h) => (
                    <div key={h.label} className="alloc-subrow">
                      <span>{h.label}</span>
                      <span className="muted">{formatMoney(h.valueBase, base)}</span>
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
