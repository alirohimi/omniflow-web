// ============================================================================
// OmniFlow — CSV export helpers.
// Pure, deterministic, $0. No DOM, no fetch. Safe to call from any view.
// ============================================================================

import type { Expense, InvestmentHolding, InvestmentAccount, Disposal } from '../domain/types';

/** RFC-4180-ish field quoting: wrap in double-quotes when the value
 *  contains a comma, double-quote, or newline; escape embedded quotes. */
function esc(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Download a string as a `.csv` file in the browser.
 *  Uses a Blob + object-URL so it works offline / in a PWA with no backend. */
export function downloadCsv(fileName: string, csvContent: string): void {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Expenses CSV: one row per expense, in base currency. */
export function expensesToCsv(expenses: Expense[]): string {
  const head = ['date', 'merchant', 'category', 'paymentMethod', 'currency', 'originalAmount', 'baseAmount', 'fxRate', 'note'];
  const lines = [head.join(',')];
  for (const e of [...expenses].sort((a, b) => b.timestamp - a.timestamp)) {
    lines.push(
      [
        new Date(e.timestamp).toISOString().slice(0, 10),
        esc(e.merchant),
        esc(e.category),
        e.paymentMethod,
        e.originalCurrency,
        e.originalAmount.toFixed(2),
        e.baseAmount.toFixed(2),
        e.fxRate,
        e.note ? esc(e.note) : '',
      ].join(','),
    );
  }
  return lines.join('\n');
}

/** Investments CSV: one row per holding, valued in base currency. */
export function holdingsToCsv(
  holdings: InvestmentHolding[],
  accounts: InvestmentAccount[],
): string {
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const head = ['symbol', 'assetClass', 'account', 'currency', 'units', 'averageEntryPrice', 'currentPriceLocal'];
  const lines = [head.join(',')];
  for (const h of holdings) {
    const acc = accountById.get(h.accountId);
    lines.push(
      [
        esc(h.symbol),
        h.assetClass,
        esc(acc?.platformName ?? 'unknown'),
        h.holdingCurrency,
        h.units.toFixed(4),
        h.averageEntryPrice.toFixed(2),
        h.currentPriceLocal.toFixed(4),
      ].join(','),
    );
  }
  return lines.join('\n');
}

/** Realized P&L CSV (delegates to the pure `pnlToCsv` engine). */
export { pnlToCsv } from '../insights/pnl';
