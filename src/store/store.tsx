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
  Budget,
  Recurring,
  Liability,
  ManualAsset,
  Dividend,
  Disposal,
  EmergencyFund,
  EmergencyFundItem,
  PendingImport,
  NetWorthPoint,
  SavingsGoal,
  AutoInvest,
  Contribution,
  CoachThread,
} from '../domain/types';
import { emptyVault, healVault, withoutUndefined } from '../domain/seed';
import { encryptVault, decryptVault, fingerprintSecret, type VaultCipher } from '../security/vault';
import { getSupabase } from '../services/supabase';
import { LLMConfig } from '../ai/categorize';
import { resolveLlmConfig } from '../ai/resolveLlm';
import { makeEntitlements, DEFAULT_TIER, type Tier } from '../entitlements';
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
  getDefaultLlm,
  setDefaultLlm as adminSetDefaultLlm,
  applyDefaultLlmToUser as adminApplyDefaultLlm,
  type DefaultLlmRow,
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
  /** Optional starting capital (deposit) in base currency. */
  initialDepositBase?: number;
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

  /** Current billing tier ('free' | 'pro'). Defaults to 'free' until
   *  Lemon Squeezy / DB wiring flips it. Source of truth: admin-settable
   *  prefs.tier (set via the admin console / DB migration). */
  tier: Tier;
  /** Entitlements derived from `tier`. Call `has('feature')` to gate UI. */
  entitlements: ReturnType<typeof makeEntitlements>;

  addExpense: (input: NewExpenseInput) => string;
  /** Batch insert (PDF/CSV statement import). One persist per batch. */
  addExpenses: (inputs: NewExpenseInput[]) => string[];
  deleteExpense: (id: string) => void;
  /** Batch delete (multi-select). One persist for the whole set. */
  deleteExpenses: (ids: string[]) => void;
  /** Patch fields on an existing expense (the coach's edit_expense action). */
  editExpense: (
    id: string,
    patch: Partial<
      Pick<Expense, 'originalAmount' | 'originalCurrency' | 'category' | 'merchant' | 'paymentMethod' | 'note'> & { timestamp?: number }
    >,
  ) => void;
  addCategory: (name: string, icon: string) => void;

  addAccount: (input: NewAccountInput) => string;
  deleteAccount: (id: string) => void;
  /** Patch an existing account (platformName, accountType, deposit). */
  updateAccount: (id: string, patch: Partial<Omit<InvestmentAccount, 'id' | 'baseCurrencyValue' | 'lastUpdated'>>) => void;
  addHolding: (input: NewHoldingInput) => string;
  deleteHolding: (id: string) => void;
  /** Patch an existing holding (units, entry, symbol, class, currency, account). */
  updateHolding: (id: string, patch: Partial<Omit<InvestmentHolding, 'id'>>) => void;
  updateHoldingPrice: (id: string, local: number, base: number) => void;

  // ---- extended entities (budgets / recurring / liabilities / assets / dividends / disposals)
  addBudget: (input: Omit<Budget, 'id' | 'createdAt'> & { createdAt?: number }) => string;
  deleteBudget: (id: string) => void;
  addRecurring: (input: Omit<Recurring, 'id'>) => string;
  deleteRecurring: (id: string) => void;
  addLiability: (input: Omit<Liability, 'id'>) => string;
  deleteLiability: (id: string) => void;
  addAsset: (input: Omit<ManualAsset, 'id'>) => string;
  deleteAsset: (id: string) => void;
  addDividend: (input: Omit<Dividend, 'id'>) => string;
  deleteDividend: (id: string) => void;
  addDisposal: (input: Omit<Disposal, 'id'>) => string;
  deleteDisposal: (id: string) => void;
  // ---- savings goals (Pro feature) ----
  addSavingsGoal: (input: Omit<SavingsGoal, 'id'>) => string;
  deleteSavingsGoal: (id: string) => void;
  updateSavingsGoal: (id: string, patch: Partial<Omit<SavingsGoal, 'id' | 'createdAt'>>) => void;
  // ---- auto-invest plans + contribution ledger ----
  addAutoInvest: (input: Omit<AutoInvest, 'id'>) => string;
  updateAutoInvest: (id: string, patch: Partial<Omit<AutoInvest, 'id' | 'createdAt'>>) => void;
  deleteAutoInvest: (id: string) => void;
  /** Log one contribution: appends to the ledger AND grows the account's
   *  invested capital (initialDepositBase += amountBase). One persist. */
  addContribution: (input: Omit<Contribution, 'id'>) => string;
  deleteContribution: (id: string) => void;
  // ---- emergency reserve (separate line from the portfolio) ----
  addEmergencyItem: (input: Omit<EmergencyFundItem, 'id'>) => string;
  deleteEmergencyItem: (id: string) => void;
  /** Patch the module-level scalars (targetMonths / targetOverrideBase /
   *  note). Items are managed via add/deleteEmergencyItem. */
  setEmergency: (patch: Partial<Omit<EmergencyFund, 'items'>>) => void;

  /** Append a daily net-worth snapshot (deduped by day, capped at 365 points). */
  captureNetWorth: (point: Omit<NetWorthPoint, 'at'> & { at?: number }) => void;

  // ---- in-flight PDF statement import checkpoint (survives a refresh) ----
  /** Persist an in-progress PDF import into the encrypted vault blob. Passing
   *  `null` clears it (import finished or the user discarded). Rides the same
   *  upsert + keepalive-flush path as every other mutation, so the user's data
   *  is in Supabase Postgres before a browser tab can die. */
  setPendingImport: (p: import('../domain/types').PendingImport | null) => void;

  setPrefs: (patch: Partial<UserPreferences>) => void;
  /** Set or clear the user's declared salary / income figure. This is the
   *  authoritative income rate for the cash-flow forecast; `null` clears it
   *  so the forecast falls back to the logged-income rate. */
  setSalary: (salary: import('../domain/types').SalaryProfile | null) => void;
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
  /** The platform-default LLM row (0003), when an admin has set one. */
  defaultLlm: import('../services/admin').DefaultLlmRow | undefined;
  /** Admin-only: set/replace the platform-default LLM (single row). */
  adminSetLlmDefault: (
    provider: LLMProvider,
    apiKey: string,
    model: string,
    keyFinger: string,
  ) => Promise<boolean>;
  /** Admin-only: apply the platform default to one member's personal policy row. */
  adminApplyDefault: (targetUserId: string) => Promise<boolean>;

  // Coach (conversational advisor) — multi-session threads, persisted
  // encrypted with the vault. `coachThreads` is the new shape; the old
  // single `coachLog` is kept one release as a deprecated alias (the
  // active thread's messages) so not-yet-migrated call sites keep working.
  coachThreads: CoachThread[];
  activeCoachThread: string; // guaranteed non-empty (provider ensures a valid thread)
  /** Derived: the active thread's messages (view convenience). */
  coachMessages: CoachMessage[];
  addCoachThread: () => string; // returns new id; sets it active; title "New chat"
  renameCoachThread: (id: string, title: string) => void;
  deleteCoachThread: (id: string) => void; // UI arms it; provider just deletes + re-points active
  setActiveCoachThread: (id: string) => void;
  /** Append to one specific thread (bounded: last 200). Bumps updatedAt. */
  pushCoachMessageTo: (threadId: string, msg: Omit<CoachMessage, 'id'>) => void;
  clearActiveThread: () => void; // clears the active thread's messages, keeps the thread

  // Deprecated one release — thin wrappers over the active thread. Remove
  // after CoachView is confirmed migrated.
  /** @deprecated use coachThreads / coachMessages */
  coachLog: CoachMessage[];
  /** @deprecated use pushCoachMessageTo(activeCoachThread, msg) */
  pushCoachMessage: (msg: Omit<CoachMessage, 'id'>) => void;
  /** @deprecated use clearActiveThread() */
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
  const [defaultLlm, setDefaultLlm] = useState<DefaultLlmRow | undefined>(undefined);
  const passRef = useRef<string>(''); // holds passphrase in-memory only
  const cipherRef = useRef<VaultCipher | null>(null); // last encrypted blob
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  // Latest-auth refs: the provider mounts BEFORE sign-in (user=null ->
  // cloudOn=false, scope='local'). The extended-entity CRUD mutators are
  // stable callbacks ([] deps) that froze the FIRST-render `persist`
  // closure, where cloudOn was still false. Reading scope/cloudOn straight
  // from that stale closure made every later mutation a silent no-op
  // (in-memory only) — the value vanished on the next logout because it was
  // never written to the DB. The refs below let a stable `persist` always
  // see the current auth state.
  const scopeRef = useRef(scope);
  const cloudOnRef = useRef(cloudOn);
  scopeRef.current = scope;
  cloudOnRef.current = cloudOn;

  // Probe admin status + pull this user's LLM policy when the cloud user is
  // known. Both are no-ops (feature off) when the 0002 migration has not been
  // applied yet — the app keeps working on local BYOK settings.
  const adminUserKey = cloudOn ? scope : '';
  useEffect(() => {
    let alive = true;
    if (!adminUserKey) {
      setIsAdminUser(false);
      setLlmPolicy(undefined);
      setDefaultLlm(undefined);
      return;
    }
    (async () => {
      const [admin, policy, def] = await Promise.all([
        isAdmin(adminUserKey),
        getMyLlmPolicy(adminUserKey),
        getDefaultLlm(adminUserKey),
      ]);
      if (!alive) return;
      setIsAdminUser(admin);
      setLlmPolicy(policy);
      setDefaultLlm(def);
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
      // Read the CURRENT auth state from refs: this callback is captured by
      // the stable ([]-deps) extended-entity mutators, which froze the
      // first-render closure (cloudOn=false). Refs make late writes persist
      // for real even when the closure is stale.
      const scope = scopeRef.current;
      const cloudOn = cloudOnRef.current;
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
    // Stable on purpose: the body reads scope/cloudOn from refs, so a single
    // first-render instance is correct for every later auth state. This is
    // what the []-deps extended-entity mutators (addEmergencyItem, setEnt,
    // ...) resolve against — if persist were re-created on each sign-in,
    // their frozen first-render copy would keep writing (or refusing) based
    // on the stale pre-sign-in closure.
    [],
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

  /**
   * Decrypt + heal. A decrypted blob may carry historically corrupt rows
   * (white-screen bug: addHolding spread `...input` after its price
   * defaults, updateHolding merged explicit `undefined` keys, so the cloud
   * vault can hold holdings whose prices are undefined). healVault repairs
   * them in memory; when a repair happened we re-encrypt + upsert the CLEANED
   * blob so the next load already comes back healthy (best-effort — if the
   * re-save fails, keep the healed in-memory copy; it is safe to render).
   * Also refresh cipherRef so keepalive + changePassword carry the cleaned
   * ciphertext, not the corrupt one.
   */
  const decryptAndHeal = useCallback(
    async (cipher: VaultCipher, password: string): Promise<VaultBlob> => {
      const raw = await decryptVault<VaultBlob>(cipher, password);
      const { blob, changed } = healVault(raw);
      if (changed && cloudOn) {
        const cleaned = { ...blob, updatedAt: Date.now() };
        try {
          const c2 = await encryptVault(cleaned, password);
          cipherRef.current = c2;
          const ok = await saveCloudVault(scope, c2);
          if (ok) {
            setSyncState('synced');
            setError(null);
          } else {
            setSyncState('error');
            setError('Healed some stored data, but syncing the repair failed — retry from the banner.');
          }
        } catch {
          // Keep the healed in-memory copy; the cipher stays corrupt until
          // the next normal write (which re-encrypts the healed blob).
          cipherRef.current = cipher;
        }
      } else {
        cipherRef.current = cipher;
      }
      return blob;
    },
    [cloudOn, scope],
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
            const v = await decryptAndHeal(existing, password);
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
      // Persist the device handle so refresh auto-reopens (first-run path).
      if (cloudOn && scope !== 'local') {
        try { localStorage.setItem(`ofv:pass:${scope}`, password); } catch { /* ignore */ }
      }
    },
    [applyVault, cloudOn, scope, resolveCipher, decryptAndHeal],
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
        const v = await decryptAndHeal(cipher, password);
        passRef.current = password;
        setVault(v);
        setStatus('unlocked');
        // Persist the per-user device handle so a subsequent page refresh
        // auto-reopens without re-asking. Revoked on manual lock / sign-out.
        if (cloudOn && scope !== 'local') {
          try { localStorage.setItem(`ofv:pass:${scope}`, password); } catch { /* ignore */ }
        }
        return 'unlocked';
      } catch {
        setError('Wrong password. Your data stays encrypted until you type it right.');
        setStatus('locked');
        return 'locked';
      }
    },
    [resolveCipher, decryptAndHeal, cloudOn, scope],
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
    // Revoke the device handle too: a manual "Lock now" is an explicit
    // request to re-ask, so refresh must not silently reopen.
    if (cloudOn && scope !== 'local') {
      try { localStorage.removeItem(`ofv:pass:${scope}`); } catch { /* ignore */ }
    }
  }, [auth, cloudOn, scope]);

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
  // Refresh auto-reopen: on a returning session (pp null) we look for a
  // per-user device handle written at last successful unlock. If present,
  // use it to unlock without showing the gate. The handle is scoped to the
  // Supabase user id, so it NEVER leaks across accounts.
  const deviceHandle = cloudOn ? localStorage.getItem(`ofv:pass:${scope}`) : null;
  useEffect(() => {
    if (!probeSettledRef.current || !auth.user) return;
    // In-memory password from sign-in (pp) wins — it's always the current
    // key. A stored handle is only a fallback for the refresh path.
    const key = pp || (status === 'locked' ? deviceHandle : null);
    if (!key) return;
    if (status === 'locked') {
      void unlock(key);
      // Persist the in-memory key for next refresh.
      if (pp && cloudOn) {
        try { localStorage.setItem(`ofv:pass:${scope}`, pp); } catch { /* ignore */ }
      }
    } else if (status === 'creating') {
      void createVault(key);
      if (pp && cloudOn) {
        try { localStorage.setItem(`ofv:pass:${scope}`, pp); } catch { /* ignore */ }
      }
    }
  }, [probeSettled, pp, deviceHandle, auth.user, status, unlock, createVault, scope, cloudOn]);

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
      // The device handle (if any) must track the new key, else a refresh
      // would try the old one and fail. Update it atomically with the change.
      if (cloudOn && scope !== 'local') {
        try {
          if (localStorage.getItem(`ofv:pass:${scope}`) != null) {
            localStorage.setItem(`ofv:pass:${scope}`, next);
          }
        } catch { /* ignore */ }
      }
      // (2) Re-encrypt the whole blob under the new key and upsert.
      try {
        if (!vault) throw new Error('Vault is not unlocked.');
        await chainRef.current; // drain in-flight writes so the re-encrypt wins
        passRef.current = next;
        const blob: VaultBlob = { ...vault, updatedAt: Date.now() };
        const c2 = await encryptVault(blob, next);
        cipherRef.current = c2;
        // After updateUser the client's access token may still be the
        // pre-change JWT. A stale token makes the upsert 401, leaving the
        // DB row encrypted under the OLD key — the next unlock then fails
        // with "wrong password". Refresh the session so the write uses a
        // valid token, then upsert with one retry to absorb a transient
        // 401 from a just-rotated token.
        if (cloudOn) {
          const sb = getSupabase();
          if (sb) await sb.auth.refreshSession().catch(() => {});
          let ok = await saveCloudVault(scope, c2);
          if (!ok) ok = await saveCloudVault(scope, c2); // retry once
          if (!ok) throw new Error('Cloud save failed — could not re-encrypt the vault row.');
        }
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
          ...withoutUndefined(input),
          baseCurrency: prev.prefs.baseCurrency,
          baseAmount: input.originalAmount * input.fxRate,
          timestamp: input.timestamp ?? Date.now(),
        };
        const next = { ...prev, expenses: [exp, ...prev.expenses], updatedAt: Date.now() };
        void persist(next);
        return next;
      });
      return id;
    },
    [persist],
  );

  const addExpenses = useCallback(
    (inputs: NewExpenseInput[]): string[] => {
      if (inputs.length === 0) return [];
      const stamp = Date.now().toString(36);
      const ids = inputs.map((_, i) => `ex-${stamp}-${i.toString(36)}`);
      setVault((prev) => {
        if (!prev) return prev;
        const added: Expense[] = inputs.map((input, i) => ({
          id: ids[i],
          ...withoutUndefined(input),
          baseCurrency: prev.prefs.baseCurrency,
          baseAmount: input.originalAmount * input.fxRate,
          timestamp: input.timestamp ?? Date.now(),
        }));
        const next = {
          ...prev,
          expenses: [...added, ...prev.expenses],
          updatedAt: Date.now(),
        };
        void persist(next); // one write for the whole batch
        return next;
      });
      return ids;
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

  /** Batch delete: one vault write + one persist for the whole set, instead
   *  of N separate setVault/persist cycles. */
  const deleteExpenses = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      setVault((prev) => {
        if (!prev) return prev;
        const idSet = new Set(ids);
        const next = {
          ...prev,
          expenses: prev.expenses.filter((e) => !idSet.has(e.id)),
          updatedAt: Date.now(),
        };
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  const editExpense = useCallback(
    (
      id: string,
      patch: Partial<
        Pick<Expense, 'originalAmount' | 'originalCurrency' | 'category' | 'merchant' | 'paymentMethod' | 'note'> & { timestamp?: number }
      >,
    ) => {
      setVault((prev) => {
        if (!prev) return prev;
        const next = {
          ...prev,
          expenses: prev.expenses.map((e) => {
            if (e.id !== id) return e;
            const merged: Expense = { ...e, ...withoutUndefined(patch) };
            // If the amount or currency changed, recompute the base value from
            // the stored fxRate so base currency stays consistent. Note the
            // coach's edit_expense carries no live FX rate; when currency
            // changed we keep the original fxRate (best-effort, offline-safe).
            if (patch.originalAmount !== undefined) {
              merged.originalAmount = patch.originalAmount;
              merged.baseAmount = patch.originalAmount * e.fxRate;
            }
            if (patch.originalCurrency !== undefined) {
              merged.originalCurrency = patch.originalCurrency;
            }
            return merged;
          }),
          updatedAt: Date.now(),
        };
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
        if (acc.initialDepositBase != null && (!Number.isFinite(acc.initialDepositBase) || acc.initialDepositBase <= 0)) {
          delete acc.initialDepositBase;
        }
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
        const next: VaultBlob = {
          ...prev,
          accounts: prev.accounts.filter((a) => a.id !== id),
          holdings: prev.holdings.filter((h) => h.accountId !== id),
          emergency: prev.emergency
            ? { ...prev.emergency, items: prev.emergency.items.filter((it) => it.accountId !== id) }
            : prev.emergency,
          updatedAt: Date.now(),
        };
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  const updateAccount = useCallback(
    (id: string, patch: Partial<Omit<InvestmentAccount, 'id' | 'baseCurrencyValue' | 'lastUpdated'>>) => {
      setVault((prev) => {
        if (!prev) return prev;
        const clean = withoutUndefined(patch);
        if (clean.initialDepositBase != null && (!Number.isFinite(clean.initialDepositBase) || clean.initialDepositBase <= 0)) {
          delete clean.initialDepositBase;
        }
        const next = {
          ...prev,
          accounts: prev.accounts.map((a) => (a.id === id ? { ...a, ...clean, lastUpdated: Date.now() } : a)),
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
          ...withoutUndefined(input),
          // Price defaults computed LAST so an explicit `undefined` in input
          // can never clobber them (the original white-screen crash: an
          // undefined currentPriceBase persisted into the cloud vault, then
          // `.toFixed(3)` on undefined killed the whole render).
          currentPriceLocal: input.currentPriceLocal ?? input.averageEntryPrice,
          currentPriceBase: input.currentPriceBase ?? input.averageEntryPrice,
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
        // Strip undefined keys: a spread merge with explicit `undefined`
        // clobbers stored values (e.g. the "Save changes" form passing
        // currentPriceLocal: undefined was writing undefined prices into
        // the cloud vault — one half of the white-screen bug).
        const clean = withoutUndefined(patch);
        const next = {
          ...prev,
          holdings: prev.holdings.map((h) => (h.id === id ? { ...h, ...clean } : h)),
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

  // ---- Declared salary / income figure (authoritative forecast income rate)
  // A single optional object (not an array) — the pattern of `emergency` and
  // `pendingImport`: patch-or-null mutator, persisted through the same
  // re-encrypt-upsert path. `null` clears it (user removed the salary).
  const setSalary = useCallback(
    (salary: import('../domain/types').SalaryProfile | null) => {
      setVault((prev) => {
        if (!prev) return prev;
        // Only bump updatedAt when the value actually changes, so a repeated
        // "save the same number" tap doesn't spawn a redundant upsert.
        const same =
          salary === null && prev.salary == null ||
          (salary != null &&
            prev.salary != null &&
            prev.salary.amountPerMonth === salary.amountPerMonth &&
            prev.salary.period === salary.period &&
            prev.salary.label === salary.label);
        if (same) return prev;
        const next = { ...prev, salary, updatedAt: Date.now() };
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  // ---- extended-entity CRUD (budgets / recurring / liabilities / assets / dividends / disposals).
  // Generic factories keep the 12 near-identical mutators DRY. Arrays are
  // optional on old encrypted blobs, so every read normalizes with ?? [].

  type EntKey = 'budgets' | 'recurring' | 'liabilities' | 'assets' | 'dividends' | 'disposals' | 'savingsGoals' | 'autoInvests' | 'contributions';
  type Prefix = 'b' | 'r' | 'l' | 'a' | 'd' | 's' | 'e' | 'g' | 'pi' | 'ci';
  const entId = (p: Prefix) =>
    `${p}-${crypto.randomUUID()}`; // 128-bit id; prefix keeps it sortable & entity-typed
  const setEnt = (key: EntKey, fn: (arr: unknown[]) => unknown[]) => {
    setVault((prev) => {
      if (!prev) return prev;
      const arr = ((prev as unknown as Record<string, unknown[]>)[key] ?? []) as unknown[];
      const next = { ...prev, [key]: fn(arr), updatedAt: Date.now() } as VaultBlob;
      void persist(next);
      return next;
    });
  };
  /** Patch the emergency-reserve module (a nested object, not an array key).
   *  Reads the current module from `prev` so old blobs heal in place. */
  const setEmergencyModule = (fn: (em: EmergencyFund) => EmergencyFund) => {
    setVault((prev) => {
      if (!prev) return prev;
      const em = prev.emergency ?? { items: [], targetMonths: 3 };
      const next = { ...prev, emergency: fn(em), updatedAt: Date.now() } as VaultBlob;
      void persist(next);
      return next;
    });
  };

  const addBudget = useCallback(
    (input: Omit<Budget, 'id' | 'createdAt'> & { createdAt?: number }): string => {
      const id = entId('b');
      setEnt('budgets', (arr) => [...(arr as Budget[]), { ...withoutUndefined(input), id, createdAt: input.createdAt ?? Date.now() }]);
      return id;
    },
    [],
  );
  const deleteBudget = useCallback((id: string) => setEnt('budgets', (a) => a.filter((x) => (x as Budget).id !== id)), []);

  const addRecurring = useCallback(
    (input: Omit<Recurring, 'id'>): string => {
      const id = entId('r');
      setEnt('recurring', (arr) => [...(arr as Recurring[]), { ...withoutUndefined(input), id }]);
      return id;
    },
    [],
  );
  const deleteRecurring = useCallback((id: string) => setEnt('recurring', (a) => a.filter((x) => (x as Recurring).id !== id)), []);

  const addLiability = useCallback(
    (input: Omit<Liability, 'id'>): string => {
      const id = entId('l');
      setEnt('liabilities', (arr) => [...(arr as Liability[]), { ...withoutUndefined(input), id }]);
      return id;
    },
    [],
  );
  const deleteLiability = useCallback((id: string) => setEnt('liabilities', (a) => a.filter((x) => (x as Liability).id !== id)), []);

  const addAsset = useCallback(
    (input: Omit<ManualAsset, 'id'>): string => {
      const id = entId('a');
      setEnt('assets', (arr) => [...(arr as ManualAsset[]), { ...withoutUndefined(input), id }]);
      return id;
    },
    [],
  );
  const deleteAsset = useCallback((id: string) => setEnt('assets', (a) => a.filter((x) => (x as ManualAsset).id !== id)), []);

  const addDividend = useCallback(
    (input: Omit<Dividend, 'id'>): string => {
      const id = entId('d');
      setEnt('dividends', (arr) => [...(arr as Dividend[]), { ...withoutUndefined(input), id }]);
      return id;
    },
    [],
  );
  const deleteDividend = useCallback((id: string) => setEnt('dividends', (a) => a.filter((x) => (x as Dividend).id !== id)), []);

  const addDisposal = useCallback(
    (input: Omit<Disposal, 'id'>): string => {
      const id = entId('s');
      setEnt('disposals', (arr) => [...(arr as Disposal[]), { ...withoutUndefined(input), id }]);
      return id;
    },
    [],
  );
  const deleteDisposal = useCallback((id: string) => setEnt('disposals', (a) => a.filter((x) => (x as Disposal).id !== id)), []);

  const addSavingsGoal = useCallback(
    (input: Omit<SavingsGoal, 'id'>): string => {
      const id = entId('g');
      setEnt('savingsGoals', (arr) => [...(arr as SavingsGoal[]), { ...withoutUndefined(input), id }]);
      return id;
    },
    [],
  );
  const deleteSavingsGoal = useCallback((id: string) => setEnt('savingsGoals', (a) => a.filter((x) => (x as SavingsGoal).id !== id)), []);
  const updateSavingsGoal = useCallback(
    (id: string, patch: Partial<Omit<SavingsGoal, 'id' | 'createdAt'>>) =>
      setEnt('savingsGoals', (a) => (a as SavingsGoal[]).map((g) => (g.id === id ? { ...g, ...withoutUndefined(patch) } : g))),
    [],
  );

  // ---- Auto-invest plans + contribution ledger ----
  const addAutoInvest = useCallback(
    (input: Omit<AutoInvest, 'id'>): string => {
      const id = entId('pi');
      setEnt('autoInvests', (arr) => [...(arr as AutoInvest[]), { ...withoutUndefined(input), id }]);
      return id;
    },
    [],
  );
  const updateAutoInvest = useCallback(
    (id: string, patch: Partial<Omit<AutoInvest, 'id' | 'createdAt'>>) =>
      setEnt('autoInvests', (a) => (a as AutoInvest[]).map((p) => (p.id === id ? { ...p, ...withoutUndefined(patch) } : p))),
    [],
  );
  const deleteAutoInvest = useCallback((id: string) => setEnt('autoInvests', (a) => a.filter((x) => (x as AutoInvest).id !== id)), []);

  /** One contribution = one ledger row + a bump to the account's invested
   *  capital (initialDepositBase) so P&L always measures against the total
   *  money the user has actually put in. A single setVault + persist. */
  const addContribution = useCallback(
    (input: Omit<Contribution, 'id'>): string => {
      const id = entId('ci');
      setVault((prev) => {
        if (!prev) return prev;
        const c: Contribution = { ...withoutUndefined(input), id };
        const contribs = [...(prev.contributions ?? []), c];
        const cap =
          typeof c.amountBase === 'number' && Number.isFinite(c.amountBase) && c.amountBase > 0
            ? c.amountBase
            : 0;
        const accounts = prev.accounts.map((a) =>
          a.id === c.accountId
            ? {
                ...a,
                // Grow the invested capital by this contribution so the
                // account's P&L (value − capital) stays honest.
                initialDepositBase: (a.initialDepositBase ?? 0) + cap,
                lastUpdated: Date.now(),
              }
            : a,
        );
        const next = { ...prev, contributions: contribs, accounts, updatedAt: Date.now() };
        void persist(next);
        return next;
      });
      return id;
    },
    [persist],
  );
  const deleteContribution = useCallback((id: string) => setEnt('contributions', (a) => a.filter((x) => (x as Contribution).id !== id)), []);

  // ---- Emergency reserve (nested module, not an array key) ----
  const addEmergencyItem = useCallback(
    (input: Omit<EmergencyFundItem, 'id'>): string => {
      const id = entId('e');
      setEmergencyModule((em) => ({
        ...em,
        items: [...em.items, { ...withoutUndefined(input), id }],
      }));
      return id;
    },
    [],
  );
  const deleteEmergencyItem = useCallback((id: string) => {
    setEmergencyModule((em) => ({ ...em, items: em.items.filter((it) => it.id !== id) }));
  }, []);
  const setEmergency = useCallback((patch: Partial<Omit<EmergencyFund, 'items'>>) => {
    setEmergencyModule((em) => ({ ...em, ...withoutUndefined(patch) }));
  }, []);

  // ---- In-flight PDF import checkpoint. A top-level object-or-null field
  // (like `emergency`), not an array key. `null` clears it (finished /
  // discarded). Every write re-encrypts the whole blob and upserts to Supabase
  // via the same `persist` path, so a refresh mid-import loses nothing.
  const setPendingImport = useCallback((p: PendingImport | null) => {
    setVault((prev) => {
      if (!prev) return prev;
      // Normalizing `null` vs an empty value: only bump updatedAt when the
      // value actually changes, so the "finished import" clear that follows
      // right after the last addExpenses() doesn't spawn a redundant upsert.
      if (prev.pendingImport === p && p !== null) return prev;
      const next = { ...prev, pendingImport: p, updatedAt: Date.now() };
      void persist(next);
      return next;
    });
  }, [persist]);

  /** Append a net-worth snapshot, one point per day (most-recent-wins for
   *  today), capped at the last 365 points so the encrypted blob stays small.
   *  No-op when a point for today already exists. */
  const captureNetWorth = useCallback((point: Omit<NetWorthPoint, 'at'> & { at?: number }) => {
    const at = point.at ?? Date.now();
    const dayStart = new Date(at);
    dayStart.setHours(0, 0, 0, 0);
    const dayKey = dayStart.getTime();
    setVault((prev) => {
      if (!prev) return prev;
      const hist = prev.netWorthHistory ?? [];
      // Already captured today (same calendar day): refresh, don't duplicate.
      const todayIdx = hist.findIndex((p) => {
        const d = new Date(p.at);
        d.setHours(0, 0, 0, 0);
        return d.getTime() === dayKey;
      });
      let next: NetWorthPoint[];
      if (todayIdx >= 0) {
        next = hist.map((p, i) => (i === todayIdx ? { ...p, ...point, at: p.at } : p));
      } else {
        next = [...hist, { ...point, at }].sort((a, b) => a.at - b.at);
      }
      // Keep only the most recent 365 points.
      if (next.length > 365) next = next.slice(next.length - 365);
      const out = { ...prev, netWorthHistory: next, updatedAt: Date.now() };
      void persist(out);
      return out;
    });
  }, [persist]);

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
    const [admin, policy, def] = await Promise.all([
      isAdmin(adminUserKey),
      getMyLlmPolicy(adminUserKey),
      getDefaultLlm(adminUserKey),
    ]);
    setIsAdminUser(admin);
    setLlmPolicy(policy);
    setDefaultLlm(def);
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

  const adminSetLlmDefault = useCallback(
    async (
      provider: LLMProvider,
      apiKey: string,
      model: string,
      keyFinger: string,
    ): Promise<boolean> => {
      if (!adminUserKey) return false;
      const ok = await adminSetDefaultLlm(adminUserKey, provider, apiKey, model, keyFinger);
      if (ok) void adminRefresh();
      return ok;
    },
    [adminUserKey, adminRefresh],
  );

  const adminApplyDefault = useCallback(
    async (targetUserId: string): Promise<boolean> => {
      if (!adminUserKey) return false;
      const def = await getDefaultLlm(adminUserKey);
      if (!def || def.provider === 'none' || !def.api_key) return false;
      const ok = await adminApplyDefaultLlm(adminUserKey, targetUserId, def);
      if (ok) void adminRefresh();
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

  // ---- coach (conversational advisor) — multi-session threads ----
  // Persisted encrypted with the vault like everything else. Each thread is
  // bounded to the last 200 messages so the blob stays small no matter how
  // long the user chats. The active thread is always valid: when a thread is
  // deleted or is missing, we re-point to the most-recently-updated thread or
  // create a fresh "New chat".
  const newThreadId = () =>
    `ct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const newMsgId = () =>
    `cm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  /** Idempotent migration: ONLY when the vault has a legacy coachLog but no
   *  threads, fold the log into one auto-titled thread and set it active.
   *  When there is nothing to migrate (no legacy log, no threads) this is a
   *  pure no-op that returns the input blob UNCHANGED (same reference) so the
   *  caller's `=== prev` check skips the persist — a fresh vault with no coach
   *  history must never upsert an empty "New chat" thread (wipe-guard test).
   *  The first real thread is created lazily on user interaction. */
  const migrateThreads = useCallback(
    (prev: VaultBlob): VaultBlob => {
      const threads = prev.coachThreads ?? [];
      const legacy = prev.coachLog ?? [];
      if (threads.length === 0 && legacy.length > 0) {
        // Legacy coachLog present, no threads yet: fold into one thread.
        const first = legacy[0];
        const title =
          legacy.find((m) => m.role === 'user')?.text
            ?.slice(0, 40) ?? 'Earlier conversation';
        const ts = legacy[legacy.length - 1].at;
        const migrated: CoachThread = {
          id: newThreadId(),
          title: title.length > 0 ? title : 'Earlier conversation',
          createdAt: first.at,
          updatedAt: ts,
          messages: legacy,
        };
        return {
          ...prev,
          coachThreads: [migrated],
          activeCoachThread: migrated.id,
        };
      }
      // Nothing to migrate (no legacy log, or threads already exist) — and
      // ensure activeCoachThread, if set, still points at a real thread.
      const activeId = prev.activeCoachThread;
      if (
        threads.length > 0 &&
        activeId &&
        threads.some((t) => t.id === activeId)
      ) {
        return prev; // valid: leave untouched (no persist)
      }
      if (threads.length > 0) {
        // activeCoachThread missing/invalid but threads exist: re-point to the
        // most recently updated thread WITHOUT persisting a brand-new empty
        // one. This is a cheap in-memory fix; the next user write persists it.
        const sorted = [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
        return { ...prev, activeCoachThread: sorted[0].id };
      }
      return prev; // no legacy log, no threads: pure no-op
    },
    [],
  );

  // Run migration once on hydration (vault just decrypted) and whenever a
  // new vault is set. Cheap + idempotent.
  //
  // IMPORTANT: in-memory only — do NOT persist() here. The vault-race
  // "wipe guard" invariant forbids an empty-vault upsert on hydration:
  // a legacy vault (coachLog present, no coachThreads) or a brand-new
  // vault must never be upserted just because we materialized threads.
  // The migrated / lazily-created threads ride the NEXT real user write
  // (addCoachThread / pushCoachMessageTo / ...), which persists the whole
  // blob through the normal path. If the user never touches the coach,
  // nothing is upserted and the legacy coachLog stays intact in the blob.
  useEffect(() => {
    setVault((prev) => {
      if (!prev) return prev;
      return migrateThreads(prev);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault]);

  const coachThreads = useMemo(
    () => (vault?.coachThreads ?? []),
    [vault?.coachThreads],
  );
  const activeCoachThread = useMemo(() => {
    const threads = vault?.coachThreads ?? [];
    const a = vault?.activeCoachThread;
    if (a && threads.some((t) => t.id === a)) return a;
    return threads[0]?.id ?? '';
  }, [vault?.coachThreads, vault?.activeCoachThread]);

  const addCoachThread = useCallback((): string => {
    const id = newThreadId();
    setVault((prev) => {
      if (!prev) return prev;
      const t: CoachThread = { id, title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
      const next = { ...prev, coachThreads: [...(prev.coachThreads ?? []), t], activeCoachThread: id, updatedAt: Date.now() };
      void persist(next);
      return next;
    });
    return id;
  }, [persist]);

  const renameCoachThread = useCallback(
    (id: string, title: string) => {
      setVault((prev) => {
        if (!prev) return prev;
        const next = {
          ...prev,
          coachThreads: (prev.coachThreads ?? []).map((t) =>
            t.id === id ? { ...t, title: title.slice(0, 80), updatedAt: Date.now() } : t,
          ),
          updatedAt: Date.now(),
        };
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  const deleteCoachThread = useCallback(
    (id: string) => {
      setVault((prev) => {
        if (!prev) return prev;
        const remaining = (prev.coachThreads ?? []).filter((t) => t.id !== id);
        const wasActive = prev.activeCoachThread === id;
        let active = prev.activeCoachThread;
        let threads = remaining;
        if (wasActive) {
          if (remaining.length > 0) {
            const sorted = [...remaining].sort((a, b) => b.updatedAt - a.updatedAt);
            active = sorted[0].id;
          } else {
            const fresh: CoachThread = { id: newThreadId(), title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
            threads = [fresh];
            active = fresh.id;
          }
        }
        const next = { ...prev, coachThreads: threads, activeCoachThread: active, updatedAt: Date.now() };
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  const setActiveCoachThread = useCallback(
    (id: string) => {
      setVault((prev) => {
        if (!prev) return prev;
        if (!(prev.coachThreads ?? []).some((t) => t.id === id)) return prev;
        const next = { ...prev, activeCoachThread: id, updatedAt: Date.now() };
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  const pushCoachMessageTo = useCallback(
    (threadId: string, msg: Omit<CoachMessage, 'id'>) => {
      setVault((prev) => {
        if (!prev) return prev;
        const entry: CoachMessage = { ...msg, id: newMsgId() };
        const now = Date.now();
        const threads = (prev.coachThreads ?? []).map((t) =>
          t.id === threadId
            ? { ...t, messages: [...t.messages, entry].slice(-200), updatedAt: now }
            : t,
        );
        // Auto-title: if the thread is still "New chat" and the first pushed
        // message is a user message, name it from that text (40-char cap).
        const target = threads.find((t) => t.id === threadId);
        if (target && (target.title === 'New chat' || target.title === '') && msg.role === 'user') {
          const idx = threads.findIndex((t) => t.id === threadId);
          if (idx >= 0)
            threads[idx] = { ...target, title: msg.text.slice(0, 40) || 'New chat' };
        }
        const next = { ...prev, coachThreads: threads, updatedAt: now };
        void persist(next);
        return next;
      });
    },
    [persist],
  );

  const clearActiveThread = useCallback(() => {
    setVault((prev) => {
      if (!prev) return prev;
      const activeId = prev.activeCoachThread;
      const threads = (prev.coachThreads ?? []).map((t) =>
        t.id === activeId ? { ...t, messages: [], updatedAt: Date.now() } : t,
      );
      const next = { ...prev, coachThreads: threads, updatedAt: Date.now() };
      void persist(next);
      return next;
    });
  }, [persist]);

  // ---- deprecated one-release wrappers over the active thread ----
  const pushCoachMessage = useCallback(
    (msg: Omit<CoachMessage, 'id'>) => {
      const activeId = vault?.activeCoachThread;
      if (!activeId) return;
      pushCoachMessageTo(activeId, msg);
    },
    [vault?.activeCoachThread, pushCoachMessageTo],
  );

  const clearCoachLog = useCallback(() => {
    clearActiveThread();
  }, [clearActiveThread]);

  const coachMessagesForActive = (threads: CoachThread[], activeId: string): CoachMessage[] =>
    threads.find((t) => t.id === activeId)?.messages ?? [];

  const coachMessages = useMemo(
    () => coachMessagesForActive(coachThreads, activeCoachThread),
    [coachThreads, activeCoachThread],
  );

  // Deprecated one-release alias: the active thread's messages (so old readers
  // of `coachLog` still see the active conversation, not a lost global).
  const coachLog = coachMessages;

  const llmConfig = useMemo<LLMConfig | null>(() => {
    // Four-tier resolution: admin lock > user BYOK > platform default >
    // free on-device rules. See src/ai/resolveLlm.ts. No per-call fetch;
    // all three sources are already state (loaded on mount / admin change).
    return resolveLlmConfig({ vault, llmPolicy, defaultLlm });
  }, [vault, llmPolicy, defaultLlm]);

  // Billing tier: sourced from prefs.tier when set (admin / DB migration),
  // otherwise defaults to 'free'. Entitlements are derived from it — the
  // switch Lemon Squeezy / Supabase will flip on upgrade.
  const tier: Tier = (vault?.prefs as { tier?: Tier } | undefined)?.tier ?? DEFAULT_TIER;
  const entitlements = useMemo(() => makeEntitlements(tier), [tier]);

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
    tier,
    entitlements,
    addExpense,
    addExpenses,
    deleteExpense,
    deleteExpenses,
    editExpense,
    addCategory,
    addAccount,
    deleteAccount,
    updateAccount,
    addHolding,
    deleteHolding,
    updateHolding,
    updateHoldingPrice,
    addBudget,
    deleteBudget,
    addRecurring,
    deleteRecurring,
    addLiability,
    deleteLiability,
    addAsset,
    deleteAsset,
    addDividend,
    deleteDividend,
    addDisposal,
    deleteDisposal,
    addSavingsGoal,
    deleteSavingsGoal,
    updateSavingsGoal,
    addAutoInvest,
    updateAutoInvest,
    deleteAutoInvest,
    addContribution,
    deleteContribution,
    addEmergencyItem,
    deleteEmergencyItem,
    setEmergency,
    captureNetWorth,
    setPendingImport,
    setPrefs,
    setSalary,
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
    defaultLlm,
    adminSetLlmDefault,
    adminApplyDefault,
    // Multi-session coach threads (new shape).
    coachThreads,
    activeCoachThread,
    coachMessages,
    addCoachThread,
    renameCoachThread,
    deleteCoachThread,
    setActiveCoachThread,
    pushCoachMessageTo,
    clearActiveThread,
    // Deprecated one-release aliases over the active thread.
    coachLog,
    pushCoachMessage,
    clearCoachLog,
    categories: vault?.categories ?? [],
  };

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}
