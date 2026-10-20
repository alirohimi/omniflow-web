// ============================================================================
// AreaChart — polished SVG area/line chart for the Home net-worth card.
//
// Replaces the old 48px strip-of-divs sparkline. Pure SVG (no chart lib):
//   - smooth cubic-bezier path through the points (Catmull-Rom -> Bezier),
//   - a soft vertical gradient fill under the line (accent-tinted, so it
//     glows on the dark-glass canvas instead of a flat grey bar),
//   - subtle baseline grid + min/max labels,
//   - a tappable scrubber: hover (fine pointer) or tap shows a floating
//     tooltip with the exact date + value, plus a highlighted dot,
//   - a leading period tab row (7d / 30d / 90d / All) so the user can zoom
//     the window; the line re-draws on change.
//
// NaN/short-series safe: fewer than 2 points renders an empty-state hint
// instead of a degenerate path, and a flat series (all equal) centers the
// line on the midline so it never sticks to the top or bottom edge.
// ============================================================================

import { useMemo, useState } from 'react';

export interface AreaChartPoint {
  /** epoch ms */
  at: number;
  /** value in base currency */
  value: number;
}

interface AreaChartProps {
  points: AreaChartPoint[];
  /** compact money formatter for the tooltip, e.g. "RM 12,400" */
  fmt: (v: number) => string;
  /** compact date formatter for axis + tooltip, e.g. "3 Oct" */
  fmtDate: (at: number) => string;
  /** height in px of the plot area (excludes label rows). */
  height?: number;
}

/** Period window options for the leading tabs. */
const PERIODS: { key: string; label: string; days: number | null }[] = [
  { key: '7d', label: '7d', days: 7 },
  { key: '30d', label: '30d', days: 30 },
  { key: '90d', label: '90d', days: 90 },
  { key: 'all', label: 'All', days: null },
];

/** Smooth Catmull-Rom -> cubic-bezier path through the points. */
function smoothPath(pts: [number, number][], tension = 0.8): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  const d: string[] = [`M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const cp1x = p1[0] + ((p2[0] - p0[0]) / 6) * tension;
    const cp1y = p1[1] + ((p2[1] - p0[1]) / 6) * tension;
    const cp2x = p2[0] - ((p3[0] - p1[0]) / 6) * tension;
    const cp2y = p2[1] - ((p3[1] - p1[1]) / 6) * tension;
    d.push(
      `C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`,
    );
  }
  return d.join(' ');
}

export function AreaChart({ points, fmt, fmtDate, height = 150 }: AreaChartProps) {
  const [period, setPeriod] = useState<string>(() => {
    // Default: the smallest (tightest) window that still holds >=2 points,
    // so fresh vaults with a few days of data open zoomed in, not flat.
    const n = points.length;
    if (n < 2) return 'all';
    const now = points[n - 1]?.at ?? Date.now();
    for (let i = 0; i < PERIODS.length; i++) {
      const days = PERIODS[i].days;
      if (days == null) return 'all';
      const win = points.filter((p) => p.at >= now - days * 86_400_000);
      if (win.length >= 2) return PERIODS[i].key;
    }
    return 'all';
  });
  const [active, setActive] = useState<number | null>(null);

  const W = 340; // intrinsic viewBox width; scales to the container width
  const PAD_L = 8, PAD_R = 8, PAD_T = 10, PAD_B = 18;

  // ---- visible window (respect the selected period tab) -------------------
  const visible = useMemo(() => {
    const def = PERIODS.find((p) => p.key === period);
    const days = def?.days;
    if (days == null) return points;
    const now = points[points.length - 1]?.at ?? Date.now();
    const win = points.filter((p) => p.at >= now - days * 86_400_000);
    return win.length >= 2 ? win : points;
  }, [points, period]);

  // ---- scale + geometry ----------------------------------------------------
  const geo = useMemo(() => {
    if (visible.length < 2) return null;
    const t0 = visible[0].at,
      t1 = visible[visible.length - 1].at;
    const span = Math.max(1, t1 - t0);
    const lo = Math.min(...visible.map((p) => p.value));
    const hi = Math.max(...visible.map((p) => p.value));
    const range = hi - lo;
    // A flat series (range 0) would collapse onto the top edge; pad so the
    // line sits centered instead.
    const pad = range === 0 ? Math.max(1, Math.abs(hi) * 0.1) : range * 0.15;
    const min = lo - pad,
      max = hi + pad;
    const x = (at: number) => PAD_L + ((at - t0) / span) * (W - PAD_L - PAD_R);
    const y = (v: number) => PAD_T + (1 - (v - min) / (max - min)) * (height - PAD_T - PAD_B);
    const pts = visible.map((p) => [x(p.at), y(p.value)] as [number, number]);
    return { t0, t1, min, max, x, y, pts, span };
  }, [visible, height]);

  // ---- scrubber: nearest point to a pointer x -----------------------------
  const pickNearest = (clientX: number, el: SVGSVGElement | null): number | null => {
    if (!el || !geo) return null;
    const r = el.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * W;
    let best = 0,
      bestD = Infinity;
    geo.pts.forEach(([pxi], i) => {
      const d = Math.abs(pxi - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };

  if (!geo) {
    return (
      <div className="muted small" style={{ padding: '14px 0', textAlign: 'center' }}>
        Not enough history yet — net worth is captured each time you visit Home.
      </div>
    );
  }

  const line = smoothPath(geo.pts);
  const area = `${line} L ${geo.pts[geo.pts.length - 1][0].toFixed(2)} ${height - PAD_B} L ${geo.pts[0][0].toFixed(2)} ${height - PAD_B} Z`;
  // Subtle baseline ticks (min / mid / max).
  const ticks = [geo.min, (geo.min + geo.max) / 2, geo.max];
  const ty = (v: number) => PAD_T + (1 - (v - geo.min) / (geo.max - geo.min)) * (height - PAD_T - PAD_B);
  const activeIdx = active != null && active < visible.length ? active : null;
  const ap = activeIdx != null ? geo.pts[activeIdx] : null;
  const last = geo.pts[geo.pts.length - 1];
  const lastPoint = visible[visible.length - 1];

  return (
    <div className="area-chart">
      {/* Period tabs + latest value, inline. */}
      <div className="area-head">
        <div className="area-tabs" role="tablist" aria-label="Chart period">
          {PERIODS.map((p) => {
            const def = p.key === period;
            const days = p.days;
            const count =
              days == null
                ? points.length
                : points.filter((x) => x.at >= (points[points.length - 1]?.at ?? 0) - days * 86_400_000).length;
            const usable = count >= 2;
            return (
              <button
                key={p.key}
                role="tab"
                aria-selected={def}
                className={`area-tab${def ? ' on' : ''}`}
                disabled={!usable}
                onClick={() => {
                  setPeriod(p.key);
                  setActive(null);
                }}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        <div className="area-now">
          <span className="area-now-lbl">Now</span>
          <span className="area-now-val">{fmt(lastPoint?.value ?? 0)}</span>
        </div>
      </div>

      {/* The SVG plot. */}
      <svg
        className="area-svg"
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Net worth ${PERIODS.find((p) => p.key === period)?.label ?? 'All'}: ${fmt(visible[0].value)} to ${fmt(visible[visible.length - 1].value)}`}
        onMouseMove={(e) => setActive(pickNearest(e.clientX, e.currentTarget))}
        onMouseLeave={() => setActive(null)}
        onTouchStart={(e) => {
          const t = e.touches[0];
          if (t) setActive(pickNearest(t.clientX, e.currentTarget));
        }}
        onTouchMove={(e) => {
          const t = e.touches[0];
          if (t) setActive(pickNearest(t.clientX, e.currentTarget));
        }}
        style={{ width: '100%', display: 'block', overflow: 'visible' }}
      >
        <defs>
          <linearGradient id="ac-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.38" />
            <stop offset="55%" stopColor="var(--accent-2)" stopOpacity="0.14" />
            <stop offset="100%" stopColor="var(--accent-2)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="ac-stroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--accent)" />
            <stop offset="100%" stopColor="var(--accent-2)" />
          </linearGradient>
        </defs>

        {/* baseline grid ticks */}
        {ticks.map((v, i) => (
          <g key={i} opacity={0.5}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={ty(v)}
              y2={ty(v)}
              stroke="var(--line)"
              strokeWidth={1}
              strokeDasharray={i === 1 ? '3 4' : undefined}
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={W - PAD_R}
              y={ty(v) - 3}
              textAnchor="end"
              fontSize={8.5}
              fill="var(--faint)"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {fmt(v)}
            </text>
          </g>
        ))}

        {/* area fill under the line */}
        <path d={area} fill="url(#ac-fill)" />

        {/* the line (re-draws when the period window changes) */}
        <path
          key={period}
          d={line}
          fill="none"
          stroke="url(#ac-stroke)"
          strokeWidth={2.25}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="ac-line"
          vectorEffect="non-scaling-stroke"
        />

        {/* end-of-line marker */}
        <circle cx={last[0]} cy={last[1]} r={3} fill="var(--accent)" stroke="var(--bg)" strokeWidth={1.5} />

        {/* scrubber highlight */}
        {ap && activeIdx != null && (
          <g>
            <line
              x1={ap[0]}
              x2={ap[0]}
              y1={PAD_T}
              y2={height - PAD_B}
              stroke="var(--line-2)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={ap[0]} cy={ap[1]} r={4} fill="var(--accent)" stroke="#fff" strokeWidth={1.5} />
          </g>
        )}
      </svg>

      {/* date labels: first / mid / last of the visible window */}
      <div className="area-axis">
        <span>{fmtDate(geo.t0)}</span>
        <span>{fmtDate((geo.t0 + geo.t1) / 2)}</span>
        <span>{fmtDate(geo.t1)}</span>
      </div>

      {/* floating tooltip (reads the hovered point) */}
      {ap && activeIdx != null && (
        <div className="area-tip" style={{ left: `${(ap[0] / W) * 100}%` }} role="status">
          <div className="tip-val">{fmt(visible[activeIdx].value)}</div>
          <div className="tip-date">{fmtDate(visible[activeIdx].at)}</div>
        </div>
      )}
    </div>
  );
}
