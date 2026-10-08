// ============================================================================
// Coach actions — parse/validate/apply contract tests.
//
// Proves: a well-formed [ACTION:] marker parses and applies idempotently;
// every malformed shape is rejected with a reason (never written); the
// visible text is stripped of markers; applyCreatePortfolio dedupes against
// existing accounts/holdings.
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  parseAction,
  stripActionMarker,
  applyCreatePortfolio,
  type CreatePortfolioAction,
  type ActionStore,
} from '../src/ai/actions';

const marker = (json: string) => `Here is what I will create:\n[ACTION:${json}]`;

const GOOD = {
  action: 'create_portfolio',
  platformName: 'Luno',
  accountType: 'crypto',
  holdings: [
    { symbol: 'BTC', assetClass: 'crypto', currency: 'USD', units: 0.05, entryPrice: 95000 },
    { symbol: 'ETH', assetClass: 'crypto', currency: 'USD', units: 1.2, entryPrice: 3200 },
  ],
};

describe('parseAction', () => {
  it('accepts a well-formed create_portfolio', () => {
    const r = parseAction(marker(JSON.stringify(GOOD)));
    expect(r.ok).toBe(true);
    expect(r.action!.platformName).toBe('Luno');
    expect(r.action!.holdings).toHaveLength(2);
  });

  it('rejects when no marker is present (analysis-only answer)', () => {
    const r = parseAction('Your portfolio is 93% equities. Watch concentration.');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('No [ACTION:]');
  });

  it('rejects invalid JSON in the marker (balanced braces, broken syntax)', () => {
    const r = parseAction('[ACTION:{"action": "create_portfolio", "platformName": }]');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('Invalid JSON');
  });

  it('rejects a marker that never closes its object (no [ACTION:] shape found)', () => {
    const r = parseAction('[ACTION:{"action": broken]');
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown action type', () => {
    const r = parseAction(marker(JSON.stringify({ ...GOOD, action: 'delete_everything' })));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('Unknown action type');
  });

  it('rejects a missing platformName', () => {
    const r = parseAction(marker(JSON.stringify({ ...GOOD, platformName: '  ' })));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('platformName');
  });

  it('rejects an invalid accountType', () => {
    const r = parseAction(marker(JSON.stringify({ ...GOOD, accountType: 'bank' })));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('accountType');
  });

  it('rejects zero holdings and >20 holdings', () => {
    expect(parseAction(marker(JSON.stringify({ ...GOOD, holdings: [] }))).ok).toBe(false);
    const many = {
      ...GOOD,
      holdings: Array.from({ length: 21 }, (_, i) => ({ ...GOOD.holdings[0], symbol: `T${i}`, units: 1, entryPrice: 1 })),
    };
    const r = parseAction(marker(JSON.stringify(many)));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('Too many');
  });

  it('rejects a bad symbol', () => {
    const r = parseAction(marker(JSON.stringify({ ...GOOD, holdings: [{ ...GOOD.holdings[0], symbol: 'bad sym!' }] })));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('Invalid symbol');
  });

  it('rejects duplicate symbols in one action', () => {
    const r = parseAction(
      marker(JSON.stringify({ ...GOOD, holdings: [GOOD.holdings[0], GOOD.holdings[0]] })),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('Duplicate symbol');
  });

  it('rejects a bad assetClass', () => {
    const r = parseAction(marker(JSON.stringify({ ...GOOD, holdings: [{ ...GOOD.holdings[0], assetClass: 'pigeon' }] })));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('assetClass');
  });

  it('rejects a non-ISO currency', () => {
    const r = parseAction(marker(JSON.stringify({ ...GOOD, holdings: [{ ...GOOD.holdings[0], currency: 'Bucks' }] })));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('currency');
  });

  it('rejects non-positive units and negative entryPrice', () => {
    expect(
      parseAction(marker(JSON.stringify({ ...GOOD, holdings: [{ ...GOOD.holdings[0], units: 0 }] }))).ok,
    ).toBe(false);
    expect(
      parseAction(marker(JSON.stringify({ ...GOOD, holdings: [{ ...GOOD.holdings[0], entryPrice: -1 }] }))).ok,
    ).toBe(false);
  });

  it('normalizes symbol case and currency case', () => {
    const r = parseAction(
      marker(JSON.stringify({ ...GOOD, holdings: [{ ...GOOD.holdings[0], symbol: 'btc', currency: 'usd' }] })),
    );
    expect(r.ok).toBe(true);
    expect(r.action!.holdings[0].symbol).toBe('BTC');
    expect(r.action!.holdings[0].currency).toBe('USD');
  });
});

describe('stripActionMarker', () => {
  it('removes the marker but keeps the prose', () => {
    const out = stripActionMarker(marker(JSON.stringify(GOOD)));
    expect(out).toBe('Here is what I will create:');
    expect(out).not.toContain('[ACTION:');
  });

  it('returns text unchanged when there is no marker', () => {
    expect(stripActionMarker('plain text')).toBe('plain text');
  });
});

// ---------------------------------------------------------------------------
// applyCreatePortfolio — idempotent writes against a fake store.
// ---------------------------------------------------------------------------

function fakeStore(initial: { accounts?: ActionStore['accounts']; holdings?: ActionStore['holdings'] } = {}) {
  const accounts = [...(initial.accounts ?? [])];
  const holdings = [...(initial.holdings ?? [])];
  const addedAccounts: string[] = [];
  const addedHoldings: string[] = [];
  const store: ActionStore & { addedAccounts: string[]; addedHoldings: string[] } = {
    accounts,
    holdings,
    addAccount: (i) => {
      const id = `acc-${i.platformName.toLowerCase()}`;
      accounts.push({ id, platformName: i.platformName, accountType: i.accountType, baseCurrencyValue: 0, lastUpdated: 0 } as never);
      addedAccounts.push(id);
      return id;
    },
    addHolding: (i) => {
      const id = `h-${i.symbol}`;
      holdings.push({
        id,
        accountId: i.accountId,
        symbol: i.symbol,
        assetClass: i.assetClass,
        holdingCurrency: i.holdingCurrency,
        units: i.units,
        averageEntryPrice: i.averageEntryPrice,
        currentPriceLocal: i.currentPriceLocal ?? 0,
        currentPriceBase: i.currentPriceBase ?? 0,
      } as never);
      addedHoldings.push(id);
      return id;
    },
    addedAccounts,
    addedHoldings,
  };
  return store;
}

describe('applyCreatePortfolio', () => {
  it('creates a new account and its holdings when nothing exists', () => {
    const s = fakeStore();
    const a: CreatePortfolioAction = {
      action: 'create_portfolio',
      platformName: 'Luno',
      accountType: 'crypto',
      holdings: [
        { symbol: 'BTC', assetClass: 'crypto', currency: 'USD', units: 0.1, entryPrice: 90000 },
        { symbol: 'ETH', assetClass: 'crypto', currency: 'USD', units: 1, entryPrice: 3000 },
      ],
    };
    const summary = applyCreatePortfolio(s, a);
    expect(s.accounts).toHaveLength(1);
    expect(s.accounts[0].platformName).toBe('Luno');
    expect(s.holdings).toHaveLength(2);
    expect(s.holdings[0].accountId).toBe(s.accounts[0].id);
    expect(summary).toContain('created "Luno"');
    expect(summary).toContain('added 2 holdings');
  });

  it('reuses an existing same-named account (case-insensitive) and skips dupes', () => {
    const s = fakeStore({
      accounts: [{ id: 'acc-existing', platformName: 'luno', accountType: 'crypto', baseCurrencyValue: 0, lastUpdated: 0 } as never],
      holdings: [
        { id: 'h-btc', accountId: 'acc-existing', symbol: 'BTC', assetClass: 'crypto', holdingCurrency: 'USD', units: 0.1, averageEntryPrice: 90000, currentPriceLocal: 0, currentPriceBase: 0 } as never,
      ],
    });
    const a: CreatePortfolioAction = {
      action: 'create_portfolio',
      platformName: 'Luno',
      accountType: 'crypto',
      holdings: [
        { symbol: 'BTC', assetClass: 'crypto', currency: 'USD', units: 0.1, entryPrice: 90000 }, // dupe
        { symbol: 'ETH', assetClass: 'crypto', currency: 'USD', units: 1, entryPrice: 3000 },   // new
      ],
    };
    const summary = applyCreatePortfolio(s, a);
    expect(s.accounts).toHaveLength(1); // no second account
    expect(s.holdings).toHaveLength(2);  // only ETH added
    expect(summary).toContain('used existing');
    expect(summary).toContain('added 1 holding');
    expect(summary).toContain('skipped 1 duplicate');
  });

  it('treats same-symbol-different-lot as a new holding', () => {
    const s = fakeStore({
      accounts: [{ id: 'acc-luno', platformName: 'Luno', accountType: 'crypto', baseCurrencyValue: 0, lastUpdated: 0 } as never],
      holdings: [
        { id: 'h-btc1', accountId: 'acc-luno', symbol: 'BTC', assetClass: 'crypto', holdingCurrency: 'USD', units: 0.1, averageEntryPrice: 90000, currentPriceLocal: 0, currentPriceBase: 0 } as never,
      ],
    });
    const a: CreatePortfolioAction = {
      action: 'create_portfolio',
      platformName: 'Luno',
      accountType: 'crypto',
      holdings: [{ symbol: 'BTC', assetClass: 'crypto', currency: 'USD', units: 0.2, entryPrice: 100000 }], // new lot
    };
    applyCreatePortfolio(s, a);
    expect(s.holdings).toHaveLength(2);
  });
});
