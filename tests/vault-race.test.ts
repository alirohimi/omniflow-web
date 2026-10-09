// ============================================================================
// OmniFlow — vault scope-race regression test.
//
// Reproduces the "chat history lost after logout" incident: the single-
// credential auto-flow used to fire on `status === 'creating'` WITHOUT
// waiting for the current scope's DB probe to settle. Sign-in landing while
// the previous probe was still in flight left a stale 'creating' status, so
// createVault upserted an EMPTY vault over the user's real encrypted row.
//
// Two guards close the race:
//   1. probeSettledRef (synchronous, same-commit) + probeSettled state
//      (re-trigger) gate the auto-flow effect.
//   2. createVault's wipe-guard re-checks the DB right before writing an
//      empty vault; if a row appeared, it unlocks instead of overwriting.
//
// This test renders the REAL VaultProvider under a reactive mocked auth
// layer and a controllable cloud layer, then drives the exact
// logout -> sign-in -> DB-read sequence and asserts the real vault is
// unlocked (coachLog intact) and no empty vault is ever written.
//
// @vitest-environment happy-dom
// ============================================================================

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';

// React 18.3 exposes act on the React namespace; react-dom/test-utils is
// deprecated and warns on import.
const act = React.act;

// ============================================================================
// Reactive auth mock
// ============================================================================
// The real AuthProvider is a React context provider backed by useState;
// mutating auth.user triggers a re-render of every consumer. We mirror that
// with useSyncExternalStore so the VaultProvider actually re-renders when
// we call authRef.set() — without this the sign-in transition never lands
// and the race is untestable.

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

// Cloud mock: strict read is assignable per test (deferred promise for the
// race), saves are recorded for post-mutation assertions.
const cloudRef = vi.hoisted(() => ({
  strict: ((async (_id: string) => undefined) as unknown as (
    id: string,
  ) => Promise<import('../src/security/vault').VaultCipher | undefined>),
  saves: [] as unknown[],
}));

// ============================================================================
// vi.mock factories (hoisted above imports)
// ============================================================================

vi.mock('../src/auth/AuthProvider', () => {
  const useAuthStore = () => {
    const v = React.useSyncExternalStore(
      (cb: () => void) => authRef.subscribe(cb),
      () => authRef.version,
      () => authRef.version,
    );
    void v;
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
  const AuthProvider = ({ children }: { children: React.ReactNode }) =>
    children;
  return { useAuthStore, AuthProvider };
});

vi.mock('../src/services/cloudVault', () => ({
  fetchCloudVaultStrict: (id: string) => cloudRef.strict(id),
  saveCloudVault: async (userId: string, cipher: unknown) => {
    cloudRef.saves.push({ userId, cipher });
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
  wipeMemberVault: async () => false,
}));

// ============================================================================
// Under-test imports (loaded after mocks)
// ============================================================================

import { VaultProvider, useVaultStore, type VaultStore } from '../src/store/store';
import { emptyVault } from '../src/domain/seed';
import { encryptVault, decryptVault, type VaultCipher } from '../src/security/vault';

const USER_ID = 'user-1';
const PASSWORD = 'hunter22';

// ---- helpers ---------------------------------------------------------------

function Probe({ storeRef }: { storeRef: React.MutableRefObject<VaultStore | null> }) {
  const s = useVaultStore();
  storeRef.current = s;
  return React.createElement('div', {
    'data-testid': 'probe',
    'data-status': s.status,
  });
}

function makeDeferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Poll a condition every 10 ms until it holds or the timeout expires.
 *
 * Every tick runs inside its own `act`: the store's async chains
 * (probe -> settle -> auto-flow effect -> unlock/createVault) fire state
 * updates from fire-and-forget continuations OUTSIDE any act boundary, and
 * React 18 defers committing them until an act returns. Wrapping the whole
 * poll in ONE act would deadlock (the commit needed to satisfy the predicate
 * never happens before the act body ends). Per-tick act flushing lets each
 * pending commit land before the next ref read.
 */
async function waitFor(
  fn: () => boolean,
  timeoutMs = 2_000,
  label = 'condition',
  describe?: () => string,
): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(
        `waitFor timed out: ${label}${describe ? ` | ${describe()}` : ''}`,
      );
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

function diag(storeRef: React.MutableRefObject<VaultStore | null>) {
  const s = storeRef.current;
  return s
    ? `status=${s.status} error=${s.error ?? 'none'} vault=${s.vault ? 'yes' : 'no'} coach=${s.coachLog?.length ?? 0}`
    : 'storeRef.current=null';
}

async function buildRealCipher() {
  const now = Date.now();
  const blob = {
    ...emptyVault(),
    coachLog: [
      { id: 'cm-1', role: 'user' as const, text: 'where did my money go in March?', at: now - 60_000 },
      { id: 'cm-2', role: 'coach' as const, text: 'Most of it went to groceries.', source: 'rules' as const, at: now - 50_000 },
    ],
  };
  const cipher = await encryptVault(blob, PASSWORD);
  return { blob, cipher };
}

function freshMount() {
  const storeRef = React.createRef<VaultStore | null>();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  return { storeRef, container, root };
}

function resetAuth() {
  authRef.set({
    user: null,
    accountPassword: null,
    accessToken: 'fake-jwt',
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('vault scope race (logout -> sign-in)', () => {
  it('sign-in while a scope probe is in flight unlocks the REAL vault, never wipes it', async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const { blob, cipher } = await buildRealCipher();
    resetAuth();
    cloudRef.saves = [];

    // DB read for the signed-in user is held open until we release it —
    // this is the in-flight probe that used to be raced against.
    const gate = makeDeferred<VaultCipher | undefined>();
    cloudRef.strict = async (id: string) => {
      if (id === USER_ID) return gate.promise;
      return undefined; // signed-out 'local' scope: no row
    };

    const { storeRef, container, root } = freshMount();

    // 1) Signed OUT: probe settles with 'creating' (no row under 'local').
    await act(async () => {
      root.render(
        React.createElement(VaultProvider, null, React.createElement(Probe, { storeRef })),
      );
    });
    // Poll for the local-scope probe to settle. `?.` guards against the
    // first tick firing before the Probe render has assigned the ref.
    // waitFor flushes its own commit per tick — do NOT wrap it in an outer
    // act (nested act is unsupported in React 18 and deadlocks the poll).
    await waitFor(() => storeRef.current?.status === 'creating', 2_000, "local probe -> 'creating'");
    expect(storeRef.current!.status).toBe('creating');

    // 2) Sign-in lands while the user-scoped DB read is still in flight.
    //    This triggers a re-render of VaultProvider (scope changes), which
    //    starts a NEW probe for USER_ID (deferred). The OLD probe's
    //    'creating' status is now stale — the race window.
    await act(async () => {
      authRef.set({ user: { id: USER_ID }, accountPassword: PASSWORD });
    });

    // 3) Release the DB read: the real encrypted row comes back.
    await act(async () => {
      gate.resolve(cipher);
    });
    // Let the probe settle + auto-unlock chain fully run. (No outer act —
    // waitFor already flushes a commit on every tick.)
    await waitFor(
      () => storeRef.current?.status === 'unlocked',
      2_000,
      'auto-unlock -> "unlocked"',
      () => diag(storeRef),
    );

    const store = storeRef.current!;
    expect(store.status).toBe('unlocked');
    // The real coach history survived — not an empty vault.
    expect(store.coachLog?.length).toBe(2);
    expect(store.coachLog?.[0].text).toBe(blob.coachLog![0].text);

    // 4) A follow-up mutation re-upserts the REAL blob (never an empty one).
    //    The addExpense itself is a synchronous state mutation -> act; the
    //    waitFor that polls the resulting cloud upsert runs OUTSIDE the act
    //    (it flushes its own commit per tick — nesting it in act deadlocks).
    await act(async () => {
      store.addExpense({
        originalAmount: 5,
        originalCurrency: 'USD',
        fxRate: 4.1667,
        category: 'Food & Dining',
        aiTier: 'dictionary',
        merchant: 'Race test',
        paymentMethod: 'card',
        source: 'manual',
        timestamp: Date.now(),
      });
    });
    await waitFor(
      () =>
        cloudRef.saves.length > 0 &&
        (cloudRef.saves[cloudRef.saves.length - 1] as { userId: string }).userId === USER_ID,
      2_000,
      'follow-up upsert of the real blob',
    );
    const lastSave = cloudRef.saves[cloudRef.saves.length - 1] as {
      userId: string;
      cipher: VaultCipher;
    };
    expect(lastSave.userId).toBe(USER_ID);
    const reread = await decryptVault(lastSave.cipher, PASSWORD);
    expect((reread as typeof blob).coachLog?.length).toBe(2);
    expect((reread as typeof blob).expenses.length).toBe(1);

    root.unmount();
    container.remove();
  });

  it('createVault never overwrites an existing row (wipe guard)', async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const { cipher } = await buildRealCipher();
    resetAuth();
    cloudRef.saves = [];

    // Resolves immediately: row exists, no deferred.
    cloudRef.strict = async (id: string) => (id === USER_ID ? cipher : undefined);

    const { storeRef, container, root } = freshMount();

    // Signed in from the start; probe settles -> 'locked' (row exists),
    // then the auto-flow effect unlocks it.
    await act(async () => {
      authRef.set({ user: { id: USER_ID }, accountPassword: PASSWORD });
      root.render(
        React.createElement(VaultProvider, null, React.createElement(Probe, { storeRef })),
      );
    });
    // Let the probe + auto-unlock chain fully settle. (No outer act.)
    await waitFor(() => storeRef.current?.status === 'unlocked', 2_000, 'auto-unlock -> "unlocked"');
    expect(storeRef.current!.status).toBe('unlocked');
    expect(storeRef.current!.coachLog?.length).toBe(2);

    // Force the guarded path directly: calling createVault while a row
    // exists must unlock it, not write an empty vault. createVault is a
    // user-initiated async op -> act; the unlock poll runs OUTSIDE it.
    cloudRef.saves = [];
    await act(async () => {
      await storeRef.current!.createVault(PASSWORD);
    });
    await waitFor(() => storeRef.current?.status === 'unlocked', 2_000, 'guarded createVault unlock');
    expect(storeRef.current!.status).toBe('unlocked');
    expect(storeRef.current!.coachLog?.length).toBe(2);
    expect(cloudRef.saves.length).toBe(0); // no empty-vault upsert

    root.unmount();
    container.remove();
  });
});
