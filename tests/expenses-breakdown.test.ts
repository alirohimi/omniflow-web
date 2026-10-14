import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Regression guard: the Expenses tab must surface a real "Spending breakdown"
 * card — selectable window, per-category distribution bars, a 14-day trend
 * strip, payment-method split, top merchants, and budget-vs-cap bars — and
 * not fall back to a native select / bare table that broke on phones.
 */

const here = dirname(fileURLToPath(new URL(import.meta.url)));
const compSrc = readFileSync(join(here, '..', 'src', 'components', 'SpendingBreakdown.tsx'), 'utf8');
const viewSrc = readFileSync(join(here, '..', 'src', 'views', 'ExpensesView.tsx'), 'utf8');
const themeSrc = readFileSync(join(here, '..', 'src', 'theme.css'), 'utf8');

describe('ExpensesView spending-breakdown card', () => {
  it('mounts the SpendingBreakdown component between the capture card and History', () => {
    expect(viewSrc).toContain("import { SpendingBreakdown } from '../components/SpendingBreakdown'");
    expect(viewSrc).toMatch(/<SpendingBreakdown[\s\S]*expenses=\{vault\.expenses\}[\s\S]*budgets=\{vault\.budgets \?\? \[\]\}[\s\S]*baseCurrency=\{base\}/);
    // The capture/imports block closes before the breakdown, and History follows it.
    const idx = viewSrc.indexOf('<SpendingBreakdown');
    expect(idx).toBeGreaterThan(-1);
    expect(viewSrc.indexOf('<h2 className="section-title">History</h2>')).toBeGreaterThan(idx);
  });

  it('is a self-contained component: owns the window selector and all aggregation', () => {
    expect(compSrc).toMatch(/const \[period, setPeriod\] = useState<Period>\('30d'\)/);
    expect(compSrc).toContain("spendingBreakdown(expenses, windowFor(period), Date.now()");
    // No native <select> control — the window picker is a themed segmented control.
    expect(compSrc).not.toContain('<select');
    expect(compSrc).toMatch(/className="seg"/);
  });

  it('renders every aggregation dimension the engine produces', () => {
    expect(compSrc).toContain('data.byCategory');
    expect(compSrc).toContain('data.byPayment');
    expect(compSrc).toContain('data.topMerchants');
    expect(compSrc).toContain('data.trend');
    expect(compSrc).toContain('data.budgets');
  });

  it('maps budget status to the themed track state (watch=warn, over=bad)', () => {
    expect(compSrc).toMatch(/l\.status === 'over' \? 'bad' : l\.status === 'watch' \? 'warn' : ''/);
  });

  it('styles the breakdown with scoped .bd-* classes on the shared glass tokens', () => {
    expect(themeSrc).toContain('.bd-cat');
    expect(themeSrc).toContain('.bd-track');
    expect(themeSrc).toContain('.bd-trend');
    expect(themeSrc).toContain('.bd-pay');
    expect(themeSrc).toContain('.bd-h');
    // warn/bad track fills reuse the theme danger tokens.
    expect(themeSrc).toMatch(/\.bd-track > i\.warn/);
    expect(themeSrc).toMatch(/\.bd-track > i\.bad/);
  });
});
