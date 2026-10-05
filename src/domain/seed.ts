import type {
  Category,
  Expense,
  InvestmentAccount,
  InvestmentHolding,
  UserPreferences,
  VaultBlob,
} from './types';
import { DEFAULT_PREFS, CATEGORIES } from './enums';

/** Fresh, empty vault (used on first launch before any data is entered). */
export function emptyVault(prefs?: Partial<UserPreferences>): VaultBlob {
  const now = Date.now();
  return {
    schema: 1,
    createdAt: now,
    updatedAt: now,
    expenses: [],
    categories: CATEGORIES,
    accounts: [],
    holdings: [],
    prefs: { ...DEFAULT_PREFS, ...prefs },
    llmKey: '',
  };
}

/** Optional demo dataset so a first-time reviewer can see the whole app
 *  populated without manual entry. Enabled from Settings -> "Load demo data". */
export function demoVault(): VaultBlob {
  const v = emptyVault();
  const now = Date.now();
  const day = 86_400_000;
  const myrRate = 1; // MYR base; foreign rates are illustrative snapshots.
  const usdRate = 4.21; // 1 USD = 4.21 MYR (illustrative)

  const fx = (rate: number, original: number) => ({
    baseAmount: original * rate,
    fxRate: rate,
  });

  v.expenses = [
    {
      id: 'ex-1',
      originalAmount: 42.5,
      originalCurrency: 'MYR',
      ...fx(myrRate, 42.5),
      baseCurrency: 'MYR',
      category: 'Food & Dining',
      aiTier: 'dictionary',
      merchant: 'Lotus's Cheras',
      timestamp: now - 0 * day,
      paymentMethod: 'card',
      source: 'card',
    },
    {
      id: 'ex-2',
      originalAmount: 12.99,
      originalCurrency: 'USD',
      ...fx(usdRate, 12.99),
      baseCurrency: 'MYR',
      category: 'Shopping',
      aiTier: 'llm-byok',
      merchant: 'Amazon',
      timestamp: now - 1 * day,
      paymentMethod: 'card',
      source: 'card',
    },
    {
      id: 'ex-3',
      originalAmount: 8.4,
      originalCurrency: 'SGD',
      ...fx(3.1, 8.4),
      baseCurrency: 'MYR',
      category: 'Transport',
      aiTier: 'dictionary',
      merchant: 'GrabSG',
      timestamp: now - 2 * day,
      paymentMethod: 'ewallet',
      source: 'ocr',
      note: 'OCR: "Paid S$8.40 to Grab" -> SGD',
    },
    {
      id: 'ex-4',
      originalAmount: 1500,
      originalCurrency: 'MYR',
      ...fx(myrRate, 1500),
      baseCurrency: 'MYR',
      category: 'Housing & Rent',
      aiTier: 'dictionary',
      merchant: 'KSL City Centre (rent)',
      timestamp: now - 3 * day,
      paymentMethod: 'bank',
      source: 'manual',
    },
  ];

  v.accounts = [
    {
      id: 'acc-luno',
      platformName: 'Luno',
      accountType: 'crypto',
      baseCurrencyValue: 0,
      lastUpdated: now,
    },
    {
      id: 'acc-ibkr',
      platformName: 'IBKR',
      accountType: 'broker',
      baseCurrencyValue: 0,
      lastUpdated: now,
    },
    {
      id: 'acc-stash',
      platformName: 'StashAway',
      accountType: 'robo',
      baseCurrencyValue: 0,
      lastUpdated: now,
    },
  ];

  v.holdings = [
    {
      id: 'h-btc',
      accountId: 'acc-luno',
      symbol: 'BTC',
      assetClass: 'crypto',
      holdingCurrency: 'USD',
      units: 0.05,
      averageEntryPrice: 61_000,
      currentPriceLocal: 64_200,
      currentPriceBase: 64_200 * usdRate,
    },
    {
      id: 'h-aapl',
      accountId: 'acc-ibkr',
      symbol: 'AAPL',
      assetClass: 'equity-us',
      holdingCurrency: 'USD',
      units: 24,
      averageEntryPrice: 182,
      currentPriceLocal: 210.5,
      currentPriceBase: 210.5 * usdRate,
    },
    {
      id: 'h-cspx',
      accountId: 'acc-stash',
      symbol: 'CSPX.L',
      assetClass: 'etf',
      holdingCurrency: 'USD',
      units: 30,
      averageEntryPrice: 4.1,
      currentPriceLocal: 4.35,
      currentPriceBase: 4.35 * usdRate,
    },
  ];

  return v;
}
