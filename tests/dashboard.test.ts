// ============================================================================
// OmniFlow — dashboard AI summary tests (no network, no DOM).
// Proves the Tier-2 rulesSummary narrative de-duplicates the empty-vault
// onboarding message (previously "No investments tracked yet." AND the
// empty-nudge rule both fired, reading as the same fact twice).
// ============================================================================

import { describe, it, expect } from 'vitest';
import { summarizeDashboard } from '../src/ai/dashboard';
import type { AdvisorInput } from '../src/ai/advisor';
import type { Expense, InvestmentAccount, InvestmentHolding, QuoteSnapshot, UserPreferences } from '../src/domain/types';

const MYR = 'MYR';

function input(over: Partial<AdvisorInput> = {}): AdvisorInput {
  return {
    expenses: [] as Expense[],
    accounts: [] as InvestmentAccount[],
    holdings: [] as InvestmentHolding[],
    quotes: {} as Record<string, QuoteSnapshot>,
    prefs: {
      baseCurrency: MYR,
      displayName: '',
      llmProvider: 'none',
      llmKeyFinger: '',
      autoCategorize: true,
      advisorRules: false,
      billReminders: false,
    } as UserPreferences,
    ...over,
  };
}

describe('summarizeDashboard (Tier-2 rules)', () => {
  it('emits a single onboarding line for a fresh empty vault, not a duplicated fact', async () => {
    const s = await summarizeDashboard(input(), null, null);
    expect(s.source).toBe('rules');
    expect(s.degraded).toBe(false);
    // Exactly one "track/add" sentence. Previously two back-to-back lines.
    const mentions = s.text.match(/No investments tracked|Add holdings/g) ?? [];
    expect(mentions).toHaveLength(1);
    expect(s.text).toContain('Add holdings');
  });

  it('reports net worth when the portfolio has value', async () => {
    const s = await summarizeDashboard(
      input({
        holdings: [
          {
            id: 'h1',
            accountId: 'a1',
            symbol: 'BTC',
            assetClass: 'crypto',
            units: 1,
            holdingCurrency: 'USD',
            averageEntryPrice: 50_000,
            currentPriceLocal: 60_000,
            currentPriceBase: 250_000,
          },
        ],
        accounts: [
          {
            id: 'a1',
            platformName: 'Luno',
            accountType: 'broker',
            baseCurrencyValue: 0,
            lastUpdated: Date.now(),
          },
        ],
        quotes: { BTC: { symbol: 'BTC', assetClass: 'crypto', price: 250_000, currency: 'MYR', asOf: Date.now(), source: 'cache' } },
      }),
      null,
      null,
    );
    expect(s.text).toContain('Net worth');
    // Populated portfolio: the empty onboarding line must be absent.
    expect(s.text).not.toContain('No investments tracked');
  });
});
