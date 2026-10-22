import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sortExpenses } from '../src/views/expensesSort';
import type { Expense } from '../src/domain/types';

/**
 * Task 007 regression guard: the Expenses History list must expose a
 * themed order-by / sort control (date / amount / merchant / category,
 * with direction toggle) that composes with the existing filter
 * pipeline (filter first, sort the visible set second) and keeps the
 * default newest-first ordering when untouched.
 *
 * Two-part guard, mirroring the sibling tests/expenses-filter.test.ts
 * convention:
 *  1. Source-reading contract assertions on ExpensesView.tsx /
 *     theme.css (structure: the control exists, uses the .seg/.chip
 *     themed primitives, is unconditionally discoverable, wires into the
 *     visible pipeline).
 *  2. Direct unit tests of the pure sortExpenses() helper on synthetic
 *     rows — no DOM, no store, deterministic.
 */

const here = dirname(fileURLToPath(new URL(import.meta.url)));
const viewSrc = readFileSync(join(here, '..', 'src', 'views', 'ExpensesView.tsx'), 'utf8');
const themeSrc = readFileSync(join(here, '..', 'src', 'theme.css'), 'utf8');

function exp(partial: Partial<Expense> & Pick<Expense, 'id' | 'merchant' | 'category'>): Expense {
  return {
    originalAmount: 10,
    originalCurrency: 'MYR',
    fxRate: 1,
    baseAmount: 10,
    paymentMethod: 'card',
    aiTier: 'dictionary',
    source: 'manual',
    timestamp: 1_000_000,
    ...partial,
  } as Expense;
}

describe('Task 007: Expenses History — order-by / sort control', () => {
  it('renders the order-by control UNCONDITIONALLY — discoverable in the default no-filter state, not trapped behind the collapsible filter bar', () => {
    // P1 regression guard: pre-fix the .hist-sort row was nested inside
    // `{(filtersOpen || filtersActive) && (...)}`, so with no filter
    // active (the default resting state) the sort control was completely
    // hidden and undiscoverable on mobile. It must now render on its own,
    // gated only on whether there are any expenses at all.
    expect(viewSrc).toMatch(/\{sorted\.length > 0 && \(\s*<div className="row hist-sort"/);
    // And the `.hist-sort` div must NOT appear anywhere at or after the
    // filter-bar conditional block's opening — it is a standalone sibling
    // rendered before that block, not a child of it.
    const conditionalOpen = viewSrc.indexOf('{(filtersOpen || filtersActive) && (');
    expect(conditionalOpen).toBeGreaterThan(-1);
    expect(viewSrc.slice(conditionalOpen)).not.toContain('row hist-sort');
  });

  it('adds a themed order-by key group (date / amount / merchant / category) with a per-key direction toggle, using only existing themed primitives', () => {
    expect(viewSrc).toMatch(/aria-label="Order by"/);
    expect(viewSrc).toContain("'Date'");
    expect(viewSrc).toContain("'Amount'");
    expect(viewSrc).toContain("'Merchant'");
    expect(viewSrc).toContain("'Category'");
    // Direction toggle is a themed chip, never a native control.
    expect(viewSrc).toMatch(/className={`chip sm\$\{sortDir === 'asc' \? ' on' : ''\}`/);
    // Per-key direction labels (a constant "A→Z · oldest · low" label was
    // misleading for the date/amount/category keys — each key now has its
    // own asc/desc wording).
    expect(viewSrc).toContain("date: { desc: 'Newest first', asc: 'Oldest first' }");
    expect(viewSrc).toContain("amount: { desc: 'High to low', asc: 'Low to high' }");
    expect(viewSrc).toContain("merchant: { desc: 'Z → A', asc: 'A → Z' }");
    expect(viewSrc).toContain("category: { desc: 'Z → A', asc: 'A → Z' }");
    expect(viewSrc).toMatch(/\{DIR_LABELS\[sortKey\]\[sortDir\]\}/);
    // The ORDER-BY control block itself (the .hist-sort row: its .seg key
    // group + its .chip direction toggle, ~60 lines) must not contain a
    // native <select>. Anchor on the JSX opening tag — NOT on the
    // "hist-sort" string, which also appears in a comment a few lines above.
    const sortBlock = viewSrc.slice(
      viewSrc.indexOf('<div className="row hist-sort"'),
      viewSrc.indexOf('<div className="row hist-sort"') + 3000,
    );
    expect(sortBlock).toContain('aria-label="Order by"');
    expect(sortBlock).not.toContain('<select');
  });

  it('wires the sort into the filter pipeline AFTER filtering (filter first, then sort the visible set)', () => {
    // The visible set is the filtered pipeline; sorting applies to it.
    expect(viewSrc).toMatch(/sortExpenses\(filtered, sortKey, sortDir\)/);
    // The session-only sort state defaults to date-desc (newest first),
    // preserving the pre-Task-007 hardcoded ordering when untouched.
    expect(viewSrc).toMatch(/useState<SortKeyT>\('date'\)/);
    expect(viewSrc).toMatch(/useState<SortDir>\('desc'\)/);
    // Tapping the currently-selected key toggles its direction.
    expect(viewSrc).toMatch(/if \(sortKey === id\) \{/);
  });

  it('themed control styling: coarse-pointer touch targets >= 44px in theme.css', () => {
    expect(themeSrc).toMatch(/\.hist-sort/);
    expect(themeSrc).toMatch(/\.hist-sort \.seg button \{ min-height: 44px/);
    expect(themeSrc).toMatch(/\.hist-sort \.chip \{ min-height: 44px/);
  });

  // ---- Direct unit tests of the pure helper ----------------------------

  it('sortExpenses: date key — desc is newest-first, asc is oldest-first', () => {
    const rows = [
      exp({ id: 'a', merchant: 'X', category: 'C', timestamp: 300 }),
      exp({ id: 'b', merchant: 'Y', category: 'C', timestamp: 100 }),
      exp({ id: 'c', merchant: 'Z', category: 'C', timestamp: 200 }),
    ];
    expect(sortExpenses(rows, 'date', 'desc').map((e) => e.id)).toEqual(['a', 'c', 'b']);
    expect(sortExpenses(rows, 'date', 'asc').map((e) => e.id)).toEqual(['b', 'c', 'a']);
  });

  it('sortExpenses: amount key — desc is high-first, asc is low-first', () => {
    const rows = [
      exp({ id: 'a', merchant: 'X', category: 'C', baseAmount: 50 }),
      exp({ id: 'b', merchant: 'Y', category: 'C', baseAmount: 10 }),
      exp({ id: 'c', merchant: 'Z', category: 'C', baseAmount: 90 }),
    ];
    expect(sortExpenses(rows, 'amount', 'desc').map((e) => e.id)).toEqual(['c', 'a', 'b']);
    expect(sortExpenses(rows, 'amount', 'asc').map((e) => e.id)).toEqual(['b', 'a', 'c']);
  });

  it('sortExpenses: merchant key — case-insensitive A-Z / Z-A', () => {
    const rows = [
      exp({ id: 'a', merchant: 'banana', category: 'C', timestamp: 300 }),
      exp({ id: 'b', merchant: 'Apple', category: 'C', timestamp: 100 }),
      exp({ id: 'c', merchant: 'cherry', category: 'C', timestamp: 200 }),
    ];
    expect(sortExpenses(rows, 'merchant', 'asc').map((e) => e.id)).toEqual(['b', 'a', 'c']);
    expect(sortExpenses(rows, 'merchant', 'desc').map((e) => e.id)).toEqual(['c', 'a', 'b']);
  });

  it('sortExpenses: category key — case-insensitive, ties fall back to newest-first', () => {
    const rows = [
      exp({ id: 'a', merchant: 'X', category: 'Groceries', timestamp: 300 }),
      exp({ id: 'b', merchant: 'Y', category: 'Dining', timestamp: 100 }),
      exp({ id: 'c', merchant: 'Z', category: 'groceries', timestamp: 200 }),
      exp({ id: 'd', merchant: 'W', category: 'dining', timestamp: 250 }),
    ];
    // 'asc': Dining/dining before Groceries/groceries; within a category,
    // the newer timestamp comes first (the stable tiebreak).
    // Dining: d(250) before b(100); Groceries: a(300) before c(200).
    expect(sortExpenses(rows, 'category', 'asc').map((e) => e.id)).toEqual(['d', 'b', 'a', 'c']);
    // 'desc': Groceries group first (a:300, c:200), then Dining (d:250, b:100).
    expect(sortExpenses(rows, 'category', 'desc').map((e) => e.id)).toEqual(['a', 'c', 'd', 'b']);
  });

  it('sortExpenses does not mutate the input array', () => {
    const rows = [
      exp({ id: 'a', merchant: 'X', category: 'C', timestamp: 300 }),
      exp({ id: 'b', merchant: 'Y', category: 'C', timestamp: 100 }),
    ];
    const original = [...rows];
    sortExpenses(rows, 'date', 'asc');
    expect(rows.map((e) => e.id)).toEqual(original.map((e) => e.id));
  });
});
