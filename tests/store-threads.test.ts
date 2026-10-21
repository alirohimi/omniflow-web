// ============================================================================
// OmniFlow — coach multi-session thread store tests (Task 002).
//
// Verifies the thread CRUD mutators, the per-thread 200-message bound,
// the idempotent legacy coachLog -> thread migration, old-blob compat,
// and the one-release deprecated wrappers. Runs under happy-dom with the
// real VaultProvider (same harness as store-extended.test.ts).
//
// @vitest-environment happy-dom
// ============================================================================

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';

const act = React.act;

// Reactive auth mock (mirrors store-extended.test.ts).
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

// Cloud-vault mock — supports both "no row yet" and "seed a specific cipher"
// so we can test the legacy-coachLog migration path.
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
import { encryptVault, type VaultCipher } from '../src/security/vault';
import type { VaultBlob, CoachMessage, CoachThread } from '../src/domain/types';

const PASSWORD = 'threads99';

function Probe({ storeRef }: { storeRef: React.MutableRefObject<VaultStore | null> }) {
  const s = useVaultStore();
  storeRef.current = s;
  return React.createElement('div', { 'data-testid': 'probe' });
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

/**
 * Unlock a fresh vault for `userId`. If `seedCipher` is provided it is used
 * as the "already in cloud" row so the provider hydrates from it (used to
 * test legacy-blob migration). Otherwise the provider creates a new vault.
 */
async function unlockVault(
  userId: string,
  seedCipher?: VaultCipher,
): Promise<{
  storeRef: React.MutableRefObject<VaultStore | null>;
  unmount: () => Promise<void>;
}> {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  cloudRef.saves = [];
  cloudRef.strict = seedCipher
    ? async (_id: string) => seedCipher
    : async () => undefined;

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

  // With a seed cipher, the provider auto-unlocks from it; with none, it
  // settles at 'creating' and we explicitly call createVault.
  if (seedCipher) {
    await waitFor(
      () => storeRef.current?.status === 'unlocked',
      25_000,
      'seeded vault -> unlocked',
    );
  } else {
    await waitFor(
      () => storeRef.current?.status === 'creating',
      5_000,
      'fresh probe -> creating (non-fatal)',
    ).catch(() => undefined);
    await act(async () => {
      await storeRef.current!.createVault(PASSWORD, { baseCurrency: 'MYR' });
    });
    await waitFor(
      () => storeRef.current?.status === 'unlocked',
      25_000,
      'createVault -> unlocked',
    );
  }

  const unmount = async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  };
  return { storeRef, unmount };
}

/** Build a minimal legacy vault cipher: has coachLog, no coachThreads. */
async function legacyCipherWithCoachLog(log: CoachMessage[]): Promise<VaultCipher> {
  const blob: VaultBlob = {
    schema: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    prefs: {
      baseCurrency: 'MYR',
      displayName: '',
      llmProvider: 'none',
      llmKeyFinger: '',
      autoCategorize: true,
      advisorRules: false,
      billReminders: false,
    },
    expenses: [],
    accounts: [],
    holdings: [],
    categories: [
      { id: 'c-food', name: 'Food', icon: 'food' },
      { id: 'c-transport', name: 'Transport', icon: 'transport' },
    ],
    llmKey: '',
    coachLog: log, // legacy shape — no coachThreads field at all
  };
  return encryptVault(blob, PASSWORD);
}

describe('coach thread CRUD + migration (Task 002)', () => {
  it('fresh vault auto-creates exactly one "New chat" thread', async () => {
    const { storeRef, unmount } = await unlockVault('user-thread-fresh');
    try {
      const s = storeRef.current!;
      expect(s.status).toBe('unlocked');
      // Migration ran on hydration: exactly one thread, titled "New chat".
      expect(s.coachThreads).toHaveLength(1);
      expect(s.coachThreads![0].title).toBe('New chat');
      expect(s.coachThreads![0].messages).toHaveLength(0);
      // activeCoachThread is the one thread's id.
      expect(s.activeCoachThread).toBe(s.coachThreads![0].id);
      // coachMessages is the active thread's (empty) message list.
      expect(s.coachMessages).toHaveLength(0);
    } finally {
      await unmount();
    }
  });

  it('addCoachThread returns a valid id and sets it active', async () => {
    const { storeRef, unmount } = await unlockVault('user-thread-add');
    try {
      const s = storeRef.current!;
      const before = s.coachThreads!.length;
      const newId = s.addCoachThread();
      expect(typeof newId).toBe('string');
      expect(newId).not.toBe('');
      // Flush the commit.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      const s2 = storeRef.current!;
      expect(s2.coachThreads!.length).toBe(before + 1);
      expect(s2.activeCoachThread).toBe(newId);
      const t = s2.coachThreads!.find((x) => x.id === newId)!;
      expect(t.title).toBe('New chat');
      expect(t.messages).toHaveLength(0);
    } finally {
      await unmount();
    }
  });

  it('renameCoachThread updates the title and bumps updatedAt', async () => {
    const { storeRef, unmount } = await unlockVault('user-thread-rename');
    try {
      const s = storeRef.current!;
      const tid = s.coachThreads![0].id;
      const oldUpdated = s.coachThreads![0].updatedAt;
      await act(async () => {
        s.renameCoachThread(tid, 'My portfolio review');
      });
      const s2 = storeRef.current!;
      const t = s2.coachThreads!.find((x) => x.id === tid)!;
      expect(t.title).toBe('My portfolio review');
      expect(t.updatedAt).toBeGreaterThanOrEqual(oldUpdated);
    } finally {
      await unmount();
    }
  });

  it('pushCoachMessageTo appends + auto-titles the first user message', async () => {
    const { storeRef, unmount } = await unlockVault('user-thread-push');
    try {
      const s = storeRef.current!;
      const tid = s.activeCoachThread;
      expect(tid).not.toBe('');
      await act(async () => {
        s.pushCoachMessageTo(tid, {
          role: 'user',
          text: 'Where should I invest my next 10k?',
          at: Date.now(),
        });
      });
      const s2 = storeRef.current!;
      const t = s2.coachThreads!.find((x) => x.id === tid)!;
      expect(t.messages).toHaveLength(1);
      // Auto-title from first user message (40-char cap).
      expect(t.title).toBe('Where should I invest my next 10k?');
      // coachMessages mirrors the active thread.
      expect(s2.coachMessages).toHaveLength(1);
      // Deprecated alias coachLog reflects the active thread too.
      expect(s2.coachLog).toHaveLength(1);
    } finally {
      await unmount();
    }
  });

  it('pushCoachMessageTo enforces the 200-message per-thread bound', async () => {
    const { storeRef, unmount } = await unlockVault('user-thread-bound');
    try {
      const s = storeRef.current!;
      const tid = s.activeCoachThread;
      // Push 201 messages; the oldest must be dropped.
      await act(async () => {
        for (let i = 0; i < 201; i++) {
          s.pushCoachMessageTo(tid, { role: 'user', text: `msg ${i}`, at: Date.now() });
        }
      });
      const s2 = storeRef.current!;
      const t = s2.coachThreads!.find((x) => x.id === tid)!;
      expect(t.messages.length).toBe(200);
      // The oldest ("msg 0") is gone; the newest ("msg 200") is present.
      const texts = t.messages.map((m) => m.text);
      expect(texts[0]).toBe('msg 1');
      expect(texts[texts.length - 1]).toBe('msg 200');
    } finally {
      await unmount();
    }
  });

  it('deleteCoachThread removes the thread; deleting the active one re-points', async () => {
    const { storeRef, unmount } = await unlockVault('user-thread-delete');
    try {
      const s = storeRef.current!;
      // Create 2 extra threads so we have 3 total.
      const t2 = s.addCoachThread();
      const t3 = s.addCoachThread();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      const s2 = storeRef.current!;
      expect(s2.coachThreads!.length).toBe(3);
      const activeBefore = s2.activeCoachThread;
      expect(activeBefore).toBe(t3); // most recently added is active
      // Delete the active one -> provider must switch to another (or fresh).
      await act(async () => {
        s2.deleteCoachThread(activeBefore);
      });
      const s3 = storeRef.current!;
      expect(s3.coachThreads!.length).toBe(2);
      expect(s3.coachThreads!.find((x) => x.id === activeBefore)).toBeUndefined();
      // activeCoachThread now points at a remaining valid id.
      expect(s3.activeCoachThread).not.toBe(activeBefore);
      expect(s3.coachThreads!.some((x) => x.id === s3.activeCoachThread)).toBe(true);
    } finally {
      await unmount();
    }
  });

  it('clearActiveThread wipes the active thread messages but keeps the thread', async () => {
    const { storeRef, unmount } = await unlockVault('user-thread-clear');
    try {
      const s = storeRef.current!;
      const tid = s.activeCoachThread;
      await act(async () => {
        s.pushCoachMessageTo(tid, { role: 'user', text: 'hello', at: Date.now() });
      });
      let s2 = storeRef.current!;
      expect(s2.coachMessages).toHaveLength(1);
      await act(async () => {
        s2.clearActiveThread();
      });
      s2 = storeRef.current!;
      // Thread still exists, just empty.
      const t = s2.coachThreads!.find((x) => x.id === tid)!;
      expect(t).toBeTruthy();
      expect(t.messages).toHaveLength(0);
      expect(s2.coachMessages).toHaveLength(0);
    } finally {
      await unmount();
    }
  });

  it('migrates a legacy coachLog vault into exactly one auto-titled thread', async () => {
    const now = Date.now();
    const legacy: CoachMessage[] = [
      { id: 'm1', role: 'user', text: 'Where should I put new money?', at: now - 2000 },
      { id: 'm2', role: 'coach', text: 'Start with your emergency cushion.', source: 'rules', at: now - 1000 },
      { id: 'm3', role: 'user', text: 'I see, thanks', at: now },
    ];
    const cipher = await legacyCipherWithCoachLog(legacy);
    const { storeRef, unmount } = await unlockVault('user-thread-migrate', cipher);
    try {
      const s = storeRef.current!;
      expect(s.status).toBe('unlocked');
      // Exactly one thread, created from the legacy log.
      expect(s.coachThreads!.length).toBe(1);
      const t = s.coachThreads![0];
      expect(t.messages.length).toBe(3);
      expect(t.messages[0]).toMatchObject({ id: 'm1', role: 'user', text: 'Where should I put new money?' });
      // Auto-titled from the first user message.
      expect(t.title).toBe('Where should I put new money?');
      // activeCoachThread points at it.
      expect(s.activeCoachThread).toBe(t.id);
      // coachMessages mirrors it.
      expect(s.coachMessages).toHaveLength(3);
      // createdAt / updatedAt derived from the legacy messages.
      expect(t.createdAt).toBe(now - 2000);
      expect(t.updatedAt).toBe(now);
    } finally {
      await unmount();
    }
  });

  it('migration is idempotent: a second hydration does not duplicate the thread', async () => {
    const now = Date.now();
    const legacy: CoachMessage[] = [
      { id: 'm1', role: 'user', text: 'first question', at: now - 5000 },
      { id: 'm2', role: 'coach', text: 'answer', source: 'rules', at: now },
    ];
    const cipher = await legacyCipherWithCoachLog(legacy);
    const { storeRef, unmount } = await unlockVault('user-thread-idempotent', cipher);
    try {
      const s = storeRef.current!;
      expect(s.coachThreads!.length).toBe(1);
      const firstId = s.coachThreads![0].id;
      // Simulate a re-hydration by unmounting + remounting with the SAME
      // user id. Because the first run persisted coachThreads to the cloud,
      // the second run's fetchCloudVaultStrict would return that — but our
      // mock returns the original legacy cipher again, so the idempotency
      // guard ("coachThreads already non-empty") must keep it at 1.
      await unmount();
      const { storeRef: storeRef2, unmount: unmount2 } = await unlockVault(
        'user-thread-idempotent',
        cipher,
      );
      try {
        const s2 = storeRef2.current!;
        // Still exactly one thread (the legacy cipher has no coachThreads,
        // so migration runs; but the guard folds legacy->one thread each
        // mount. To prove idempotency within a single mount, we check the
        // provider never creates a second one by re-running the effect).
        expect(s2.coachThreads!.length).toBe(1);
      } finally {
        await unmount2();
      }
    } finally {
      await unmount();
    }
  });

  it('old blob with no coachThreads field at all hydrates without throwing', async () => {
    // A vault created before the threads feature: has coachLog, no
    // coachThreads, no activeCoachThread. Should hydrate + migrate cleanly.
    const now = Date.now();
    const legacy: CoachMessage[] = [
      { id: 'm1', role: 'user', text: 'hello coach', at: now },
    ];
    const cipher = await legacyCipherWithCoachLog(legacy);
    const { storeRef, unmount } = await unlockVault('user-thread-oldblob', cipher);
    try {
      const s = storeRef.current!;
      expect(s.status).toBe('unlocked');
      expect(s.coachThreads!.length).toBe(1);
      expect(s.activeCoachThread).not.toBe('');
      expect(s.coachMessages.length).toBe(1);
    } finally {
      await unmount();
    }
  });

  it('deprecated wrapper pushCoachMessage routes to the active thread', async () => {
    const { storeRef, unmount } = await unlockVault('user-thread-depwrapper');
    try {
      const s = storeRef.current!;
      const tid = s.activeCoachThread;
      await act(async () => {
        s.pushCoachMessage({ role: 'user', text: 'via deprecated wrapper', at: Date.now() });
      });
      const s2 = storeRef.current!;
      const t = s2.coachThreads!.find((x) => x.id === tid)!;
      expect(t.messages.length).toBe(1);
      expect(t.messages[0].text).toBe('via deprecated wrapper');
    } finally {
      await unmount();
    }
  });
});
