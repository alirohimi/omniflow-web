// ============================================================================
// OmniFlow — store (app-level state).
//
// Holds the decrypted VaultBlob in memory. The raw AES-GCM ciphertext is the
// ONLY persisted form, and it lives in the per-user Supabase Postgres row
// (omniflow_vaults, RLS-scoped to auth.uid()). There is no local copy: no
// IndexedDB, no localStorage. The database is the single source of truth —
// every mutation re-encrypts the whole blob and upserts the ciphertext.
//
// Single-credential security: the account password (the Supabase sign-in
// password) is ALSO the vault key. After sign-in / email-code confirmation it
// is held in memory only and used to auto-create or auto-unlock the vault.
// After a lock, the one-field "Password" gate re-asks for it. No separate
// passphrase exists anywhere.
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
  CoachMessage,
  LLMProvider,
} from '../domain/types';
import { emptyVault } from '../domain/seed';
import { encryptVault, decryptVault, fingerprintSecret, type VaultCipher } from '../security/vault';
import { LLMConfig } from '../ai/categorize';
import { useAuthStore } from '../auth/AuthProvider';
import { fetchCloudVaultStrict, saveCloudVault, deleteCloudVault, flushVaultKeepalive } from '../services/cloudVault';
import {
  type LlmPolicyRow,
  type MemberRow,
  type VaultSyncRow,
  type PolicySummary,
  isAdmin,
  getMyLlmPolicy,
  upsertSelfMember,
  listMembers,
  listVaultSync,
  listAdminIds,
  listPolicies,
  grantAdmin,
  revokeAdmin,
  setLlmPolicy as adminSetLlmPolicy,
  clearLlmPolicy as adminClearLlmPolicy,
  wipeMemberVault,
} from '../services/admin';

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
  /** Explicit timestamp. Defaults to now. */
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
  // cloud sync status (supabase)
  syncState: SyncState;

  // lifecycle
  createVault: (password: string, prefs?: Partial<UserPreferences>) => Promise<void>;
  /**
   * Returns the resulting vault status so callers can react: 'creating'
   * means "no vault row exists yet" and the caller should auto-create.
   */
  unlock: (password: string) => Promise<VaultStatus>;
  lock: () => void;
  /**
   * Change the account password. The password doubles as the vault key:
   * 1) update the Supabase auth password, 2) re-encrypt the whole vault blob
   * under the new password and upsert the row. Step 1 is rolled back when
   * step 2 fails, so the account password and the vault key can never diverge.
   */
  changePassword: (current: string, next: string) => Promise<void>;
  /** Wipe this user's DB row and reset to first-run. */
  eraseAll: () => Promise<void>;

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
  /** Patch an existing holding (units, entry, symbol, class, currency, account). */
  updateHolding: (id: string, patch: Partial<Omit<InvestmentHolding, 'id'>>) => void;
  updateHoldingPrice: (id: string, local: number, base: number) => void;

  setPrefs: (patch: Partial<UserPreferences>) => void;
  setLlmKey: (
    provider: 'none' | 'openai' | 'anthropic' | 'gemini' | 'adacode',
    key: string,
    model?: string,
  ) => Promise<boolean>;
  /** Re-push the in-memory vault after a failed cloud save. */
  retrySync: () => void;

  // Admin & LLM policy (RLS-gated; no-ops when cloud is off or the 0002
  // migration has not been applied yet). See services/admin.ts.
  /** True when the signed-in user is in the admin registry. */
  isAdminUser: boolean;
  /** This user's admin-assigned LLM policy, when one exists. */
  llmPolicy: import('../services/admin').LlmPolicyRow | undefined;
  /** Directory of registered members (admin UI). */
  adminMembers: () => Promise<import('../services/admin').MemberRow[]>;
  /** Per-user vault sync metadata (admin UI; ciphertext rows only). */
  adminVaultSync: () => Promise<import('../services/admin').VaultSyncRow[]>;
  /** Admin-only: promote a user to admin. */
  adminGrant: (targetUserId: string) => Promise<boolean>;
  /** Admin-only: demote a user. */
  adminRevoke: (targetUserId: string) => Promise<boolean>;
  /** Admin-only: lock a user's LLM provider/key/model ('none' + empty key = unlock). */
  adminSetLlm: (
    targetUserId: string,
    provider: LLMProvider,
    apiKey: string,
    model: string,
    keyFinger: string,
  ) => Promise<boolean>;
  /** Admin-only: clear a user's LLM policy (fully unlock their LLM section). */
  adminClearLlm: (targetUserId: string) => Promise<boolean>;
  /** Admin-only: delete a member's encrypted vault row (irreversible). */
  adminWipeVault: (targetUserId: string) => Promise<boolean>;
  /** Current admin registry (user_ids) — for UI badges. */
  adminIds: () => Promise<string[]>;
  /** Admin-only: per-member LLM policy summary (fingerprint, never the raw key). */
  adminPolicies: () => Promise<import('../services/admin').PolicySummary[]>;

  // Coach (conversational advisor) — persisted encrypted with the vault.
  coachLog: CoachMessage[];
  /** Append a chat turn (bounded: the last 200 messages are kept). */
  pushCoachMessage: (msg: Omit<CoachMessage, 'id'>) => void;
  clearCoachLog: () => void;

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
  // DB-only: the vault row is always the signed-in user's. 'local' is a
  // fallback key that is never persisted (cloudVault is a no-op without a
  // real user id), so the vault exists only in memory until sign-in.
  const scope = auth.user?.id ?? 'local';
  const cloudOn = auth.cloudAvailable && auth.user?.id != null;

  const [status, setStatus] = useState<VaultStatus>('locked');
  const [error, setError] = useState<string | null>(null);
  const [vault, setVault] = useState<VaultBlob | null>(null);
  const [syncState, setSyncState] = useState<SyncState>('idle');
  // True once the current scope's DB probe has settled (row found/absent or
  // unreachable). Ref version is the authoritative same-commit gate: effects
  // run in declaration order, so the probe effect's synchronous write is
  // visible to the auto-flow effect that runs a moment later in the SAME
  // commit (a React state flag lags one render and would let a stale sign-in
  // auto-create fire — the "history lost after logout" bug). The state
  // mirrors it only to re-trigger the auto-flow effect when a probe settles.
  const probeSettledRef = useRef(false);
  const [probeSettled, setProbeSettled] = useState(false);
  // ---- admin / LLM-policy state (populated only for a signed-in cloud user;
  // ---- every read/write is RLS-gated server-side, see services/admin.ts) ----
  const [isAdminUser, setIsAdminUser] = useState(false);
  const [llmPolicy, setLlmPolicy] = useState<LlmPolicyRow | undefined>(undefined);
  const passRef = useRef<string>(''); // holds passphrase in-memory only
  const cipherRef = useRef<VaultCipher | null>(null); // last encrypted blob
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  // Probe admin status + pull this user's LLM policy when the cloud user is
  // known. Both are no-ops (feature off) when the 0002 migration has not been
  // applied yet — the app keeps working on local BYOK settings.
  const adminUserKey = cloudOn ? scope : '';
  useEffect(() => {
    let alive = true;
    if (!adminUserKey) {
      setIsAdminUser(false);
      setLlmPolicy(undefined);
      return;
    }
    (async () => {
      const [admin, policy] = await Promise.all([
        isAdmin(adminUserKey),
        getMyLlmPolicy(adminUserKey),
      ]);
      if (!alive) return;
      setIsAdminUser(admin);
      setLlmPolicy(policy);
    })();
    return () => {
      alive = false;
    };
  }, [adminUserKey]);

  // Self-register in the member directory whenever a cloud user signs in, so
  // admins can see who is registered. Fire-and-forget; idempotent upsert.
  const displayName = auth.user?.user_metadata?.display_name ?? '';
  useEffect(() => {
    const u = auth.user;
    if (!cloudOn || !u) return;
    void upsertSelfMember(u.id, u.email ?? '', displayName);
  }, [cloudOn, scope, displayName]);

  // ---- blob resolution (the DB row is the single source of truth) ----
  // Strict: throws on a genuine DB/network failure so the caller can tell
  // "no row yet" (first run) apart from "DB unreachable" (retry) — a hiccup
  // must never be mistaken for a fresh account and wipe the real vault.
  const resolveCipher = useCallback(async (): Promise<VaultCipher | undefined> => {
    if (!cloudOn) return undefined;
    return fetchCloudVaultStrict(scope);
  }, [cloudOn, scope]);

  // Serialised persist: every mutation enqueues behind the previous one so a
  // burst of rapid writes is not dropped. Each entry re-encrypts the whole
  // blob it was given, so the LAST write wins in the DB.
  // There is no local write path — the DB row is the only copy.
  const persist = useCallback(
    async (next: VaultBlob) => {
      const pass = passRef.current;
      if (!pass || !cloudOn) return; // unsigned-in scope: in-memory only
      chainRef.current = chainRef.current.then(
        async () => {
          try {
            setSyncState('syncing');
            const cipher = await encryptVault(next, pass);
            cipherRef.current = cipher;
            const ok = await saveCloudVault(scope, cipher);
            if (ok) {
              setSyncState('synced');
              setError(null);
            } else {
              setSyncState('error');
              setError('Cloud save failed — your latest change is in memory only. Retry or it will be lost on reload.');
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

  // ---- keepalive last-save flush (unload-time persistence) -----------------
  // The normal persist() above is fire-and-forget: if the tab closes or
  // reloads while the last upsert is still in flight, that fetch is aborted
  // and the newest vault change (chat history, an expense, a holding) never
  // reaches the DB. cipherRef.current always holds the last *encrypted* blob,
  // so on visibility-hidden / pagehide we re-send it via a keepalive fetch
  // (the only transport that survives document teardown). Idempotent and
  // best-effort: re-sending an already-synced blob changes nothing.
  const flushStateRef = useRef<{ user: string; token: string | null; cloudOn: boolean }>({
    user: scope,
    token: auth.accessToken,
    cloudOn,
  });
  useEffect(() => {
    flushStateRef.current = { user: scope, token: auth.accessToken, cloudOn };
  }, [scope, auth.accessToken, cloudOn]);

  useEffect(() => {
    let hiddenArmed = false;
    const flush = () => {
      const s = flushStateRef.current;
      const cipher = cipherRef.current;
      // 'local' scope is the unsigned-in fallback; only a real cloud user has
      // a row to flush and a JWT to authenticate it with.
      if (!s.cloudOn || s.user === 'local' || !s.token || !cipher) return;
      flushVaultKeepalive(s.user, cipher, s.token);
    };
    const onPageHide = () => flush();
    const onVis = () => {
      // Arm on the *first* hidden transition so we catch a backgrounded tab
      // (iOS Safari aggressively suspends background tabs), not just close.
      if (document.visibilityState === 'hidden' && !hiddenArmed) {
        hiddenArmed = true;
        flush();
        window.setTimeout(() => {
          hiddenArmed = false;
        }, 0);
      }
    };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

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
    // This probe's result has not settled yet: auto create/unlock must wait.
    // The ref is written synchronously so it gates the same-commit effect
    // runs; the state re-triggers the auto-flow once the probe has settled.
    probeSettledRef.current = false;
    setProbeSettled(false);
    (async () => {
      // DB-only: a vault exists iff the signed-in user has a row.
      try {
        const exists = cloudOn ? (await resolveCipher()) != null : false;
        if (!alive) return;
        setStatus(exists ? 'locked' : 'creating');
      } catch (e) {
        // The DB was unreachable (network / PostgREST down). That is NOT a
        // first run: landing on 'creating' would let the auto-create effect
        // wipe a real vault. 'unavailable' shows a retry screen instead.
        if (!alive) return;
        setError(e instanceof Error ? e.message : 'Could not reach your data store.');
        setStatus('unavailable');
      } finally {
        // Settled either way (row found, none, or DB down). Only the probe
        // for the CURRENT scope may flip this — a stale probe finishing late
        // must not ungate the new scope's auto flow.
        if (alive) {
          probeSettledRef.current = true;
          setProbeSettled(true);
        }
      }
    })();
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
    async (password: string, prefs?: Partial<UserPreferences>) => {
      if (!password || password.length < 4) {
        setError('Password must be at least 4 characters.');
        return;
      }
      // Wipe guard (defense in depth): an empty-vault upsert here would
      // DESTROY any existing row under this scope. So re-verify the DB
      // right before writing: a row that appeared since the probe (or a
      // probe that was stale) means "unlock it, don't overwrite"; a DB
      // failure means "stay put, show retry" — never create.
      if (cloudOn && scope !== 'local') {
        let existing: VaultCipher | undefined;
        try {
          existing = await resolveCipher();
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Could not reach your data store.');
          setStatus('unavailable');
          return;
        }
        if (existing) {
          // A vault row exists: this is a returning user, not first run.
          // Attempt to open it with the same key instead of overwriting.
          try {
            const v = await decryptVault<VaultBlob>(existing, password);
            cipherRef.current = existing;
            passRef.current = password;
            setVault(v);
            setStatus('unlocked');
            setError(null);
            return;
          } catch {
            setError('Wrong password. Your data stays encrypted until you type it right.');
            setStatus('locked');
            return;
          }
        }
      }
      const v = emptyVault(prefs);
      const fp = await fingerprintSecret(password);
      v.prefs.llmKeyFinger = fp.slice(0, 8);
      passRef.current = password;
      applyVault(v);
      setStatus('unlocked');
      setError(null);
    },
    [applyVault, cloudOn, scope, resolveCipher],
  );

  const unlock = useCallback(
    async (password: string): Promise<VaultStatus> => {
      setError(null);
      let cipher: VaultCipher | undefined;
      try {
        cipher = await resolveCipher();
      } catch (e) {
        // The DB was unreachable (network / PostgREST down). Not a wrong-
        // password case — 'unavailable' shows a retry screen instead.
        setError(e instanceof Error ? e.message : 'Could not reach your data store.');
        setStatus('unavailable');
        return 'unavailable';
      }
      if (!cipher) {
        // No vault row yet: the caller (App) sees 'creating' and auto-
        // creates a fresh vault under this password.
        setStatus('creating');
        return 'creating';
      }
      try {
        const v = await decryptVault<VaultBlob>(cipher, password);
        cipherRef.current = cipher;
        passRef.current = password;
        setVault(v);
        setStatus('unlocked');
        return 'unlocked';
      } catch {
        setError('Wrong password. Your data stays encrypted until you type it right.');
        setStatus('locked');
        return 'locked';
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
    // Disarm the auto-unlock: with no in-memory password the gate asks for it.
    auth.setAccountPassword('');
  }, [auth]);

  // ---- single-credential auto flow: account password == vault key ----
  // A fresh sign-in stores the password in auth (pp). First run (no DB row
  // yet, status 'creating') -> auto-create the vault; returning user
  // (status 'locked') -> auto-unlock. Page refresh restores the session
  // WITHOUT the password (pp null) -> the one-field gate asks for it, so a
  // reload never auto-opens the vault. lock() wipes pp, so a manual lock
  // always lands on the gate too.
  //
  // Gated on probeSettledRef (authoritative, same-commit) AND probeSettled
  // state (re-trigger): a fresh sign-in's auto flow may only act on a
  // status that the CURRENT scope's settled probe produced. This closes the
  // logout -> login race where sign-in arrives while a stale 'creating'
  // status would make the auto-create overwrite the user's real vault row.
  const pp = auth.accountPassword;
  useEffect(() => {
    if (!probeSettledRef.current || !pp || !auth.user) return;
    if (status === 'locked') void unlock(pp);
    else if (status === 'creating') void createVault(pp);
  }, [probeSettled, pp, auth.user, status, unlock, createVault]);

  /**
   * Change the account password. It doubles as the vault key, so the vault
   * row must be re-encrypted under the new key or the user would be locked
   * out forever. Order: (1) update the Supabase auth password, (2) drain
   * pending writes, re-encrypt + upsert the vault row, (3) roll step 1 back
   * if step 2 fails — the two can never diverge.
   */
  const changePassword = useCallback(
    async (current: string, next: string) => {
      if (next.length < 6) throw new Error('New password must be at least 6 characters.');
      if (current === next) throw new Error('New password must differ from the current one.');
      // Prove the current password before touching anything: it must decrypt
      // the last known ciphertext (the vault is unlocked when this runs).
      if (cipherRef.current) {
        try {
          await decryptVault<VaultBlob>(cipherRef.current, current);
        } catch {
          throw new Error('Current password is wrong.');
        }
      }
      // (1) New Supabase auth password; auth state now holds the new key.
      await auth.updateAccountPassword(current, next);
      // (2) Re-encrypt the whole blob under the new key and upsert.
      try {
        if (!vault) throw new Error('Vault is not unlocked.');
        await chainRef.current; // drain in-flight writes so the re-encrypt wins
        passRef.current = next;
        const blob: VaultBlob = { ...vault, updatedAt: Date.now() };
        const c2 = await encryptVault(blob, next);
        cipherRef.current = c2;
        const ok = cloudOn ? await saveCloudVault(scope, c2) : true;
        if (!ok) throw new Error('Cloud save failed — could not re-encrypt the vault row.');
        setSyncState('synced');
        setError(null);
      } catch (e) {
        // (3) Roll back: restore the old auth password + old in-memory key.
        await auth.updateAccountPassword(next, current).catch(() => {});
        passRef.current = current;
        setSyncState('error');
        throw e instanceof Error
          ? new Error(`${e.message} (Password was rolled back.)`)
          : new Error(`Vault re-encryption failed. (Password was rolled back.)`);
      }
    },
    [vault, scope, cloudOn, auth],
  );

  const eraseAll = useCallback(async () => {
    // DB-only: the DB row is the only persisted copy — delete it, not a cache.
    if (cloudOn) await deleteCloudVault(scope);
    setVault(null);
    passRef.current = '';
    cipherRef.current = null;
    setSyncState('idle');
    setStatus('creating');
    setError(null);
  }, [scope, cloudOn]);

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

  const updateHolding = useCallback(
    (id: string, patch: Partial<Omit<InvestmentHolding, 'id'>>) => {
      setVault((prev) => {
        if (!prev) return prev;
        const next = {
          ...prev,
          holdings: prev.holdings.map((h) => (h.id === id ? { ...h, ...patch } : h)),
          updatedAt: Date.now(),
        };
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
    async (
      _provider: 'none' | 'openai' | 'anthropic' | 'gemini' | 'adacode',
      _key: string,
      _model?: string,
    ): Promise<boolean> => {
      // The BYOK key is stored encrypted inside the vault (re-decrypted per
      // session). Compute the display fingerprint outside the updater.
      const fp = _key ? (await fingerprintSecret(_key).catch(() => '')) : '';
      const model = _model?.trim() || undefined;
      let updated = false;
      setVault((prev) => {
        if (!prev) return prev;
        updated = true;
        const next = {
          ...prev,
          prefs: {
            ...prev.prefs,
            llmProvider: _key ? _provider : 'none',
            llmKeyFinger: fp.slice(0, 8),
            llmModel: model,
          },
          llmKey: _key,
          updatedAt: Date.now(),
        };
        void persist(next);
        return next;
      });
      return updated;
    },
    [persist],
  );

  /** Re-push the current in-memory vault after a failed cloud save. */
  const retrySync = useCallback(() => {
    if (!vault) return;
    void persist(vault);
  }, [vault, persist]);

  // ---- admin actions (all gated by RLS server-side; see services/admin.ts) ----
  // The store only orchestrates; the actual permission checks happen in
  // Postgres. A non-admin call simply returns false and nothing is written.

  const adminRefresh = useCallback(async () => {
    if (!adminUserKey) return;
    const [admin, policy] = await Promise.all([
      isAdmin(adminUserKey),
      getMyLlmPolicy(adminUserKey),
    ]);
    setIsAdminUser(admin);
    setLlmPolicy(policy);
  }, [adminUserKey]);

  const adminGrant = useCallback(
    async (targetUserId: string): Promise<boolean> => {
      if (!adminUserKey) return false;
      const ok = await grantAdmin(adminUserKey, targetUserId);
      void adminRefresh();
      return ok;
    },
    [adminUserKey, adminRefresh],
  );

  const adminRevoke = useCallback(
    async (targetUserId: string): Promise<boolean> => {
      if (!adminUserKey) return false;
      const ok = await revokeAdmin(adminUserKey, targetUserId);
      void adminRefresh();
      return ok;
    },
    [adminUserKey, adminRefresh],
  );

  const adminSetLlm = useCallback(
    async (
      targetUserId: string,
      provider: LLMProvider,
      apiKey: string,
      model: string,
      keyFinger: string,
    ): Promise<boolean> => {
      if (!adminUserKey) return false;
      const ok = await adminSetLlmPolicy(adminUserKey, targetUserId, provider, apiKey, model, keyFinger);
      // If the admin is editing their own row, refresh local policy too.
      if (targetUserId === adminUserKey) void adminRefresh();
      return ok;
    },
    [adminUserKey, adminRefresh],
  );

  const adminClearLlm = useCallback(
    async (targetUserId: string): Promise<boolean> => {
      if (!adminUserKey) return false;
      const ok = await adminClearLlmPolicy(adminUserKey, targetUserId);
      if (targetUserId === adminUserKey) void adminRefresh();
      return ok;
    },
    [adminUserKey, adminRefresh],
  );

  const adminWipeVault = useCallback(
    async (targetUserId: string): Promise<boolean> => {
      if (!adminUserKey) return false;
      return wipeMemberVault(adminUserKey, targetUserId);
    },
    [adminUserKey],
  );

  const adminMembers = useCallback(async (): Promise<MemberRow[]> => listMembers(), []);
  const adminVaultSync = useCallback(async (): Promise<VaultSyncRow[]> => listVaultSync(), []);
  const adminIds = useCallback(async (): Promise<string[]> => listAdminIds(), []);
  const adminPolicies = useCallback(async (): Promise<PolicySummary[]> => listPolicies(), []);

  // ---- coach (conversational advisor) ----
  // Persisted encrypted with the vault like everything else. Bounded: keep
  // only the last 200 messages so the blob (and every full re-encrypt of it)
  // stays small no matter how long the user chats.

  const pushCoachMessage = useCallback(
    (msg: Omit<CoachMessage, 'id'>) => {
      setVault((prev) => {
        if (!prev) return prev;
        const entry: CoachMessage = {
          ...msg,
          id: `cm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        };
        const next = {
          ...prev,
          coachLog: [...(prev.coachLog ?? []), entry].slice(-200),
          updatedAt: Date.now(),
        };
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  const clearCoachLog = useCallback(() => {
    setVault((prev) => {
      if (!prev) return prev;
      const next = { ...prev, coachLog: [], updatedAt: Date.now() };
      void persist(next);
      return next;
    });
  }, [persist]);

  const llmConfig = useMemo<LLMConfig | null>(() => {
    // Admin-issued LLM policy (RLS row) OVERRIDES the local BYOK choice:
    // that is the "lock the model" feature. An admin can pin a user to a
    // specific provider/key/model, or to 'none' (force on-device rules).
    // When no policy row exists, the user's own vault settings apply.
    if (llmPolicy && llmPolicy.provider !== 'none' && llmPolicy.api_key) {
      return {
        provider: llmPolicy.provider,
        apiKey: llmPolicy.api_key,
        model: llmPolicy.model?.trim() || undefined,
      };
    }
    if (!vault) return null;
    // Explicit 'none' policy (or any policy without a key) falls through to
    // local settings only when no policy row exists at all; an explicit
    // 'none' policy with no key means the admin forced on-device rules.
    if (llmPolicy) return null;
    if (vault.prefs.llmProvider === 'none' || !vault.llmKey) return null;
    const model = vault.prefs.llmModel?.trim();
    return {
      provider: vault.prefs.llmProvider,
      apiKey: vault.llmKey,
      model: model || undefined,
    };
  }, [vault, llmPolicy]);

  const store: VaultStore = {
    status,
    error,
    scope,
    cloudSynced: cloudOn,
    syncState,
    createVault,
    unlock,
    lock,
    changePassword,
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
    updateHolding,
    updateHoldingPrice,
    setPrefs,
    setLlmKey,
    retrySync,
    // Admin & LLM policy (RLS-gated; no-ops when cloud is off or the 0002
    // migration has not been applied yet).
    isAdminUser,
    llmPolicy,
    adminMembers,
    adminVaultSync,
    adminGrant,
    adminRevoke,
    adminSetLlm,
    adminClearLlm,
    adminWipeVault,
    adminIds,
    adminPolicies,
    coachLog: vault?.coachLog ?? [],
    pushCoachMessage,
    clearCoachLog,
    categories: vault?.categories ?? [],
  };

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}
