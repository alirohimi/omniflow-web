// ============================================================================
// OmniFlow — store (app-level state).
//
// Holds the decrypted VaultBlob in memory. The raw AES-GCM ciphertext is what
// persists to IndexedDB (offline cache). When a Supabase account is signed in
// the same ciphertext is also upserted to a per-user Postgres row (RLS-scoped
// to auth.uid()), giving multi-user sync. Plaintext never leaves the device;
// the passphrase stays in memory only.
//
// Usage (in App.tsx, inside <AuthProvider>):
//   const [creating, setCreating] = useState(true);
//   const store = useVaultStore(() => { setCreating(false); });
// ============================================================================

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  Expense,
  InvestmentAccount,
  InvestmentHolding,
  UserPreferences,
  VaultBlob,
  Category,
} from '../domain/types';
import { emptyVault, demoVault } from '../domain/seed';
import { encryptVault, decryptVault, fingerprintSecret, type VaultCipher } from '../security/vault';
import { hasVaultFor, loadCipherFor, saveVaultFor, wipeFor, wipeAllLocal } from '../security/persistence';
import { LLMConfig } from '../ai/categorize';
import { useAuthStore } from '../auth/AuthProvider';
import { fetchCloudVault, saveCloudVault, deleteCloudVault } from '../services/cloudVault';

export type VaultStatus = 'locked' | 'creating' | 'unlocked' | 'unavailable';
export type SyncState = 'idle' | 'syncing' | 'synced' | 'error';

export interface NewExpenseInput {
  originalAmount: number;
  originalCurrency: string;
  fxRate: number;      // units of base per 1 original
  category: string;
  aiTier: Expense['aiTier'];
  merchant: string;
  paymentMethod: Expense['paymentMethod'];
  source: Expense['source'];
  note?: string;
  receiptText?: string;
  /** Explicit timestamp (demo seed). Defaults to now. */
  timestamp?: number;
}

export interface NewHoldingInput {
  accountId: string;
  symbol: string;
  assetClass: InvestmentHolding['assetClass'];
  holdingCurrency: string;
  units: number;
  averageEntryPrice: number;
  currentPriceLocal?: number;
  currentPriceBase?: number;
}

export interface NewAccountInput {
  platformName: string;
  accountType: InvestmentAccount['accountType'];
}

export interface VaultStore {
  status: VaultStatus;
  error: string | null;

  // identity / sync
  /** 'local' when no account; otherwise the signed-in user's id. */
  scope: string;
  cloudSynced: boolean;
  syncState: SyncState;

  // lifecycle
  createVault: (passphrase: string, prefs?: Partial<UserPreferences>) => Promise<void>;
  unlock: (passphrase: string) => Promise<void>;
  lock: () => void;
  /** Wipe this scope's local cache and cloud row; return to first-run. */
  eraseAll: () => Promise<void>;
  /** Wipe every cached vault on this device (all scopes). */
  eraseAllLocal: () => Promise<void>;

  // data (no-ops when locked)
  vault: VaultBlob | null;
  llmConfig: LLMConfig | null;

  addExpense: (input: NewExpenseInput) => string;
  deleteExpense: (id: string) => void;
  addCategory: (name: string, icon: string) => void;

  addAccount: (input: NewAccountInput) => string;
  deleteAccount: (id: string) => void;
  addHolding: (input: NewHoldingInput) => string;
  deleteHolding: (id: string) => void;
  updateHoldingPrice: (id: string, local: number, base: number) => void;

  setPrefs: (patch: Partial<UserPreferences>) => void;
  setLlmKey: (provider: 'none' | 'openai' | 'anthropic', key: string) => void;
  /** Replace the current vault with the bundled demo dataset (keeps prefs). */
  loadDemo: () => void;

  categories: Category[];
}

const Ctx = createContext<VaultStore | null>(null);

export function useVaultStore(): VaultStore {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useVaultStore must be used within <VaultProvider>');
  return ctx;
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const auth = useAuthStore();
  const scope = auth.user?.id ?? 'local';
  // Cloud sync only when a real account is signed in (local-only never syncs).
  const cloudOn = auth.cloudAvailable && auth.user?.id != null;

  const [status, setStatus] = useState<VaultStatus>('locked');
  const [error, setError] = useState<string | null>(null);
  const [vault, setVault] = useState<VaultBlob | null>(null);
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const passRef = useRef<string>(''); // holds passphrase in-memory only
  const cipherRef = useRef<VaultCipher | null>(null); // last encrypted blob
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  // ---- cloud/local blob resolution (cloud wins, local is the offline cache) ----
  const resolveCipher = useCallback(
    async (): Promise<VaultCipher | undefined> => {
      if (cloudOn) {
        const remote = await fetchCloudVault(scope).catch(() => undefined);
        if (remote) return remote;
      }
      return (await loadCipherFor(scope).catch(() => undefined))?.cipher;
    },
    [cloudOn, scope],
  );

  // Serialised persist: every mutation enqueues behind the previous one so a
  // burst of rapid writes (e.g. loading demo data) is not dropped. Each entry
  // encrypts the `next` it was given, so the LAST write always wins.
  const persist = useCallback(
    async (next: VaultBlob) => {
      const pass = passRef.current;
      if (!pass) return;
      chainRef.current = chainRef.current.then(
        async () => {
          try {
            setSyncState(cloudOn ? 'syncing' : 'idle');
            const cipher = await encryptVault(next, pass);
            cipherRef.current = cipher;
            await saveVaultFor(scope, cipher); // offline cache (always)
            if (cloudOn) {
              await saveCloudVault(scope, cipher);
              setSyncState('synced');
            }
          } catch (e) {
            setSyncState('error');
            setError(e instanceof Error ? e.message : String(e));
          }
        },
      );
    },
    [scope, cloudOn],
  );

  // ---- re-probe on mount and whenever the active scope / cloud changes ----
  const probeKey = `${scope}|${cloudOn}`;
  useEffect(() => {
    let alive = true;
    // Reset any in-memory secrets for the previous scope.
    passRef.current = '';
    cipherRef.current = null;
    setVault(null);
    setError(null);
    setSyncState('idle');
    (async () => {
      const exists = cloudOn
        ? (await resolveCipher()) != null
        : await hasVaultFor(scope);
      if (!alive) return;
      setStatus(exists ? 'locked' : 'creating');
    })().catch(() => {
      if (alive) setStatus('creating');
    });
    return () => {
      alive = false;
    };
  }, [probeKey, scope, cloudOn, resolveCipher]);

  const applyVault = useCallback(
    (v: VaultBlob) => {
      setVault(v);
      void persist(v);
    },
    [persist],
  );

  const createVault = useCallback(
    async (passphrase: string, prefs?: Partial<UserPreferences>) => {
      if (!passphrase || passphrase.length < 4) {
        setError('Passphrase must be at least 4 characters.');
        return;
      }
      const v = emptyVault(prefs);
      const fp = await fingerprintSecret(passphrase);
      v.prefs.llmKeyFinger = fp.slice(0, 8);
      passRef.current = passphrase;
      applyVault(v);
      setStatus('unlocked');
      setError(null);
    },
    [applyVault],
  );

  const unlock = useCallback(
    async (passphrase: string) => {
      setError(null);
      try {
        const cipher = await resolveCipher();
        if (!cipher) {
          setStatus('creating');
          return;
        }
        const v = await decryptVault<VaultBlob>(cipher, passphrase);
        cipherRef.current = cipher;
        passRef.current = passphrase;
        setVault(v);
        setStatus('unlocked');
      } catch {
        setError('Wrong passphrase. Data is unreadable without it.');
        setStatus('locked');
      }
    },
    [resolveCipher],
  );

  const lock = useCallback(() => {
    setVault(null);
    passRef.current = '';
    cipherRef.current = null;
    setSyncState('idle');
    setStatus((s) => (s === 'unlocked' ? 'locked' : s));
    setError(null);
  }, []);

  const eraseAll = useCallback(async () => {
    await wipeFor(scope);
    if (cloudOn) await deleteCloudVault(scope);
    setVault(null);
    passRef.current = '';
    cipherRef.current = null;
    setSyncState('idle');
    setStatus('creating');
    setError(null);
  }, [scope, cloudOn]);

  const eraseAllLocal = useCallback(async () => {
    await wipeAllLocal();
    setVault(null);
    passRef.current = '';
    cipherRef.current = null;
    setSyncState('idle');
    setStatus('creating');
    setError(null);
  }, []);

  // ---- data mutators (guard: only when unlocked) ----

  const addExpense = useCallback(
    (input: NewExpenseInput): string => {
      const id = `ex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      setVault((prev) => {
        if (!prev) return prev;
        const exp: Expense = {
          id,
          baseCurrency: prev.prefs.baseCurrency,
          baseAmount: input.originalAmount * input.fxRate,
          timestamp: input.timestamp ?? Date.now(),
          ...input,
        };
        const next = { ...prev, expenses: [exp, ...prev.expenses], updatedAt: Date.now() };
        void persist(next);
        return next;
      });
      return id;
    },
    [persist],
  );

  const deleteExpense = useCallback(
    (id: string) => {
      setVault((prev) => {
        if (!prev) return prev;
        const next = { ...prev, expenses: prev.expenses.filter((e) => e.id !== id), updatedAt: Date.now() };
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  const addCategory = useCallback(
    (name: string, icon: string) => {
      setVault((prev) => {
        if (!prev || prev.categories.some((c) => c.name === name)) return prev;
        const next = {
          ...prev,
          categories: [...prev.categories, { id: `c-${name.toLowerCase().replace(/\s+/g, '-')}`, name, icon }],
          updatedAt: Date.now(),
        };
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  const addAccount = useCallback(
    (input: NewAccountInput): string => {
      const id = `acc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      setVault((prev) => {
        if (!prev) return prev;
        const acc: InvestmentAccount = {
          id,
          baseCurrencyValue: 0,
          lastUpdated: Date.now(),
          ...input,
        };
        const next = { ...prev, accounts: [...prev.accounts, acc], updatedAt: Date.now() };
        void persist(next);
        return next;
      });
      return id;
    },
    [persist],
  );

  const deleteAccount = useCallback(
    (id: string) => {
      setVault((prev) => {
        if (!prev) return prev;
        const next = {
          ...prev,
          accounts: prev.accounts.filter((a) => a.id !== id),
          holdings: prev.holdings.filter((h) => h.accountId !== id),
          updatedAt: Date.now(),
        };
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  const addHolding = useCallback(
    (input: NewHoldingInput): string => {
      const id = `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      setVault((prev) => {
        if (!prev) return prev;
        const h: InvestmentHolding = {
          id,
          currentPriceLocal: input.currentPriceLocal ?? input.averageEntryPrice,
          currentPriceBase: input.currentPriceBase ?? input.averageEntryPrice,
          ...input,
        };
        const next = { ...prev, holdings: [...prev.holdings, h], updatedAt: Date.now() };
        void persist(next);
        return next;
      });
      return id;
    },
    [persist],
  );

  const deleteHolding = useCallback(
    (id: string) => {
      setVault((prev) => {
        if (!prev) return prev;
        const next = { ...prev, holdings: prev.holdings.filter((h) => h.id !== id), updatedAt: Date.now() };
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  const updateHoldingPrice = useCallback(
    (id: string, local: number, base: number) => {
      setVault((prev) => {
        if (!prev) return prev;
        const next = {
          ...prev,
          holdings: prev.holdings.map((h) =>
            h.id === id ? { ...h, currentPriceLocal: local, currentPriceBase: base } : h,
          ),
          updatedAt: Date.now(),
        };
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  const setPrefs = useCallback(
    (patch: Partial<UserPreferences>) => {
      setVault((prev) => {
        if (!prev) return prev;
        const next = { ...prev, prefs: { ...prev.prefs, ...patch }, updatedAt: Date.now() };
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  const setLlmKey = useCallback(
    async (_provider: 'none' | 'openai' | 'anthropic', _key: string) => {
      // The BYOK key is stored encrypted inside the vault (re-decrypted per
      // session). Compute the display fingerprint outside the updater.
      const fp = _key ? (await fingerprintSecret(_key).catch(() => '')) : '';
      setVault((prev) => {
        if (!prev) return prev;
        const next = {
          ...prev,
          prefs: {
            ...prev.prefs,
            llmProvider: _key ? _provider : 'none',
            llmKeyFinger: fp.slice(0, 8),
          },
          llmKey: _key,
          updatedAt: Date.now(),
        };
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  const loadDemo = useCallback(() => {
    setVault((prev) => {
      if (!prev) return prev;
      const demo = demoVault();
      // Preserve the user's real prefs (base currency, keys) — only replace
      // the financial data, so demo load never clobbers security settings.
      const next: VaultBlob = {
        ...demo,
        prefs: prev.prefs,
        llmKey: prev.llmKey,
        createdAt: prev.createdAt,
        updatedAt: Date.now(),
      };
      void persist(next);
      return next;
    });
  }, [persist]);

  const llmConfig = useMemo<LLMConfig | null>(() => {
    if (!vault || vault.prefs.llmProvider === 'none' || !vault.llmKey) return null;
    return { provider: vault.prefs.llmProvider, apiKey: vault.llmKey };
  }, [vault]);

  const store: VaultStore = {
    status,
    error,
    scope,
    cloudSynced: cloudOn,
    syncState,
    createVault,
    unlock,
    lock,
    eraseAll,
    eraseAllLocal,
    vault,
    llmConfig,
    addExpense,
    deleteExpense,
    addCategory,
    addAccount,
    deleteAccount,
    addHolding,
    deleteHolding,
    updateHoldingPrice,
    setPrefs,
    setLlmKey,
    loadDemo,
    categories: vault?.categories ?? [],
  };

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}
