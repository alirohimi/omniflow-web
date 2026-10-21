import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Task 003 regression guard: the Expenses History section must display ALL
 * transactions (no silent 60-row truncation), expose a search box and
 * filter controls (type / date-range / category), mark income rows as
 * credits, and let "Select all" operate on the visible (filtered) set.
 *
 * This file uses the same source-reading convention as
 * expenses-breakdown.test.ts: the suite validates structure + contract of
 * the view source rather than mounting the full app (the view pulls in the
 * whole store + services graph, and the filter logic is pure and testable
 * by reading the render contract).
 */

const here = dirname(fileURLToPath(new URL(import.meta.url)));
const viewSrc = readFileSync(join(here, '..', 'src', 'views', 'ExpensesView.tsx'), 'utf8');
const iconSrc = readFileSync(join(here, '..', 'src', 'icons.tsx'), 'utf8');
const themeSrc = readFileSync(join(here, '..', 'src', 'theme.css'), 'utf8');

describe('Task 003: Expenses History — show-all + filter & search', () => {
  it('renders the full transaction list (no .slice(0, 60) cap)', () => {
    // The previous behavior capped the list at the 60 most-recent rows,
    // which hid older expenses (the reported RM4500 row) from view.
    expect(viewSrc).not.toContain('sorted.slice(0, 60)');
    expect(viewSrc).toMatch(/visible\.map\(\(e\) =>/);
    // Guard: `sorted` is still defined (the data source), but the list is
    // driven by `visible` (the filtered set).
    expect(viewSrc).toContain('const visible = useMemo');
    expect(viewSrc).toMatch(/<div className="list">/);
  });

  it('shows a "Showing X of Y" count when filters are active, and a "clear filters" affordance', () => {
    expect(viewSrc).toMatch(/Showing \$\{visible\.length\} of \$\{sorted\.length\}/);
    expect(viewSrc).toContain('clearFilters');
    expect(viewSrc).toMatch(/className="hist-clear"/);
  });

  it('adds a themed search box that matches merchant, note, category, payment method and currency', () => {
    expect(viewSrc).toContain('setQ');
    // Case-insensitive substring match across the searchable fields.
    expect(viewSrc).toMatch(/const needle = q\.trim\(\)\.toLowerCase\(\)/);
    // The searchable haystack is built from five fields joined by newlines
    // (one field per line) so the source stays readable.
    expect(viewSrc).toMatch(/e\.merchant[\s\S]*?e\.note[\s\S]*?e\.category[\s\S]*?e\.paymentMethod[\s\S]*?e\.originalCurrency/);
    // The magnifier icon is imported + rendered.
    expect(viewSrc).toContain('ISearch');
    expect(iconSrc).toMatch(/export const ISearch = \(p: P\)/);
    // Themed input, never a bare native one.
    expect(viewSrc).toMatch(/className="field hist-search"/);
  });

  it('adds a type filter (All / Expenses / Income) as a themed segmented control', () => {
    expect(viewSrc).toMatch(/typeF === 'income' \? e\.category !== 'Income' : typeF === 'expense' \? e\.category === 'Income'/);
    expect(viewSrc).toContain("'Expenses'");
    expect(viewSrc).toContain("'Income'");
    // Reuses the .seg control (no native select).
    expect(viewSrc).toMatch(/aria-label="Type"/);
    expect(viewSrc).not.toMatch(/<select[\s\S]{0,80}typeF/);
  });

  it('adds a date-range filter (All time / This month / 30d / 90d)', () => {
    expect(viewSrc).toMatch(/rangeF === 'month'/);
    expect(viewSrc).toMatch(/rangeF === '30d'/);
    expect(viewSrc).toMatch(/rangeF === '90d'/);
    expect(viewSrc).toContain('This month');
  });

  it('adds a category chip strip built from the categories actually present in the vault', () => {
    expect(viewSrc).toMatch(/catOptions = useMemo/);
    expect(viewSrc).toMatch(/className="hist-cats"/);
    // Chips render per-category + an "All categories" reset chip.
    expect(viewSrc).toContain('All categories');
    expect(viewSrc).toMatch(/catF === c \? ' on' : ''/);
  });

  it('composes all filters with AND logic (range + type + category + search)', () => {
    // All four predicates live in the single `visible` memo.
    const visibleBlock = viewSrc.slice(
      viewSrc.indexOf('const visible = useMemo'),
      viewSrc.indexOf('}, [sorted, q, catF, rangeF, typeF, rangeStart]);'),
    );
    expect(visibleBlock).toContain('rangeStart');
    expect(visibleBlock).toContain("typeF");
    expect(visibleBlock).toContain('catF');
    expect(visibleBlock).toContain('needle');
  });

  it('marks income rows as credits (+ prefix, green tint) and shows an income indicator', () => {
    expect(viewSrc).toMatch(/const isIncome = e\.category === 'Income'/);
    expect(viewSrc).toMatch(/className="hist-inc"/);
    expect(viewSrc).toMatch(/className=\{`amt\$\{isIncome \? ' income' : ''\}`\}/);
  });

  it('"Select all" selects the visible (filtered) rows, not the full list', () => {
    expect(viewSrc).toMatch(/allVisiblePicked =/);
    expect(viewSrc).toMatch(/new Set\(visible\.map\(\(e\) => e\.id\)\)/);
    // The stale comment about "first 60 rows" should be gone (the cap is removed).
    expect(viewSrc).not.toContain('first 60 rows');
  });

  it('styles the new filter bar with scoped .hist-* classes on the shared glass tokens', () => {
    for (const cls of [
      '.hist-filters', '.hist-search', '.hist-cats', '.hist-clear', '.hist-inc',
      '.item .amt.income',
    ]) {
      expect(themeSrc).toContain(cls);
    }
    // Coarse-pointer touch targets >= 44px (user standing pref).
    expect(themeSrc).toMatch(/@media \(pointer: coarse\) \{[\s\S]*?\.hist-cats \.chip \{ min-height: 44px;/);
  });

  it('shows a distinct empty state when filters exclude every row', () => {
    expect(viewSrc).toMatch(/visible\.length === 0 && sorted\.length > 0/);
    expect(viewSrc).toContain('No transactions match your search / filters');
  });
});
