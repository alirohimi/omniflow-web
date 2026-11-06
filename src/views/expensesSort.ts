// ============================================================================
// expensesSort — pure sort helper for the Expenses History list.
//
// Filtered rows (the `visible` set) are re-ordered for display ONLY; the
// filter pipeline itself is untouched. Default (untouched) behaviour is
// date-descending (newest first), matching the pre-Task 007 hardcoded sort.
// ============================================================================

import type { Expense } from '../domain/types';

export type SortKey = 'date' | 'amount' | 'merchant' | 'category';
export type SortDir = 'asc' | 'desc';

/**
 * Return a new array of `rows` sorted by `key` in `dir`.
 * - 'date':     by `timestamp` (epoch ms)
 * - 'amount':   by `baseAmount`
 * - 'merchant': case-insensitive locale compare of `merchant`
 * - 'category': case-insensitive locale compare of `category`
 *
 * Ties fall back to timestamp desc, then id asc, so output is stable
 * and deterministic regardless of input order.
 */
export function sortExpenses(rows: Expense[], key: SortKey, dir: 'asc' | 'desc'): Expense[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let c: number;
    switch (key) {
      case 'date':
        c = a.timestamp - b.timestamp;
        break;
      case 'amount':
        c = a.baseAmount - b.baseAmount;
        break;
      case 'merchant':
        c = a.merchant.localeCompare(b.merchant, undefined, { sensitivity: 'base' });
        break;
      case 'category':
        c = a.category.localeCompare(b.category, undefined, { sensitivity: 'base' });
        break;
    }
    if (c !== 0) return c * sign;
    // Stable, direction-independent tiebreak: newest first, then by id.
    c = b.timestamp - a.timestamp;
    if (c !== 0) return c;
    return a.id.localeCompare(b.id);
  });
}
