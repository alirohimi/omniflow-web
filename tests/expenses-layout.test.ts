// Task 012: Expenses view section spacing + control alignment.
//
// Source-reading convention (same as expenses-sort / expenses-filter): the
// layout contract is pinned against the source text so any regression to the
// tight 2px margins that produced the "sections too close" report is caught
// by CI rather than by eyeballing a screenshot.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const viewSrc = readFileSync(resolve(__dirname, '../src/views/ExpensesView.tsx'), 'utf8');
const themeSrc = readFileSync(resolve(__dirname, '../src/theme.css'), 'utf8');

const THEME = themeSrc;

describe('Task 012: section spacing + consistent control alignment (Expenses)', () => {
  it('opens up the gap between the breakdown section and the History cluster', () => {
    // The "History" overline now carries bottom margin so the sort row /
    // count row below it are not visually glued to it (pre-fix margin: 24px 2px 2px).
    const overline = /margin: 28px 2px 12px/.test(THEME) ? 'ok' : THEME.match(/\.section-title \{[^}]+\}/)?.[0] ?? 'missing .section-title block';
    expect(overline).toBe('ok');
    // The order-by row sits at a real gap from the section above it (pre-fix 2px).
    expect(THEME).toMatch(/\.hist-sort \{ margin-top: 8px; \}/);
    // The filter bar keeps an 8px-consistent gap above the rows below it
    // (pre-fix margin: 2px 0 10px).
    const filterMargin = /margin: 4px 0 12px/.test(THEME) ? 'ok' : THEME.match(/\.hist-filters \{[^}]+\}/)?.[0] ?? 'missing .hist-filters block';
    expect(filterMargin).toBe('ok');
  });

  it('keeps the mobile (<480px) rhythm in step with the widened web rhythm', () => {
    // Small-phone section-title top margin moved 20px -> 24px to match the
    // 28px desktop value (cards are tighter on phones, so the overline
    // still keeps breathing room without ballooning).
    expect(THEME).toMatch(/@media \(max-width: 480px\)/);
    expect(THEME).toMatch(/\.section-title \{ margin-top: 24px; \}/);
    // Regression gate: the OLD tight values must be gone.
    expect(THEME).not.toMatch(/\.section-title \{ margin-top: 20px; \}/);
    expect(THEME).not.toContain('margin: 24px 2px 2px');
    expect(THEME).not.toMatch(/\.hist-sort \{ margin-top: 2px; \}/);
  });

  it('aligns the history count row to the standard 8px row gap used across the view', () => {
    // Pre-fix the count row used marginBottom: 6 — an outlier vs the 8px
    // `.row + .row` gap that every other row in the view uses.
    expect(viewSrc).toMatch(/<div className="row muted small" style=\{\{ marginBottom: 8, justifyContent: 'space-between', alignItems: 'center' \}\}/);
    expect(viewSrc).not.toContain("marginBottom: 6, justifyContent: 'space-between'");
  });

  it('does not regress the Task 009 P1 touch-target contract (44px coarse-pointer rules)', () => {
    // These gates are also asserted in expenses-sort.test.ts — re-pinned here
    // so this task's edits can never silently drop them.
    expect(themeSrc).toMatch(/\.hist-sort \.seg button \{ min-height: 44px/);
    expect(themeSrc).toMatch(/\.hist-sort \.chip \{ min-height: 44px/);
    expect(themeSrc).toMatch(/\.selbar-toggle, \.selbar-clear, \.selbar-del \{ min-height: 44px/);
  });

  it('keeps the History cluster in the same render order the breakdown test pins', () => {
    // expenses-breakdown.test.ts requires section-title History to come after
    // the SpendingBreakdown JSX; the sort row must stay between the two.
    const breakdown = viewSrc.indexOf('<SpendingBreakdown');
    const sortRow = viewSrc.indexOf('<div className="row hist-sort"');
    const history = viewSrc.indexOf('<h2 className="section-title">History</h2>');
    expect(breakdown).toBeGreaterThan(-1);
    expect(sortRow).toBeGreaterThan(breakdown);
    expect(history).toBeGreaterThan(sortRow);
  });
});
