// ============================================================================
// OmniFlow — Supabase client (per-user encrypted vault rows in Postgres).
//
// When VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY are configured the app
// enables email accounts (Supabase Auth) and persists each user's *encrypted*
// vault blob to a per-user Postgres row (omniflow_vaults, RLS-scoped to
// auth.uid()). That DB row is the ONLY persisted copy of user data — there is
// no local storage layer. When the env vars are missing (local dev), the app
// still runs, but the vault is in-memory only: nothing is written to disk.
//
// The DB stores only AES-GCM ciphertext + salt + iv. No plaintext financial
// data ever reaches Supabase; the passphrase stays device-local.
// ============================================================================

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// Tolerate a one-letter-missing "htps://" typo in the configured URL and
// normalize it to a valid https scheme — so a single dropped character in a
// CI secret can never silently disable the whole cloud layer.
const normUrl = (() => {
  const raw = (url ?? '').trim();
  return /^htps:\//i.test(raw) ? raw.replace(/^htps:/i, 'https:') : raw;
})();

/** True when a Supabase endpoint is configured (enables Auth + cloud vault sync). */
export const isCloudEnabled = (): boolean =>
  !!normUrl && !!anonKey && /^https:\/\/(www\.)?/.test(normUrl) && normUrl.includes('.');

let _client: SupabaseClient | null = null;

/** Lazily-constructed client (null when cloud is not configured). */
export function getSupabase(): SupabaseClient | null {
  if (!isCloudEnabled()) return null;
  if (!_client) {
    _client = createClient(normUrl!, anonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Email-only auth; we never use OAuth providers.
        // Must be TRUE: after the user clicks the email-confirmation link,
        // the browser lands on the app with ?code=…&type=signup and the
        // client silently exchanges the code for a session here. If this is
        // false, confirmation "succeeds" on the server but the app never
        // learns the user is confirmed — the classic broken-confirmation bug.
        detectSessionInUrl: true,
      },
    });
  }
  return _client;
}
