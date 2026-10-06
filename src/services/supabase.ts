// ============================================================================
// OmniFlow — Supabase client (multi-user cloud sync).
//
// When VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY are configured the app gains
// email accounts (Supabase Auth) and syncs each user's *encrypted* vault blob
// to a per-user Postgres row (omniflow_vaults, RLS-scoped to auth.uid()).
//
// When they are NOT configured, `supabase` is null and the app runs in
// local-only mode exactly as before (IndexedDB, one global vault) — so the
// zero-trust guarantee never depends on the cloud being reachable.
//
// The DB stores only AES-GCM ciphertext + salt + iv. No plaintext financial
// data ever reaches Supabase; the passphrase stays device-local.
// ============================================================================

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** True when a Supabase endpoint is configured (enables Auth + cloud vault sync). */
export const isCloudEnabled = (): boolean =>
  !!url && !!anonKey && /^https:\/\//.test(url);

let _client: SupabaseClient | null = null;

/** Lazily-constructed client (null when cloud is not configured). */
export function getSupabase(): SupabaseClient | null {
  if (!isCloudEnabled()) return null;
  if (!_client) {
    _client = createClient(url!, anonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Email-only auth; we never use OAuth providers.
        detectSessionInUrl: false,
      },
    });
  }
  return _client;
}
