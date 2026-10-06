// ============================================================================
// OmniFlow — AuthProvider (Supabase email auth, multi-user accounts).
//
// Wraps @supabase/supabase-js auth. Exposes the current user + a small set of
// actions. Data lives ONLY in the Supabase DB (per-user encrypted vault row),
// so signing in is required for any persistence — the gate that presents the
// sign-in / sign-up choice is part of the app entry point (App.tsx), not of
// this provider.
//
// The auth layer only manages *identity* (who is the user). It never touches
// the passphrase or the encrypted vault; those stay in the SecurityManager.
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

  signUp: (email: string, password: string, displayName: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
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
  }, []);

  const signOut = useCallback(async () => {
    const sb = getSupabase();
    if (!sb) return;
    await sb.auth.signOut();
    setUser(null);
    setLastError(null);
  }, []);

  const clearError = useCallback(() => setLastError(null), []);

  const store = useMemo<AuthStore>(
    () => ({
      cloudAvailable,
      user,
      restoring,
      lastError,
      signUp,
      signIn,
      signOut,
      clearError,
    }),
    [cloudAvailable, user, restoring, lastError, signUp, signIn, signOut, clearError],
  );

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}
