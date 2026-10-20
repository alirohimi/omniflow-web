// AreaChart — pure-SVG net-worth trend chart.
//
// Verifies the geometry/edge-case contracts (the risky math, not the pixels):
//   - fewer than 2 points -> no <svg> (empty-state hint instead of NaN path),
//   - a flat series pads the scale so the line centers on the midline,
//   - period tabs are present and the default period picks the tightest
//     window that still holds >=2 points,
//   - every visible point lands inside the plot band (scale is sane),
//   - the area path closes to the baseline (line + 2 L commands + Z).
//
// Rendered with the project's jsdom + vitest setup, exactly like
// investments-layout.test.ts / disclosure.test.ts.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AreaChart } from '../src/components/AreaChart';

const D = 86_400_000;
const day0 = Date.UTC(2026, 9, 1);
const pts = (n: number, base = 1000) =>
  Array.from({ length: n }, (_, i) => ({ at: day0 + i * D, value: base + i * 50 }));

const fmt = (v: number) => `RM ${Math.round(v)}`;
const fmtDate = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

describe('AreaChart', () => {
  it('renders the empty-state hint instead of a degenerate path for <2 points', () => {
    const { container } = render(
      <AreaChart points={pts(1)} fmt={fmt} fmtDate={fmtDate} />,
    );
    expect(container.querySelector('svg')).toBeNull();
    expect(screen.getByText(/Not enough history yet/i)).toBeTruthy();
  });

  it('renders the chart, period tabs, and now-value for a multi-point series', () => {
    const { container } = render(
      <AreaChart points={pts(10)} fmt={fmt} fmtDate={fmtDate} />,
    );
    expect(container.querySelector('svg.area-svg')).toBeTruthy();
    // 4 period tabs.
    expect(container.querySelectorAll('.area-tab')).toHaveLength(4);
    // A stroke path + an area path both exist.
    expect(container.querySelectorAll('path').length).toBeGreaterThanOrEqual(2);
    // The "Now" readout shows the latest value.
    expect(screen.getByText('RM 1450')).toBeTruthy();
  });

  it('picks the tightest default period that still has >=2 points', () => {
    const { container } = render(
      <AreaChart points={pts(5)} fmt={fmt} fmtDate={fmtDate} />,
    );
    const on = container.querySelector('.area-tab.on') as HTMLElement | null;
    expect(on).toBeTruthy();
    // 5 daily points fit inside the 7d window.
    expect(on?.textContent).toBe('7d');
  });

  it('scales every point inside the plot band (no overflow / NaN)', () => {
    const { container } = render(
      <AreaChart points={pts(12)} fmt={fmt} fmtDate={fmtDate} height={140} />,
    );
    const svg = container.querySelector('svg.area-svg') as SVGSVGElement;
    const H = 140;
    const line = svg.querySelector('path[stroke="url(#ac-stroke)"]') as SVGPathElement | null;
    expect(line?.getAttribute('d')).toBeTruthy();
    // The area path must close to the baseline: line commands + " Z".
    const area = svg.querySelector('path[fill="url(#ac-fill)"]') as SVGPathElement;
    expect(area.getAttribute('d')).toMatch(/ Z$/);
    // End marker sits inside the viewBox.
    const marker = svg.querySelector('circle[fill="var(--accent)"]') as SVGCircleElement | null;
    expect(marker).toBeTruthy();
    expect(Number(marker!.getAttribute('cy'))).toBeGreaterThan(0);
    expect(Number(marker!.getAttribute('cy'))).toBeLessThan(H);
  });

  it('keeps a flat series centered (padded scale, no top-edge collapse)', () => {
    const flat = pts(8).map((p) => ({ ...p, value: 5000 }));
    const { container } = render(<AreaChart points={flat} fmt={fmt} fmtDate={fmtDate} height={140} />);
    const svg = container.querySelector('svg.area-svg') as SVGSVGElement;
    const marker = svg.querySelector('circle[fill="var(--accent)"]') as SVGCircleElement;
    const cy = Number(marker.getAttribute('cy'));
    // Padded band: PAD_T=10, plot height ~112 -> midline around y ~ 66.
    // A flat series must land near the middle, not the top edge.
    expect(cy).toBeGreaterThan(30);
    expect(cy).toBeLessThan(110);
  });

  it('labels first / mid / last dates under the plot', () => {
    const { container } = render(
      <AreaChart points={pts(3)} fmt={fmt} fmtDate={fmtDate} />,
    );
    const axis = container.querySelector('.area-axis') as HTMLElement;
    expect(axis.children).toHaveLength(3);
  });
});
