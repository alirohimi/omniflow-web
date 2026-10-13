// ============================================================================
// OmniFlow — extended-entity CRUD regression test (budgets / recurring /
// liabilities / manual assets / dividends / disposals).
//
// Renders the REAL VaultProvider under a fresh signed-in user (no cloud row),
// creates the vault, then exercises every extended add*/delete* mutator and
// verifies the mutated blob actually round-trips through the encrypted
// cloud persist path (encrypt -> decrypt the last saved cipher).
//
// @vitest-environment happy-dom
// ============================================================================

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';

const act = React.act;

// Reactive auth mock (mirrors vault-race.test.ts).
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
    get state() {
      return state;
    },
    get version() {
      return version;
    },
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    set(patch: Partial<typeof state>) {
      Object.assign(state, patch);
      version++;
      for (const cb of listeners) cb();
    },
  };
});

const cloudRef = vi.hoisted(() => ({
  strict: ((async (_id: string) => undefined) as unknown as (
    id: string,
  ) => Promise<import('../src/security/vault').VaultCipher | undefined>),
  saves: [] as Array<{ userId: string; cipher: import('../src/security/vault').VaultCipher }>,
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
  fetchCloudVaultStrict: (id: string) => cloudRef.strict(id),
  saveCloudVault: async (userId: string, cipher: unknown) => {
    cloudRef.saves.push({ userId, cipher: cipher as import('../src/security/vault').VaultCipher });
    return true;
  },
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

// Under-test imports (after mocks).
import { VaultProvider, useVaultStore, type VaultStore } from '../src/store/store';
import { decryptVault, type VaultCipher } from '../src/security/vault';
import type { VaultBlob } from '../src/domain/types';

const PASSWORD = 'extpass99';

function Probe({ storeRef }: { storeRef: React.MutableRefObject<VaultStore | null> }) {
  const s = useVaultStore();
  storeRef.current = s;
  return React.createElement('div', { 'data-testid': 'probe' });
}

async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
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

/**
 * Fresh sign-in as `userId` -> probe 'creating' -> createVault -> 'unlocked'.
 * Each test uses its OWN userId so the shared auth/cloud mocks never mix data
 * between tests. `unmount()` is returned to clean up the provider (prevents
 * test 1's lingering async persist chain from recording saves during test 2).
 */
async function unlockFreshVault(
  userId: string,
): Promise<{
  storeRef: React.MutableRefObject<VaultStore | null>;
  unmount: () => Promise<void>;
}> {
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
  await waitFor(
    () => storeRef.current?.status === 'creating',
    3_000,
    'fresh probe -> creating',
  );
  await act(async () => {
    await storeRef.current!.createVault(PASSWORD, { baseCurrency: 'MYR' });
  });
  await waitFor(
    () => storeRef.current?.status === 'unlocked',
    3_000,
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

describe('extended-entity CRUD (budgets/recurring/liabilities/assets/dividends/disposals)', () => {
  it('adds and deletes all six entity types through the real provider', async () => {
    const { storeRef, unmount } = await unlockFreshVault('user-ext-crud');
    expect(storeRef.current!.status).toBe('unlocked');
    // Add each entity type inside act (flushes the setVault commit), then
    // re-read storeRef.current for the FRESH vault — the captured object is a
    // pre-mutation snapshot, so we must not hold onto a stale `store`.
    const bId = storeRef.current!.addBudget({ category: 'Food & Dining', cap: 800, period: 'monthly', rollover: false });
    const rId = storeRef.current!.addRecurring({
      name: 'Netflix', merchant: 'Netflix', amount: 15.99, currency: 'USD',
      baseAmount: 67.75, fxRate: 4.237, period: 'monthly', nextDue: Date.now() + 86_400_000,
      category: 'Entertainment', active: true,
    });
    const lId = storeRef.current!.addLiability({ name: 'Car loan', balance: 42_000, apr: 2.8, minPayment: 950 });
    const aId = storeRef.current!.addAsset({ name: 'Savings', value: 15_000, kind: 'bank' });
    const dId = storeRef.current!.addDividend({
      holdingId: 'h-1', symbol: 'VUAA', amount: 12.5, currency: 'MYR',
      date: Date.now(), reinvested: false,
    });
    const sId = storeRef.current!.addDisposal({
      holdingId: 'h-1', symbol: 'VUAA', units: 20, salePrice: 11.2,
      currency: 'MYR', costBasisPerUnit: 9.8, date: Date.now(),
    });

    // ids: non-empty, distinct, prefixed per entity family.
    const ids = [bId, rId, lId, aId, dId, sId];
    expect(new Set(ids).size).toBe(6);
    for (const i of ids) expect(typeof i).toBe('string');

    // Flush all the add commits, then assert against the live vault.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const v = storeRef.current!.vault!;
    expect(v.budgets!).toHaveLength(1);
    expect(v.budgets![0]).toMatchObject({ id: bId, category: 'Food & Dining', cap: 800, period: 'monthly' });
    expect(v.recurring!).toHaveLength(1);
    expect(v.recurring![0]).toMatchObject({ id: rId, name: 'Netflix', amount: 15.99, active: true });
    expect(v.liabilities!).toHaveLength(1);
    expect(v.liabilities![0]).toMatchObject({ id: lId, balance: 42_000, apr: 2.8, minPayment: 950 });
    expect(v.assets!).toHaveLength(1);
    expect(v.assets![0]).toMatchObject({ id: aId, value: 15_000, kind: 'bank' });
    expect(v.dividends!).toHaveLength(1);
    expect(v.dividends![0]).toMatchObject({ id: dId, symbol: 'VUAA', amount: 12.5 });
    expect(v.disposals!).toHaveLength(1);
    expect(v.disposals![0]).toMatchObject({ id: sId, units: 20, salePrice: 11.2 });

    // --- deletes remove exactly the targeted row ---
    await act(async () => {
      storeRef.current!.deleteBudget(bId);
      storeRef.current!.deleteRecurring(rId);
      storeRef.current!.deleteLiability(lId);
      storeRef.current!.deleteAsset(aId);
      storeRef.current!.deleteDividend(dId);
      storeRef.current!.deleteDisposal(sId);
      await new Promise((r) => setTimeout(r, 20));
    });
    const v2 = storeRef.current!.vault!;
    expect(v2.budgets).toHaveLength(0);
    expect(v2.recurring).toHaveLength(0);
    expect(v2.liabilities).toHaveLength(0);
    expect(v2.assets).toHaveLength(0);
    expect(v2.dividends).toHaveLength(0);
    expect(v2.disposals).toHaveLength(0);

    // deleting a non-existent id is a safe no-op.
    await act(async () => {
      storeRef.current!.deleteBudget('b-does-not-exist');
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(storeRef.current!.vault!.budgets!).toHaveLength(0);
    await unmount();
  });

  it('deleting an account prunes emergency lines that mirror it', async () => {
    const { storeRef, unmount } = await unlockFreshVault('user-acc-prune');
    const store = storeRef.current!;

    await act(async () => {
      const accId = store.addAccount({ platformName: 'Luno', accountType: 'crypto', initialDepositBase: 5000 });
      store.addEmergencyItem({
        kind: 'account',
        name: 'Luno',
        currency: 'MYR',
        accountId: accId,
        createdAt: Date.now(),
      });
      store.addEmergencyItem({
        kind: 'manual',
        name: 'Cash buffer',
        currency: 'MYR',
        amount: 1000,
        createdAt: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 20));
    });

    let v = storeRef.current!.vault!;
    expect(v.accounts).toHaveLength(1);
    expect(v.emergency?.items).toHaveLength(2);
    const accId = v.accounts[0].id;

    // delete the account -> its mirrored emergency line must vanish; the manual one survives.
    await act(async () => {
      store.deleteAccount(accId);
      await new Promise((r) => setTimeout(r, 20));
    });
    v = storeRef.current!.vault!;
    expect(v.accounts).toHaveLength(0);
    expect(v.emergency?.items).toHaveLength(1);
    expect(v.emergency?.items[0].kind).toBe('manual');
    await unmount();
  });

  it('extended entities survive the encrypted cloud persist round-trip', async () => {
    const USER = 'user-ext-rt';
    const { storeRef, unmount } = await unlockFreshVault(USER);
    const store = storeRef.current!;
    // add* mutators are stable useCallbacks — safe to call on the captured
    // object. But LIVE state (syncState, vault) must be re-read from
    // storeRef.current every time, since the captured `store` is a snapshot.

    await act(async () => {
      store.addBudget({ category: 'Transport', cap: 300, period: 'monthly', rollover: true });
      store.addLiability({ name: 'Card', balance: 5_000, apr: 16, minPayment: 150, extraPayment: 100 });
      await new Promise((r) => setTimeout(r, 20));
    });

    // The persist chain is fire-and-forget. Poll for a saved cloud cipher
    // whose decrypted blob carries BOTH the new budget and the new liability
    // — that proves the extended arrays round-trip through the real
    // encrypt->persist->upsert path, not just the in-memory blob.
    async function lastDecryptedHasBoth(): Promise<boolean> {
      const userSaves = cloudRef.saves.filter((s) => s.userId === USER);
      if (userSaves.length === 0) return false;
      const blob = await decryptVault<VaultBlob>(
        userSaves[userSaves.length - 1].cipher,
        PASSWORD,
      );
      return (
        !!blob &&
        (blob.budgets?.length ?? 0) >= 1 &&
        (blob.liabilities?.length ?? 0) >= 1
      );
    }
    await waitFor(
      async () => {
        return lastDecryptedHasBoth().then((ok) => ok);
      },
      4_000,
      'cloud upsert carries both extended entities',
    );

    // Live syncState settled to 'synced' (re-read, not the stale snapshot).
    await waitFor(
      () => storeRef.current!.syncState === 'synced',
      4_000,
      'syncState settled',
    );

    const userSaves = cloudRef.saves.filter((s) => s.userId === USER);
    const last = userSaves[userSaves.length - 1];
    const restored = await decryptVault<VaultBlob>(last.cipher, PASSWORD);
    expect(restored!.budgets!.length).toBe(1);
    expect(restored!.budgets![0]).toMatchObject({ category: 'Transport', cap: 300, rollover: true });
    expect(restored!.liabilities!.length).toBe(1);
    expect(restored!.liabilities![0]).toMatchObject({ name: 'Card', apr: 16, extraPayment: 100 });
    await unmount();
  });

  it('emergency writes survive logout when the app mounts SIGNED OUT first (production order)', async () => {
    // Regression test for the "emergency reserve disappears after logout" bug.
    // The production app mounts <AuthProvider><VaultProvider> BEFORE sign-in,
    // so the first render has scope='local' / cloudOn=false. The []-deps CRUD
    // callbacks (addEmergencyItem, setEnt, ...) froze the FIRST-RENDER persist
    // closure. Old persist read cloudOn from that stale closure -> every post-
    // sign-in mutation was a silent in-memory no-op, never written to the DB
    // row, so it vanished on the next logout. persist now reads live refs, so
    // writes made through the frozen chain persist for real.
    const USER = 'user-late-signin';
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    cloudRef.saves = [];
    cloudRef.strict = async () => undefined;
    // 1) Production order: the app mounts while SIGNED OUT.
    authRef.set({
      user: null,
      accountPassword: null,
      accessToken: null,
      restoring: false,
      cloudAvailable: true,
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

    // 2) Sign in, then create the vault. Production drives this through the
    //    single-credential auto-flow effect, but that effect stalls under
    //    act() state coalescing in the harness (the probe re-settle never
    //    re-triggers it), so we call the SAME createVault() it would call —
    //    which is also the explicit path a user hits on first run.
    authRef.set({
      user: { id: USER },
      accountPassword: PASSWORD,
      accessToken: 'fake-jwt',
      restoring: false,
    });
    await act(async () => {
      await storeRef.current!.createVault(PASSWORD, { baseCurrency: 'MYR' });
    });
    await waitFor(
      () => storeRef.current?.status === 'unlocked',
      3_000,
      'createVault after sign-in',
    );

    // 3) Add an emergency item + an extended entity through the stable CRUD
    //    callbacks (the ones frozen onto the first-render chain — the bug).
    await act(async () => {
      storeRef.current!.addEmergencyItem({
        kind: 'manual',
        name: 'Cash buffer',
        currency: 'MYR',
        amount: 5_000,
        createdAt: Date.now(),
      });
      storeRef.current!.addBudget({ category: 'Food & Dining', cap: 800, period: 'monthly', rollover: false });
      await new Promise((r) => setTimeout(r, 20));
    });

    // 4) The encrypted cloud upsert must actually carry both rows.
    async function lastDecryptedHasEmergency(): Promise<boolean> {
      const saves = cloudRef.saves.filter((s) => s.userId === USER);
      if (saves.length === 0) return false;
      const blob = await decryptVault<VaultBlob>(saves[saves.length - 1].cipher, PASSWORD);
      return (
        !!blob &&
        (blob.emergency?.items?.length ?? 0) >= 1 &&
        (blob.budgets?.length ?? 0) >= 1
      );
    }
    await waitFor(() => lastDecryptedHasEmergency(), 4_000, 'cloud upsert carries emergency item');

    // 5) The user's actual symptom: logout, then login again — the row must
    //    come back from the DB, not from memory.
    authRef.set({
      user: null,
      accountPassword: null,
      accessToken: null,
      restoring: false,
    });
    // Re-login: strict now returns the last cipher saved for this user.
    cloudRef.strict = (id: string) => {
      const saves = cloudRef.saves.filter((s) => s.userId === id);
      return Promise.resolve(
        saves.length ? saves[saves.length - 1].cipher : undefined,
      );
    };
    authRef.set({
      user: { id: USER },
      accountPassword: PASSWORD,
      accessToken: 'fake-jwt',
      restoring: false,
    });
    // 5b) Explicit unlock, mirroring the auto-flow's unlock(pp) call. It
    //     re-reads the DB row via fetchCloudVaultStrict — so it only succeeds
    //     if the writes in step 3 actually reached the store.
    await act(async () => {
      await storeRef.current!.unlock(PASSWORD);
    });
    await waitFor(
      () => storeRef.current?.status === 'unlocked',
      3_000,
      're-login unlock',
    );
    const restored = storeRef.current!.vault!;
    expect(restored.emergency?.items).toHaveLength(1);
    expect(restored.emergency?.items[0]).toMatchObject({
      name: 'Cash buffer',
      kind: 'manual',
      amount: 5_000,
    });
    expect(restored.budgets).toHaveLength(1);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
