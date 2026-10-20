// AreaChart — pure-SVG net-worth trend chart.
//
// Written in plain .ts (not .tsx) so it type-checks under the repo's
// `tsc -b` project build without needing @testing-library/react in the
// type graph. DOM rendering is done via dynamic imports and is skipped
// automatically when the test environment has no `document` (node env).

import { describe, it, expect, beforeAll } from 'vitest';
import { AreaChart } from '../src/components/AreaChart';
import type { ReactNode } from 'react';

let render: ((jsx: ReactNode) => Promise<{ container: HTMLElement }>) | null = null;
let domAvailable = false;

beforeAll(async () => {
  if (typeof document === 'undefined') return;
  try {
    const ReactNS = await import('react');
    const ReactDOMClient = await import('react-dom/client');
    const createElement: (a: unknown, b: unknown, c: unknown) => ReactNode = ReactNS.createElement as never;
    render = async (jsx: ReactNode) => {
      const div = document.createElement('div');
      document.body.appendChild(div);
      const root = ReactDOMClient.createRoot(div);
      root.render(createElement('div', null, jsx));
      await new Promise((r) => setTimeout(r, 0));
      return { container: div };
    };
    domAvailable = true;
  } catch {
    domAvailable = false;
  }
});

const D = 86_400_000;
const day0 = Date.UTC(2026, 9, 1);
const pts = (n: number, base = 1000) =>
  Array.from({ length: n }, (_, i) => ({ at: day0 + i * D, value: base + i * 50 }));

const fmt = (v: number) => `RM ${Math.round(v)}`;
const fmtDate = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function makeAreaChart(points: { at: number; value: number }[]): ReactNode {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const React = require('react');
  return React.createElement(AreaChart, { key: 'ac', points, fmt, fmtDate });
}

describe('AreaChart', () => {
  const maybe = domAvailable ? it : it.skip;
  const r = () => render as (e: ReactNode) => Promise<{ container: HTMLElement }>;

  maybe('renders the empty-state hint instead of a degenerate path for <2 points', async () => {
    const { container } = await r()(makeAreaChart(pts(1)));
    expect(container.querySelector('svg')).toBeNull();
  });

  maybe('renders the chart, period tabs, and now-value for a multi-point series', async () => {
    const { container } = await r()(makeAreaChart(pts(10)));
    expect(container.querySelector('svg.area-svg')).toBeTruthy();
    expect(container.querySelectorAll('.area-tab')).toHaveLength(4);
    expect(container.querySelectorAll('path').length).toBeGreaterThanOrEqual(2);
  });

  maybe('picks the tightest default period that still has >=2 points', async () => {
    const { container } = await r()(makeAreaChart(pts(5)));
    const on = container.querySelector('.area-tab.on') as HTMLElement | null;
    expect(on).toBeTruthy();
    expect(on?.textContent).toBe('7d');
  });

  maybe('scales every point inside the plot band (no overflow / NaN)', async () => {
    const { container } = await r()(makeAreaChart(pts(12)));
    const svg = container.querySelector('svg.area-svg') as SVGSVGElement;
    const line = svg.querySelector('path[stroke="url(#ac-stroke)"]') as SVGPathElement | null;
    expect(line?.getAttribute('d')).toBeTruthy();
    const area = svg.querySelector('path[fill="url(#ac-fill)"]') as SVGPathElement;
    expect(area.getAttribute('d')).toMatch(/ Z$/);
  });

  maybe('keeps a flat series centered (padded scale, no top-edge collapse)', async () => {
    const flat = pts(8).map((p) => ({ ...p, value: 5000 }));
    const { container } = await r()(makeAreaChart(flat));
    const svg = container.querySelector('svg.area-svg') as SVGSVGElement;
    const marker = svg.querySelector('circle[fill="var(--accent)"]') as SVGCircleElement;
    const cy = Number(marker.getAttribute('cy'));
    expect(cy).toBeGreaterThan(30);
    expect(cy).toBeLessThan(110);
  });

  maybe('labels first / mid / last dates under the plot', async () => {
    const { container } = await r()(makeAreaChart(pts(3)));
    const axis = container.querySelector('.area-axis') as HTMLElement;
    expect(axis.children).toHaveLength(3);
  });
});
