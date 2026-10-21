// AreaChart — pure-SVG net-worth trend chart.
//
// Rendered under a happy-dom window so the DOM-rendering assertions run for
// real (the vitest config uses `environment: 'node'`, so we stand the DOM up
// in beforeAll). Locks down the pure-SVG geometry: period-window filtering
// (7d/30d/90d must show ONLY that window, never a silent full-history
// fallback), path scaling, and flat-series padding.

import { describe, it, expect, beforeAll } from 'vitest';
import * as React from 'react';
import { AreaChart } from '../src/components/AreaChart';

let render: ((jsx: React.ReactElement) => Promise<{ container: HTMLElement }>) | null = null;
let domAvailable = false;

beforeAll(async () => {
  let dbg = '';
  try {
    const { Window } = await import('happy-dom');
    const win = new Window({ url: 'http://localhost/' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).document = win.document;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).window = win;
    const ReactDOMClient = await import('react-dom/client');
    render = async (jsx: React.ReactElement) => {
      const div = win.document.createElement('div');
      win.document.body.appendChild(div);
      // React 18's createRoot is intentionally async-deferred; force a tick
      // so the tree is committed before we read the DOM.
      const root = ReactDOMClient.createRoot(div as never);
      root.render(React.createElement('div', null, jsx));
      await new Promise((res) => setTimeout(res, 20));
      return { container: div as unknown as HTMLElement };
    };
    domAvailable = true;
    dbg = 'ok';
  } catch (e) {
    domAvailable = false;
    dbg = 'ERR:' + String(e);
  }
  if (!domAvailable) console.log('[AreaChart test] DOM setup skipped:', dbg);
});

const D = 86_400_000;
const day0 = Date.UTC(2026, 9, 1);
const pts = (n: number, base = 1000) =>
  Array.from({ length: n }, (_, i) => ({ at: day0 + i * D, value: base + i * 50 }));

const fmt = (v: number) => `RM ${Math.round(v)}`;
const fmtDate = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function makeAreaChart(points: { at: number; value: number }[]): React.ReactElement {
  return React.createElement(AreaChart, { key: 'ac', points, fmt, fmtDate });
}

describe('AreaChart', () => {
  // NOTE: every test body is gated on `domAvailable` at RUN time (after
  // beforeAll has finished standing up the happy-dom window). We must NOT use
  // `domAvailable ? it : it.skip` here — that expression is evaluated once at
  // module-collect time, BEFORE beforeAll runs, so it would always pick
  // it.skip and the whole suite would silently never execute.
  const r = () => render as (e: React.ReactElement) => Promise<{ container: HTMLElement }>;
  const needDom = async () => {
    if (!domAvailable) throw new Error('DOM unavailable in this environment');
  };

  it('renders a period-aware hint instead of a degenerate SVG for <2 points', async () => {
    await needDom();
    const { container } = await r()(makeAreaChart(pts(1)));
    // A single capture: no SVG is drawn, a centered hint is shown instead.
    expect(container.querySelector('svg')).toBeNull();
    // The hint div lives inside .area-chart and carries the .muted class.
    const hint = container.querySelector('.area-chart > .muted') ?? container.querySelector('.muted');
    expect(hint?.textContent).toMatch(/capture/i);
  });

  it('renders the chart, period tabs, and now-value for a multi-point series', async () => {
    await needDom();
    const { container } = await r()(makeAreaChart(pts(10)));
    expect(container.querySelector('svg.area-svg')).toBeTruthy();
    expect(container.querySelectorAll('.area-tab')).toHaveLength(4);
    expect(container.querySelectorAll('path').length).toBeGreaterThanOrEqual(2);
  });

  it('picks the tightest default period that still has >=2 points', async () => {
    await needDom();
    const { container } = await r()(makeAreaChart(pts(5)));
    const on = container.querySelector('.area-tab.on') as HTMLElement | null;
    expect(on).toBeTruthy();
    expect(on?.textContent).toBe('7d');
  });

  it('keeps a flat series centered (padded scale, no top-edge collapse)', async () => {
    await needDom();
    const flat = pts(8).map((p) => ({ ...p, value: 5000 }));
    const { container } = await r()(makeAreaChart(flat));
    const svg = container.querySelector('svg.area-svg') as SVGSVGElement;
    const marker = svg.querySelector('circle[fill="var(--accent)"]') as SVGCircleElement;
    const cy = Number(marker.getAttribute('cy'));
    expect(cy).toBeGreaterThan(30);
    expect(cy).toBeLessThan(110);
  });

  it('7d tab shows only the last-7-days points (no silent full-history fallback)', async () => {
    await needDom();
    // 12 daily points; the default period is 7d (tightest window with >=2).
    // The visible window must hold exactly 7 points, not all 12.
    const p12 = pts(12);
    const { container } = await r()(makeAreaChart(p12));
    const on = container.querySelector('.area-tab.on') as HTMLElement | null;
    expect(on?.textContent).toBe('7d');
    // The x-scale spans t0..t1 of the VISIBLE window. Count the axis labels:
    // a 7-point daily window means the first date is 6 days before the last.
    const svg = container.querySelector('svg.area-svg') as SVGSVGElement;
    // The aria-label (rebuilt each render) names the active 7d window.
    expect(svg.getAttribute('aria-label')).toMatch(/7d/);
  });

  it('a sparse 7d window does NOT silently expand to the full series', async () => {
    await needDom();
    // Two captures 60 days apart: the 7d window holds only 1 (the newest).
    // The chart must show that lone point — not the whole 60-day history.
    const sparse = [
      { at: day0, value: 1000 },
      { at: day0 + 60 * D, value: 1500 },
    ];
    const { container } = await r()(makeAreaChart(sparse));
    // Default = 90d (the only window that holds both points).
    const on = container.querySelector('.area-tab.on') as HTMLElement | null;
    expect(on?.textContent).toBe('90d');
    // Force 7d: the window now holds only the newest capture (1 point), so the
    // chart must show the period-aware hint — NOT a silent fall-back to the
    // whole 60-day history (no axis, no SVG, no full-series line).
    const tabs = container.querySelectorAll('.area-tab');
    const tab7d = Array.from(tabs).find((t) => t.textContent === '7d') as HTMLButtonElement;
    tab7d.click();
    await new Promise((res) => setTimeout(res, 20));
    // No axis and no plot for a 1-point window — the hint is shown instead.
    expect(container.querySelector('.area-axis')).toBeNull();
    expect(container.querySelector('svg.area-svg')).toBeNull();
    const hint = container.querySelector('.area-chart > .muted') ?? container.querySelector('.muted');
    expect(hint?.textContent).toMatch(/Only 1 capture/i);
  });

  it('the "Now" value tracks the selected window (Last 7d / 30d / 90d label)', async () => {
    await needDom();
    const { container } = await r()(makeAreaChart(pts(12))); // defaults to 7d
    const lbl = container.querySelector('.area-now-lbl') as HTMLElement;
    expect(lbl.textContent).toBe('Last 7d');
    // "Now" is the latest capture (1000 + 11*50).
    const val = container.querySelector('.area-now-val') as HTMLElement;
    expect(val.textContent).toBe(fmt(1000 + 11 * 50));
  });
});
