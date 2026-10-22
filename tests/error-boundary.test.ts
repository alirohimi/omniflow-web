// ============================================================================
// OmniFlow — ErrorBoundary contract tests (Task 009 P1 #6: the render guard
// that keeps "one tab broken" from becoming "whole shell dead" had no test).
//
// The suite runs in a plain node environment (vitest.config.ts: environment:
// 'node'), so we bring in happy-dom for exactly this one file and drive the
// boundary through React 18's real createRoot + act. A boundary is only
// proven by throwing through it: catch → labeled card → Retry remounts.
// ============================================================================

// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, '..', 'src', 'App.tsx'), 'utf8');
const boundarySrc = readFileSync(join(here, '..', 'src', 'components', 'ErrorBoundary.tsx'), 'utf8');

function mount(context: string, child: ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(ErrorBoundary, { context, children: child }));
  });
  return { container, root };
}

describe('ErrorBoundary — behavior contract', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders children normally when nothing throws', () => {
    const { container, root } = mount('Home', createElement('div', null, 'ok'));
    expect(container.textContent).toBe('ok');
    act(() => root.unmount());
  });

  it('catches a child render error and shows the labeled error card', () => {
    const Boom = () => {
      throw new Error('boom: intentional');
    };
    const { container, root } = mount('Expenses', createElement(Boom));
    expect(container.textContent).toContain('Something broke in the Expenses tab.');
    expect(container.textContent).toContain('Retry');
    expect(container.textContent).toContain('boom: intentional'); // the code line is visible
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it('Retry remounts the child fresh (stale internal state cleared)', () => {
    let shouldFail = true;
    const Flaky = () => {
      if (shouldFail) throw new Error('first pass');
      return createElement('div', null, 'recovered');
    };
    const { container, root } = mount('Coach', createElement(Flaky));
    expect(container.textContent).toContain('Something broke in the Coach tab.');
    const btn = container.querySelector('button');
    expect(btn?.textContent).toBe('Retry');
    shouldFail = false;
    act(() => {
      btn?.click();
    });
    expect(container.textContent).toContain('recovered');
    act(() => root.unmount());
  });
});

describe('ErrorBoundary — wiring contract (App.tsx)', () => {
  it('every one of the 5 tabs is wrapped in its own labeled boundary', () => {
    expect(appSrc).toContain('<ErrorBoundary context="Home"><DashboardView onOpenTab={setTab} /></ErrorBoundary>');
    expect(appSrc).toContain('<ErrorBoundary context="Expenses"><ExpensesView /></ErrorBoundary>');
    expect(appSrc).toContain('<ErrorBoundary context="Portfolio"><InvestmentsView /></ErrorBoundary>');
    expect(appSrc).toContain('<ErrorBoundary context="Coach"><CoachView /></ErrorBoundary>');
    expect(appSrc).toContain('<ErrorBoundary context="Settings"><SettingsView /></ErrorBoundary>');
  });

  it('the card shows context label + error message + Retry; errors are console-logged for diagnosis', () => {
    expect(boundarySrc).toContain('Something broke in the ${this.props.context} tab.');
    expect(boundarySrc).toContain('console.error');
    expect(boundarySrc).toMatch(/key=\{this\.state\.attempt\}/); // Retry remounts via key bump
    expect(boundarySrc).toContain('role="alert"');
  });
});
