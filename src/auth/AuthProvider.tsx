// ============================================================================
// OmniFlow — AuthProvider (Supabase email auth, multi-user accounts).
//
// Wraps @supabase/supabase-js auth. Exposes the current user + a small set of
// actions. When the cloud client is NOT configured, the whole provider is
// inert (cloudAvailable = false) and the app runs in the existing local-only
// mode — so nothing depends on the cloud being reachable.
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
  /** Current signed-in user, or null when logged out / local-only. */
  user: User | null;
  /** True while restoring an existing session on first load. */
  restoring: boolean;
  /** User chose "continue on this device" — skip the account gate, stay local. */
  localMode: boolean;
  lastError: string | null;

  signUp: (email: string, password: string, displayName: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Opt out of the account gate on this device (use the local-only vault). */
  enterLocalMode: () => void;
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
  const [localMode, setLocalMode] = useState(false);
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
    sb.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setUser(data.session?.user ?? null);
      setRestoring(false);
    });
    const { data: sub } = sb.auth.onAuthStateChange((_e, session) => {
      setUser(session?.user ?? null);
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [cloudAvailable]);

  const signUp = useCallback(
    async (email: string, password: string, displayName: string) => {
      setLastError(null);
      const sb = getSupabase();
      if (!sb) throw new Error('Cloud sync is not configured.');
      const { data, error } = await sb.auth.signUp({
        email,
        password,
        options: { data: { display_name: displayName } },
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
    setLocalMode(false); // after signing out, offer the account gate again
    setLastError(null);
  }, []);

  const enterLocalMode = useCallback(() => {
    // "Continue on this device": no account, use the local-only vault.
    setUser(null);
    setLocalMode(true);
    setLastError(null);
  }, []);

  const clearError = useCallback(() => setLastError(null), []);

  const store = useMemo<AuthStore>(
    () => ({
      cloudAvailable,
      user,
      restoring,
      localMode,
      lastError,
      signUp,
      signIn,
      signOut,
      enterLocalMode,
      clearError,
    }),
    [cloudAvailable, user, restoring, localMode, lastError, signUp, signIn, signOut, enterLocalMode, clearError],
  );

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}
