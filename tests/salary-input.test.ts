import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Task 005 regression — "let the client input their salary so the
 * cashflow forecast uses real income, not the sparse logged Income rows".
 *
 * Source-reading convention (mirrors tests/expenses-filter.test.ts): assert
 * on the source contract rather than mounting the full VaultProvider +
 * services graph. The engine behavior itself (salary override, period
 * conversion, fallback) is covered in tests/insights.test.ts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), 'utf8');

const viewSrc = read('../src/views/DashboardView.tsx');
const storeSrc = read('../src/store/store.tsx');
const typesSrc = read('../src/domain/types.ts');
const forecastSrc = read('../src/insights/forecast.ts');

describe('salary input (Task 005)', () => {
  it('declares SalaryProfile as an optional vault entity (old blobs keep decrypting)', () => {
    expect(typesSrc).toMatch(/export interface SalaryProfile/);
    expect(typesSrc).toMatch(/amountPerMonth:\s*number/);
    expect(typesSrc).toMatch(/period:\s*SalaryPeriod/);
    // Optional on the VaultBlob so existing encrypted blobs survive.
    expect(typesSrc).toMatch(/salary\?:\s*SalaryProfile\s*\|\s*null/);
  });

  it('wires a setSalary store action through the persist path', () => {
    expect(storeSrc).toMatch(/const setSalary = useCallback/);
    // Persisted so a refresh mid-save loses nothing (same upsert path).
    expect(storeSrc).toMatch(/setVault\(\(prev\)[\s\S]*?prev, salary, updatedAt/);
    // Exported on the provider so views can call it.
    expect(storeSrc).toMatch(/setSalary/);
  });

  it('gives the client an input on the dashboard to declare their salary', () => {
    // The card renders a themed amount field + a period segmented control
    // (mobile-first; .field / .seg primitives, not bare native controls).
    expect(viewSrc).toMatch(/SalaryInputCard/);
    expect(viewSrc).toMatch(/<label className="field grow">/);
    expect(viewSrc).toMatch(/inputMode="decimal"/);
    expect(viewSrc).toMatch(/aria-label="Salary period"/);
    // Saving + removing are both reachable.
    expect(viewSrc).toMatch(/store\.setSalary\(/);
    expect(viewSrc).toMatch(/setSalary\(null\)/);
  });

  it('feeds the declared salary into the forecast as the authoritative income rate', () => {
    // The dashboard passes vault.salary as the 7th arg to forecastCashFlow.
    expect(viewSrc).toMatch(/forecastCashFlow\([\s\S]*?salary,\s*\)/);
    // The engine takes the optional salary param and overrides the logged
    // rate when present; the hero label reads "salary …/mo" when active.
    expect(forecastSrc).toMatch(/salary\?:\s*SalaryProfile\s*\|\s*null/);
    expect(forecastSrc).toMatch(/hasSalary\s*\?[\s\S]*?periodToMonthly\(salary\.amountPerMonth/);
    expect(viewSrc).toMatch(/salary \{sym\}\{forecast\.monthlyIncome/);
  });
});
