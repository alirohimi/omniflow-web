// ============================================================================
// AllocationPie — interactive Donut / Pie chart + 2-column legend cards.
// Pure SVG wedge geometry with single-slice circle fallback (NaN-proof).
// ============================================================================

import { useMemo, useState } from 'react';
import { formatMoney } from '../domain/enums';

/** Palette shared across chart + legend. */
const CLASS_COLORS: Record<string, string> = {
  'equity-us': '#5b8def',
  'equity-local': '#a78bfa',
  etf: '#34d399',
  crypto: '#fbbf24',
  gold: '#e6b422',
  cash: '#38bdf8',
  mmf: '#22d3ee',
};
const FALLBACK_COLORS = ['#f472b6', '#2dd4bf', '#c084fc', '#fbbf24', '#94a3b8'];

export function colorForClass(assetClass: string, index: number): string {
  return CLASS_COLORS[assetClass] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

const CLASS_LABELS: Record<string, string> = {
  'equity-us': 'US Stocks',
  'equity-local': 'Local Stocks',
  etf: 'ETFs',
  crypto: 'Crypto',
  gold: 'Gold',
  cash: 'Cash',
  mmf: 'Money Market',
};

export interface PieSlice {
  key: string;
  label: string;
  valueBase: number;
  color: string;
  sub?: { label: string; valueBase: number }[];
}

interface AllocationPieProps {
  slices: PieSlice[];
  total: number;
  base: string;
  title?: string;
  mode?: 'donut' | 'pie';
  selectedKey?: string | null;
  onSelect?: (key: string | null) => void;
  formatValue?: (v: number) => string;
}

function sliceLabel(key: string, rawLabel: string): string {
  if (CLASS_LABELS[key]) return CLASS_LABELS[key];
  return rawLabel;
}

function polar(cx: number, cy: number, r: number, rad: number) {
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function wedgePath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  a0: number,
  a1: number,
): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p0 = polar(cx, cy, rOuter, a0);
  const p1 = polar(cx, cy, rOuter, a1);
  if (rInner <= 0) {
    return `M ${cx} ${cy} L ${p0.x} ${p0.y} A ${rOuter} ${rOuter} 0 ${large} 1 ${p1.x} ${p1.y} Z`;
  }
  const p2 = polar(cx, cy, rInner, a1);
  const p3 = polar(cx, cy, rInner, a0);
  return (
    `M ${p0.x} ${p0.y} A ${rOuter} ${rOuter} 0 ${large} 1 ${p1.x} ${p1.y} ` +
    `L ${p2.x} ${p2.y} A ${rInner} ${rInner} 0 ${large} 0 ${p3.x} ${p3.y} Z`
  );
}

export function AllocationPie({
  slices,
  total,
  base,
  title,
  mode = 'donut',
  selectedKey,
  onSelect,
  formatValue,
}: AllocationPieProps) {
  const [internalPinned, setInternalPinned] = useState<string | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const pinned = selectedKey !== undefined ? selectedKey : internalPinned;
  const setPinned = (next: string | null) => {
    if (onSelect) onSelect(next);
    else setInternalPinned(next);
  };

  const usable = useMemo(
    () => slices.filter((s) => Number.isFinite(s.valueBase) && s.valueBase > 0),
    [slices],
  );
  const sum = useMemo(() => usable.reduce((s, x) => s + x.valueBase, 0), [usable]);
  const fmt = formatValue ?? ((v: number) => formatMoney(v, base));

  if (usable.length === 0 || sum <= 0) {
    return (
      <div className="alloc-empty">
        No allocation to chart yet — add an account or holding below.
      </div>
    );
  }

  let cum = 0;
  const arcs = usable.map((s, idx) => {
    const f0 = cum / sum;
    const f1 = (cum + s.valueBase) / sum;
    cum += s.valueBase;
    const a0 = -Math.PI / 2 + f0 * Math.PI * 2;
    const a1 = -Math.PI / 2 + f1 * Math.PI * 2;
    const mid = (a0 + a1) / 2;
    return { slice: s, f0, f1, a0, a1, mid, pct: (f1 - f0) * 100, idx };
  });

  const activeKey = hoverIdx != null ? usable[hoverIdx]?.key ?? null : pinned;
  const activeSlice = activeKey != null ? usable.find((s) => s.key === activeKey) ?? null : null;
  const activePct = activeSlice ? (activeSlice.valueBase / sum) * 100 : null;

  const cx = 180;
  const cy = 180;
  const rOuter = 136;
  const rInner = mode === 'donut' ? 82 : 0;
  const rLabel = mode === 'donut' ? (rOuter + rInner) / 2 : rOuter * 0.62;

  return (
    <div>
      <div className="alloc-wrap">
        <svg
          className="alloc-svg"
          viewBox="0 0 360 360"
          role="img"
          aria-label={arcs
            .map((a) => `${sliceLabel(a.slice.key, a.slice.label)} ${a.pct.toFixed(1)}%`)
            .join(', ')}
        >
          {usable.length === 1 ? (
            <g
              className="alloc-slice"
              onClick={() => setPinned(pinned === usable[0].key ? null : usable[0].key)}
            >
              {mode === 'donut' ? (
                <circle
                  cx={cx}
                  cy={cy}
                  r={(rOuter + rInner) / 2}
                  fill="none"
                  stroke={usable[0].color}
                  strokeWidth={rOuter - rInner}
                />
              ) : (
                <circle cx={cx} cy={cy} r={rOuter} fill={usable[0].color} />
              )}
              {mode === 'pie' && (
                <text
                  x={cx}
                  y={cy}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill="#ffffff"
                  fontSize={13}
                  fontWeight={700}
                >
                  100%
                </text>
              )}
            </g>
          ) : (
            arcs.map((a) => {
              const isActive = activeKey === a.slice.key;
              const dimmed = activeKey != null && !isActive;
              const dx = isActive ? Math.cos(a.mid) * 8 : 0;
              const dy = isActive ? Math.sin(a.mid) * 8 : 0;
              const lblPos = polar(cx, cy, rLabel, a.mid);
              return (
                <g
                  key={a.slice.key}
                  className="alloc-slice"
                  style={{
                    transform: `translate(${dx}px, ${dy}px)`,
                    opacity: dimmed ? 0.35 : 1,
                  }}
                  onMouseEnter={() => setHoverIdx(a.idx)}
                  onMouseLeave={() => setHoverIdx(null)}
                  onClick={() => setPinned(pinned === a.slice.key ? null : a.slice.key)}
                >
                  <path
                    d={wedgePath(cx, cy, rOuter, rInner, a.a0, a.a1)}
                    fill={a.slice.color}
                    stroke="var(--slice-stroke)"
                    strokeWidth={2.5}
                  >
                    <title>{`${sliceLabel(a.slice.key, a.slice.label)}: ${fmt(a.slice.valueBase)} (${a.pct.toFixed(1)}%)`}</title>
                  </path>
                  {a.pct >= 5 && (
                    <text
                      x={lblPos.x}
                      y={lblPos.y}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fill="#ffffff"
                      fontSize={a.pct >= 12 ? 12 : 10}
                      fontWeight={700}
                      pointerEvents="none"
                    >
                      {a.pct.toFixed(1)}%
                    </text>
                  )}
                </g>
              );
            })
          )}
        </svg>

        {mode === 'donut' && (
          <div className="alloc-center">
            <span className="alloc-center-sub">
              {activeSlice ? sliceLabel(activeSlice.key, activeSlice.label) : 'Total Value'}
            </span>
            <span className="alloc-center-val">
              {activeSlice ? fmt(activeSlice.valueBase) : fmt(total > 0 ? total : sum)}
            </span>
            <span className="alloc-center-tag">
              {activeSlice
                ? `${activePct!.toFixed(2)}% share`
                : `${usable.length} ${title ?? (usable.length === 1 ? 'bucket' : 'buckets')}`}
            </span>
          </div>
        )}
      </div>

      <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <span className="small muted">Click any slice or card to lock focus</span>
          {pinned && (
            <button
              type="button"
              className="link"
              style={{ fontSize: 12 }}
              onClick={() => setPinned(null)}
            >
              Reset Focus
            </button>
          )}
        </div>

        <div className="legend-grid-2">
          {usable.map((s, i) => {
            const pct = (s.valueBase / sum) * 100;
            const isOn = activeKey === s.key;
            return (
              <button
                key={s.key}
                type="button"
                className={`legend-card${isOn ? ' on' : ''}`}
                onMouseEnter={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx(null)}
                onClick={() => setPinned(pinned === s.key ? null : s.key)}
                aria-pressed={pinned === s.key}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <span className="legend-dot" style={{ background: s.color }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 650, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {sliceLabel(s.key, s.label)}
                    </div>
                    <div className="small muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(s.valueBase)}
                    </div>
                  </div>
                </div>
                <span style={{ fontSize: 13, fontWeight: 800, color: s.color, fontVariantNumeric: 'tabular-nums', flex: 'none' }}>
                  {pct.toFixed(2)}%
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
