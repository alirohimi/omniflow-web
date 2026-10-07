// ============================================================================
// OmniFlow — AuthProvider (Supabase email auth, multi-user accounts).
//
// Wraps @supabase/supabase-js auth. Exposes the current user + a small set of
// actions. Data lives ONLY in the Supabase DB (per-user encrypted vault row),
// so signing in is required for any persistence — the gate that presents the
// sign-in / sign-up choice is part of the app entry point (App.tsx), not of
// this provider.
//
// Single-credential design: the account password doubles as the vault key.
// It is held in memory (never persisted) and handed to the vault store for
// PBKDF2 -> AES-GCM after sign-in / email-code confirmations. The auth layer
// never touches the encrypted vault itself — only the password that keys it.
// ============================================================================

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { User } from '@supabase/supabase-js';
import { getSupabase, isCloudEnabled } from '../services/supabase';

export interface AuthStore {
  /** Cloud (Supabase) is configured and reachable as a client. */
  cloudAvailable: boolean;
  /** Current signed-in user, or null when logged out. */
  user: User | null;
  /** True while restoring an existing session on first load. */
  restoring: boolean;
  lastError: string | null;

  /**
   * The account password that just authenticated this session. In-memory
   * only (never written to storage). This is also the vault encryption key —
   * the store re-encrypts and auto-unlocks the vault with it.
   */
  accountPassword: string | null;
  /** Store the account password for the current session (in memory only). */
  setAccountPassword: (p: string) => void;

  signUp: (email: string, password: string, displayName: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Change the Supabase auth password (used by the vault-key migration). */
  updateAccountPassword: (current: string, next: string) => Promise<void>;
  clearError: () => void;
}

const Ctx = createContext<AuthStore | null>(null);

export function useAuthStore(): AuthStore {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuthStore must be used within <AuthProvider>');
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [lastError, setLastError] = useState<string | null>(null);
  // The account password that authenticated this session. In-memory only — it
  // is the vault encryption key (PBKDF2 -> AES-GCM), held here so the vault
  // store can auto-create / auto-unlock after sign-in without a second gate.
  const [accountPassword, setAccountPasswordState] = useState<string | null>(null);

  const setAccountPassword = useCallback((p: string) => setAccountPasswordState(p), []);
  const cloudAvailable = isCloudEnabled();

  // Restore any persisted session + subscribe to auth changes on mount.
  useEffect(() => {
    if (!cloudAvailable) {
      setRestoring(false);
      return;
    }
    const sb = getSupabase()!;
    let mounted = true;
    // Safety: even if getSession() hangs or rejects (offline, blocked, bot
    // wall), `restoring` must clear so the app can't get stuck on the old
    // local-only screen. 8s is well past a normal restore.
    const watchdog = window.setTimeout(() => {
      if (mounted) setRestoring(false);
    }, 8000);
    sb.auth
      .getSession()
      .then(({ data }) => {
        if (!mounted) return;
        setUser(data.session?.user ?? null);
        setRestoring(false);
      })
      .catch(() => {
        if (!mounted) return;
        setRestoring(false);
      })
      .finally(() => window.clearTimeout(watchdog));
    const { data: sub } = sb.auth.onAuthStateChange((_e, session) => {
      setUser(session?.user ?? null);
    });
    return () => {
      mounted = false;
      window.clearTimeout(watchdog);
      sub.subscription.unsubscribe();
    };
  }, [cloudAvailable]);

  const signUp = useCallback(
    async (email: string, password: string, displayName: string) => {
      setLastError(null);
      const sb = getSupabase();
      if (!sb) throw new Error('Cloud sync is not configured.');
      // The email-confirmation link must land back on THIS app (with ?code=),
      // where detectSessionInUrl completes the session. Always send the live
      // origin + base path — never the Supabase project's default site URL
      // (which often still points at a dev machine).
      const emailRedirectTo =
        window.location.origin + (import.meta.env.BASE_URL || '/');
      const { data, error } = await sb.auth.signUp({
        email,
        password,
        options: {
          data: { display_name: displayName },
          emailRedirectTo,
        },
      });
      if (error) {
        setLastError(error.message);
        throw error;
      }
      // Email confirmation may be on: if no session yet, the user must confirm
      // before signing in. Surface that to the UI.
      if (!data.session) {
        setLastError(
          'Account created. Please confirm your email, then sign in.',
        );
      }
      // Keep the password as the in-memory vault key even while a session is
      // returned, so first-run vault creation is auto-unlocked on the next
      // screen without re-prompting.
      setAccountPasswordState(password);
    },
    [],
  );

  const signIn = useCallback(async (email: string, password: string) => {
    setLastError(null);
    const sb = getSupabase();
    if (!sb) throw new Error('Cloud sync is not configured.');
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      setLastError(error.message);
      throw error;
    }
    setUser(data.user);
    // Single credential: the password that just signed in is the vault key.
    setAccountPasswordState(password);
  }, []);

  const signOut = useCallback(async () => {
    const sb = getSupabase();
    if (sb) await sb.auth.signOut();
    setUser(null);
    setLastError(null);
    // Wipe the in-memory vault key on sign-out — zero-trust: nothing
    // survives the session.
    setAccountPasswordState(null);
  }, []);

  const updateAccountPassword = useCallback(
    async (current: string, next: string) => {
      const sb = getSupabase();
      if (!sb) throw new Error('Cloud sync is not configured.');
      const { data, error } = await sb.auth.updateUser({
        password: next,
      });
      if (error) {
        setLastError(error.message);
        throw error;
      }
      if (data.user) setUser(data.user);
      // The new password becomes the active vault key.
      setAccountPasswordState(next);
    },
    [],
  );

  const clearError = useCallback(() => setLastError(null), []);

  const store = useMemo<AuthStore>(
    () => ({
      cloudAvailable,
      user,
      restoring,
      lastError,
      accountPassword,
      setAccountPassword,
      signUp,
      signIn,
      signOut,
      updateAccountPassword,
      clearError,
    }),
    [cloudAvailable, user, restoring, lastError, accountPassword, setAccountPassword, signUp, signIn, signOut, updateAccountPassword, clearError],
  );

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}
