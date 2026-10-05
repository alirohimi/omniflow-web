import type { Category, UserPreferences } from './types';

export const DEFAULT_PREFS: UserPreferences = {
  baseCurrency: 'MYR',
  displayName: 'you',
  llmProvider: 'none',
  llmKeyFinger: '',
  autoCategorize: true,
  advisorRules: true,
};

export const CATEGORIES: Category[] = [
  { id: 'c-food', name: 'Food & Dining', icon: '🍽' },
  { id: 'c-transport', name: 'Transport', icon: '🚗' },
  { id: 'c-shopping', name: 'Shopping', icon: '🛒' },
  { id: 'c-utilities', name: 'Utilities', icon: '💡' },
  { id: 'c-housing', name: 'Housing & Rent', icon: '🏠' },
  { id: 'c-health', name: 'Health & Beauty', icon: '🩺' },
  { id: 'c-entertainment', name: 'Entertainment', icon: '🎮' },
  { id: 'c-education', name: 'Education', icon: '📚' },
  { id: 'c-travel', name: 'Travel', icon: '✈️' },
  { id: 'c-groceries', name: 'Groceries', icon: '🛍️' },
  { id: 'c-investments', name: 'Investments', icon: '📈' },
  { id: 'c-income', name: 'Income', icon: '💵' },
  { id: 'c-other', name: 'Other', icon: '🧾' },
];

/** Commonly-supported ISO-4217 currencies with symbol for display.
 *  Frankfurter (ECB) supports all but JPY and a few exotica in practice. */
export interface CurrencyInfo {
  code: string;
  name: string;
  symbol: string;
}

export const CURRENCIES: CurrencyInfo[] = [
  { code: 'MYR', name: 'Malaysian Ringgit', symbol: 'RM' },
  { code: 'SGD', name: 'Singapore Dollar', symbol: 'S$' },
  { code: 'USD', name: 'US Dollar', symbol: '$' },
  { code: 'EUR', name: 'Euro', symbol: '€' },
  { code: 'GBP', name: 'British Pound', symbol: '£' },
  { code: 'JPY', name: 'Japanese Yen', symbol: '¥' },
  { code: 'AUD', name: 'Australian Dollar', symbol: 'A$' },
  { code: 'CAD', name: 'Canadian Dollar', symbol: 'C$' },
  { code: 'HKD', name: 'HK Dollar', symbol: 'HK$' },
  { code: 'CNY', name: 'Chinese Yuan', symbol: '¥' },
  { code: 'IDR', name: 'Indonesian Rupiah', symbol: 'Rp' },
  { code: 'THB', name: 'Thai Baht', symbol: '฿' },
  { code: 'PHP', name: 'Philippine Peso', symbol: '₱' },
  { code: 'VND', name: 'Vietnamese Dong', symbol: '₫' },
  { code: 'INR', name: 'Indian Rupee', symbol: '₹' },
  { code: 'KRW', name: 'South Korean Won', symbol: '₩' },
  { code: 'CHF', name: 'Swiss Franc', symbol: 'Fr' },
];

export function currencyInfo(code: string): CurrencyInfo {
  const c = CURRENCIES.find((x) => x.code === code);
  return c ?? { code, name: code, symbol: code };
}

export function formatMoney(
  value: number,
  code: string,
  opts: { locale?: string; decimals?: number } = {},
): string {
  const info = currencyInfo(code);
  const decimals =
    opts.decimals ??
    (code === 'JPY' || code === 'KRW' || code === 'VND' ? 0 : 2);
  try {
    return new Intl.NumberFormat(opts.locale ?? 'en-US', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);
  } catch {
    // Fall back to a manual symbol if Intl doesn't know the currency.
    return `${info.symbol}${value.toFixed(decimals)}`;
  }
}

export function uid(prefix = ''): string {
  const r =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return prefix ? `${prefix}-${r}` : r;
}
