// ============================================================================
// OmniFlow — store (app-level state).
//
// Holds the decrypted VaultBlob in memory. The raw AES-GCM ciphertext is what
// persists to IndexedDB. On every mutation the vault is re-encrypted and
// saved. A wrong passphrase surfaces a decrypt failure (never a partial read).
//
// Usage (in App.tsx):
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
import { emptyVault } from '../domain/seed';
import { encryptVault, decryptVault, fingerprintSecret, type VaultCipher } from '../security/vault';
import { hasVault, loadCipher, saveVault, wipe } from '../security/persistence';
import { LLMConfig } from '../ai/categorize';

export type VaultStatus = 'locked' | 'creating' | 'unlocked' | 'unavailable';

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

  // lifecycle
  createVault: (passphrase: string, prefs?: Partial<UserPreferences>) => Promise<void>;
  unlock: (passphrase: string) => Promise<void>;
  lock: () => void;
  eraseAll: () => Promise<void>;

  // data (no-ops when locked)
  vault: VaultBlob | null;
  llmConfig: LLMConfig | null;

  addExpense: (input: NewExpenseInput) => void;
  deleteExpense: (id: string) => void;
  addCategory: (name: string, icon: string) => void;

  addAccount: (input: NewAccountInput) => void;
  deleteAccount: (id: string) => void;
  addHolding: (input: NewHoldingInput) => void;
  deleteHolding: (id: string) => void;
  updateHoldingPrice: (id: string, local: number, base: number) => void;

  setPrefs: (patch: Partial<UserPreferences>) => void;
  setLlmKey: (provider: 'none' | 'openai' | 'anthropic', key: string) => void;

  categories: Category[];
}

const Ctx = createContext<VaultStore | null>(null);

export function useVaultStore(): VaultStore {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useVaultStore must be used within <VaultProvider>');
  return ctx;
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<VaultStatus>('locked');
  const [error, setError] = useState<string | null>(null);
  const [vault, setVault] = useState<VaultBlob | null>(null);
  const passRef = useRef<string>(''); // holds passphrase in-memory only
  const saving = useRef(false);

  const persist = useCallback(async (next: VaultBlob) => {
    if (!passRef.current || saving.current) return;
    saving.current = true;
    try {
      const cipher = await encryptVault(next, passRef.current);
      await saveVault(cipher);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      saving.current = false;
    }
  }, []);

  // Initial probe: is there an existing vault?
  useEffect(() => {
    (async () => {
      const exists = await hasVault();
      setStatus(exists ? 'locked' : 'creating');
    })().catch(() => setStatus('creating'));
  }, []);

  const applyVault = useCallback((v: VaultBlob) => {
    setVault(v);
    void persist(v);
  }, [persist]);

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

  const unlock = useCallback(async (passphrase: string) => {
    setError(null);
    try {
      const cipher = await loadCipher();
      if (!cipher) {
        setStatus('creating');
        return;
      }
      const v = await decryptVault<VaultBlob>(cipher, passphrase);
      passRef.current = passphrase;
      setVault(v);
      setStatus('unlocked');
      // refresh from disk (no re-save needed; already at rest)
    } catch {
      setError('Wrong passphrase. Data is unreadable without it.');
      setStatus('locked');
    }
  }, []);

  const lock = useCallback(() => {
    setVault(null);
    passRef.current = '';
    setStatus((s) => (s === 'unlocked' ? 'locked' : s));
    setError(null);
  }, []);

  const eraseAll = useCallback(async () => {
    await wipe();
    setVault(null);
    passRef.current = '';
    setStatus('creating');
    setError(null);
  }, []);

  // ---- data mutators (guard: only when unlocked) ----

  const addExpense = useCallback(
    (input: NewExpenseInput) => {
      setVault((prev) => {
        if (!prev) return prev;
        const exp: Expense = {
          id: `ex-${Date.now().toString(36)}`,
          baseCurrency: prev.prefs.baseCurrency,
          baseAmount: input.originalAmount * input.fxRate,
          timestamp: Date.now(),
          ...input,
        };
        const next = { ...prev, expenses: [exp, ...prev.expenses], updatedAt: Date.now() };
        void persist(next);
        return next;
      });
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
    (input: NewAccountInput) => {
      setVault((prev) => {
        if (!prev) return prev;
        const acc: InvestmentAccount = {
          id: `acc-${Date.now().toString(36)}`,
          baseCurrencyValue: 0,
          lastUpdated: Date.now(),
          ...input,
        };
        const next = { ...prev, accounts: [...prev.accounts, acc], updatedAt: Date.now() };
        void persist(next);
        return next;
      });
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
    (input: NewHoldingInput) => {
      setVault((prev) => {
        if (!prev) return prev;
        const h: InvestmentHolding = {
          id: `h-${Date.now().toString(36)}`,
          currentPriceLocal: input.currentPriceLocal ?? input.averageEntryPrice,
          currentPriceBase: input.currentPriceBase ?? input.averageEntryPrice,
          ...input,
        };
        const next = { ...prev, holdings: [...prev.holdings, h], updatedAt: Date.now() };
        void persist(next);
        return next;
      });
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

  const llmConfig = useMemo<LLMConfig | null>(() => {
    if (!vault || vault.prefs.llmProvider === 'none' || !vault.llmKey) return null;
    return { provider: vault.prefs.llmProvider, apiKey: vault.llmKey };
  }, [vault]);

  const store: VaultStore = {
    status,
    error,
    createVault,
    unlock,
    lock,
    eraseAll,
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
    categories: vault?.categories ?? [],
  };

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}
