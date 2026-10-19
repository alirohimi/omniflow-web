// ============================================================================
// OmniFlow — auto-invest engine + contribution P&L regression tests.
//
// Pure engine tests (dueAutoInvests / advanceNextDue / periodsBetween /
// autoInvestMonthlyTotal / portfolioPnl) plus one real-provider test that the
// addContribution mutator grows an account's invested capital (which is what
// keeps the portfolio P&L honest across logged monthly savings).
//
// @vitest-environment happy-dom
// ============================================================================

import { describe, it, expect, vi } from 'vitest';
import {
  dueAutoInvests,
  advanceNextDue,
  periodsBetween,
  autoInvestMonthlyTotal,
  portfolioPnl,
} from '../src/insights/autoinvest';
import type { AutoInvest, Contribution, InvestmentAccount } from '../src/domain/types';
import type { PortfolioSummary, AccountLine } from '../src/ai/portfolio';

const NOW = 1_800_000_000_000;

function plan(over: Partial<AutoInvest>): AutoInvest {
  return {
    id: 'pi-x',
    accountId: 'acc-1',
    name: 'p',
    amount: 100,
    currency: 'MYR',
    baseAmount: 400,
    fxRate: 4,
    period: 'monthly',
    nextDue: NOW,
    active: true,
    createdAt: NOW - 1000,
    ...over,
  };
}

describe('dueAutoInvests', () => {
  it('returns active plans due today or overdue, oldest first', () => {
    const a = plan({ id: 'a', nextDue: NOW - 5 * 86_400_000 }); // 5 days overdue
    const b = plan({ id: 'b', nextDue: NOW - 2 * 3_600_000 }); // today (2h ago)
    const c = plan({ id: 'c', nextDue: NOW + 86_400_000 }); // tomorrow
    const d = plan({ id: 'd', nextDue: NOW - 3 * 86_400_000, active: false }); // paused
    const due = dueAutoInvests([c, d, a, b], NOW);
    expect(due.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('a plan due later today (nextDue in the future but same day) is due', () => {
    const dayStart = new Date(NOW);
    dayStart.setHours(0, 0, 0, 0);
    const p = plan({ nextDue: dayStart.getTime() + 20 * 3_600_000 }); // 20h from midnight 00
    expect(dueAutoInvests([p], NOW).map((x) => x.id)).toEqual(['pi-x']);
  });
});

describe('advanceNextDue', () => {
  it('advances a due plan by one period', () => {
    const p = plan({ period: 'monthly', nextDue: NOW - 31 * 86_400_000 });
    const next = advanceNextDue(p, NOW);
    // nextDue + 30.4d is still slightly before NOW, so it jumps one more step.
    expect(next).toBeGreaterThan(NOW);
    expect(next - (NOW - 31 * 86_400_000)).toBeLessThanOrEqual(2 * 30.4 * 86_400_000 + 86_400_000);
  });

  it('an overdue plan jumps to the first cycle at/after now (catch-up, not N logs)', () => {
    // 5 months overdue on a monthly plan: nextDue = NOW - 5*30.4d.
    const p = plan({ period: 'monthly', nextDue: NOW - 5 * 30.4 * 86_400_000 });
    const next = advanceNextDue(p, NOW);
    // Steps of 30.4d from nextDue until just past NOW: 6 steps total
    // (steps 1-5 still land before NOW; step 6 lands ~NOW + 30.4d).
    const step = 30.4 * 86_400_000;
    let expected = p.nextDue;
    while (expected <= NOW) expected += step;
    expect(next).toBe(expected);
  });

  it('weekly period uses 7-day steps', () => {
    const p = plan({ period: 'weekly', nextDue: NOW - 8 * 86_400_000 });
    const next = advanceNextDue(p, NOW);
    // 8d ago + 7d = 1d ago (still past) → +7d = 6d from now.
    expect(next).toBe(NOW + 6 * 86_400_000);
  });
});

describe('periodsBetween', () => {
  it('counts full monthly periods', () => {
    expect(periodsBetween('monthly', NOW - 3 * 30.4 * 86_400_000, NOW)).toBe(3);
    expect(periodsBetween('monthly', NOW, NOW - 30.4 * 86_400_000)).toBe(0); // to < from
  });
});

describe('autoInvestMonthlyTotal', () => {
  it('normalizes every cadence to a monthly equivalent', () => {
    const weekly = plan({ id: 'w', period: 'weekly', baseAmount: 100 });
    const monthly = plan({ id: 'm', period: 'monthly', baseAmount: 500 });
    const q = plan({ id: 'q', period: 'quarterly', baseAmount: 1500 });
    const y = plan({ id: 'y', period: 'yearly', baseAmount: 12_000 });
    const paused = plan({ id: 'p', baseAmount: 9999, active: false });
    const total = autoInvestMonthlyTotal([weekly, monthly, q, y, paused]);
    expect(total).toBeCloseTo(100 * 4.345 + 500 + 1500 / 3 + 12_000 / 12, 3);
  });
});

describe('portfolioPnl', () => {
  function fakeSummary(accounts: Array<{ id: string; value: number; cost: number }>): PortfolioSummary {
    const byAccount: AccountLine[] = accounts.map((a) => {
      const inv: InvestmentAccount = {
        id: a.id, platformName: a.id, accountType: 'broker',
        baseCurrencyValue: a.value, lastUpdated: NOW,
      };
      return {
        account: inv, lines: [], valueBase: a.value, valueLocal: a.value,
        costBase: a.cost, returnPct: a.cost > 0 ? ((a.value - a.cost) / a.cost) * 100 : null,
        depositBase: null, pnlBase: null, depositReturnPct: null,
      };
    });
    return {
      baseCurrency: 'MYR', totalValueBase: 1, totalCostBase: 1, totalReturnPct: null,
      byAssetClass: [], byAccount, liveQuoteCount: 0, staleQuoteCount: 0, uncounted: 0,
    };
  }

  it('uses the account initialDepositBase when recorded', () => {
    const acc: InvestmentAccount = {
      id: 'acc-1', platformName: 'Luno', accountType: 'broker',
      baseCurrencyValue: 0, lastUpdated: NOW, initialDepositBase: 10_000,
    };
    const summary = fakeSummary([{ id: 'acc-1', value: 12_000, cost: 0 }]);
    const pnl = portfolioPnl(summary, [acc], []);
    expect(pnl.totalCapitalBase).toBe(10_000);
    expect(pnl.totalPnlBase).toBe(2_000);
    expect(pnl.totalReturnPct).toBeCloseTo(20, 5);
    expect(pnl.missingCapitalCount).toBe(0);
  });

  it('falls back to the contribution ledger when no manual balance is set', () => {
    const acc: InvestmentAccount = {
      id: 'acc-1', platformName: 'Luno', accountType: 'broker',
      baseCurrencyValue: 0, lastUpdated: NOW,
    };
    const contribs: Contribution[] = [
      { id: 'c1', accountId: 'acc-1', amount: 500, currency: 'MYR', amountBase: 2_000, fxRate: 4, date: NOW },
      { id: 'c2', accountId: 'acc-1', amount: 500, currency: 'MYR', amountBase: 2_000, fxRate: 4, date: NOW },
    ];
    const summary = fakeSummary([{ id: 'acc-1', value: 5_000, cost: 0 }]);
    const pnl = portfolioPnl(summary, [acc], contribs);
    expect(pnl.totalCapitalBase).toBe(4_000);
    expect(pnl.totalPnlBase).toBe(1_000);
    expect(pnl.missingCapitalCount).toBe(0);
  });

  it('excludes accounts with value but no recorded capital from totals, and counts them missing', () => {
    const a: InvestmentAccount = { id: 'a', platformName: 'A', accountType: 'broker', baseCurrencyValue: 0, lastUpdated: NOW, initialDepositBase: 5_000 };
    const b: InvestmentAccount = { id: 'b', platformName: 'B', accountType: 'broker', baseCurrencyValue: 0, lastUpdated: NOW };
    const summary = fakeSummary([{ id: 'a', value: 5_500, cost: 0 }, { id: 'b', value: 8_000, cost: 0 }]);
    const pnl = portfolioPnl(summary, [a, b], []);
    // Only account 'a' (with capital) is in the P&L totals.
    expect(pnl.totalCapitalBase).toBe(5_000);
    expect(pnl.totalPnlBase).toBe(500);
    expect(pnl.missingCapitalCount).toBe(1);
  });

  it('all-null when nothing is recorded anywhere', () => {
    const a: InvestmentAccount = { id: 'a', platformName: 'A', accountType: 'broker', baseCurrencyValue: 0, lastUpdated: NOW };
    const summary = fakeSummary([{ id: 'a', value: 100, cost: 0 }]);
    const pnl = portfolioPnl(summary, [a], []);
    expect(pnl.totalCapitalBase).toBe(0);
    expect(pnl.totalPnlBase).toBeNull();
    expect(pnl.totalReturnPct).toBeNull();
    expect(pnl.missingCapitalCount).toBe(1);
  });
});

// ---- real-provider test: addContribution bumps account capital ----
const authRef = vi.hoisted(() => {
  const state: {
    cloudAvailable: boolean;
    restoring: boolean;
    user: { id: string; user_metadata?: Record<string, string> } | null;
    accountPassword: string | null;
    accessToken: string | null;
    lastError: string | null;
  } = {
    cloudAvailable: true,
    restoring: false,
    user: null,
    accountPassword: null,
    accessToken: 'fake-jwt',
    lastError: null,
  };
  let version = 0;
  const listeners = new Set<() => void>();
  return {
    get version() { return version; },
    subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb); },
    set(patch: Partial<typeof state>) { Object.assign(state, patch); version++; for (const cb of listeners) cb(); },
    get state() { return state; },
  };
});

const cloudRef = vi.hoisted(() => ({
  strict: async (_id: string) => undefined as unknown,
  saves: [] as unknown[],
}));

vi.mock('../src/auth/AuthProvider', () => {
  const useAuthStore = () => {
    React.useSyncExternalStore(
      (cb: () => void) => authRef.subscribe(cb),
      () => authRef.version,
      () => authRef.version,
    );
    const s = authRef.state;
    return {
      cloudAvailable: s.cloudAvailable,
      restoring: s.restoring,
      user: s.user,
      accountPassword: s.accountPassword,
      accessToken: s.accessToken,
      lastError: s.lastError,
      signUp: async () => undefined,
      signIn: async () => undefined,
      signOut: async () => undefined,
      updateAccountPassword: async () => undefined,
      clearError: () => undefined,
      setAccountPassword: (val: string) =>
        authRef.set({ accountPassword: val || null }),
    };
  };
  const AuthProvider = ({ children }: { children: React.ReactNode }) => children;
  return { useAuthStore, AuthProvider };
});

vi.mock('../src/services/cloudVault', () => ({
  fetchCloudVaultStrict: (id: string, _t?: string) => cloudRef.strict(id),
  saveCloudVault: async (_u: string, _c: unknown) => true,
  deleteCloudVault: async () => undefined,
  flushVaultKeepalive: () => undefined,
}));

vi.mock('../src/services/supabase', () => ({
  isCloudEnabled: () => true,
  getSupabase: () => null,
  cloudEndpoints: () => null,
  anonKey: 'test-anon',
}));

vi.mock('../src/services/admin', () => ({
  isAdmin: async () => false,
  getMyLlmPolicy: async () => undefined,
  upsertSelfMember: async () => undefined,
  listMembers: async () => [],
  listVaultSync: async () => [],
  listAdminIds: async () => [],
  listPolicies: async () => [],
  grantAdmin: async () => false,
  revokeAdmin: async () => false,
  setLlmPolicy: async () => false,
  clearLlmPolicy: async () => false,
  getDefaultLlm: async () => undefined,
  setDefaultLlm: async () => false,
  applyDefaultLlmToUser: async () => true,
  wipeMemberVault: async () => false,
}));

import React from 'react';

import { createRoot, type Root } from 'react-dom/client';
import { VaultProvider, useVaultStore, type VaultStore } from '../src/store/store';

const act = React.act;
const PASSWORD = 'autopass99';

function Probe({ storeRef }: { storeRef: React.MutableRefObject<VaultStore | null> }) {
  storeRef.current = useVaultStore();
  return React.createElement('div');
}

async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 25_000,
  label = 'condition',
): Promise<void> {
  const t0 = Date.now();
  while (true) {
    const ok = await fn();
    if (ok) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timed out: ${label}`);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

async function unlockFreshVault(
  userId: string,
): Promise<{ storeRef: React.MutableRefObject<VaultStore | null>; unmount: () => Promise<void> }> {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  cloudRef.saves = [];
  cloudRef.strict = async () => undefined; // no row: first run
  authRef.set({
    user: { id: userId },
    accountPassword: PASSWORD,
    accessToken: 'fake-jwt',
  });

  const storeRef = React.createRef<VaultStore | null>();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(
      React.createElement(VaultProvider, null, React.createElement(Probe, { storeRef })),
    );
  });
  await act(async () => {
    await storeRef.current!.createVault(PASSWORD, { baseCurrency: 'MYR' });
  });
  await waitFor(
    () => storeRef.current?.status === 'unlocked',
    25_000,
    'createVault -> unlocked',
  );

  const unmount = async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  };
  return { storeRef, unmount };
}

describe('addContribution (real provider)', () => {
  it('grows the target account initialDepositBase and appends to the ledger', async () => {
    const { storeRef, unmount } = await unlockFreshVault('user-ai-cap');
    const accId = storeRef.current!.addAccount({
      platformName: 'Test Luno',
      accountType: 'crypto',
      initialDepositBase: 5_000,
    });
    await act(async () => {
      storeRef.current!.addContribution({
        accountId: accId,
        amount: 250,
        currency: 'USD',
        amountBase: 1_000,
        fxRate: 4,
        date: Date.now(),
        note: 'monthly',
      });
    });
    const acc = storeRef.current!.vault!.accounts.find((a) => a.id === accId)!;
    expect(acc.initialDepositBase).toBe(6_000); // 5000 + 1000
    const contribs = storeRef.current!.vault!.contributions!;
    expect(contribs).toHaveLength(1);
    expect(contribs[0]).toMatchObject({ accountId: accId, amountBase: 1_000, currency: 'USD' });
    await unmount();
  });

  it('zero amountBase is a safe no-op on capital but still logs the row', async () => {
    const { storeRef, unmount } = await unlockFreshVault('user-ai-zc');
    const accId = storeRef.current!.addAccount({ platformName: 'Z', accountType: 'cash' });
    await act(async () => {
      storeRef.current!.addContribution({
        accountId: accId,
        amount: 100,
        currency: 'MYR',
        amountBase: 0,
        fxRate: 1,
        date: Date.now(),
      });
    });
    const acc = storeRef.current!.vault!.accounts.find((a) => a.id === accId)!;
    // 0 is not > 0, so capital stays 0 (never negative) — but the ledger row
    // is still appended and nothing crashes.
    expect(acc.initialDepositBase).toBe(0);
    expect(storeRef.current!.vault!.contributions).toHaveLength(1);
    await unmount();
  });
});
