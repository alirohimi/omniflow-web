// ============================================================================
// OmniFlow — Supabase client (per-user encrypted vault rows in Postgres).
//
// Any PostgREST + JWT-auth backend (hosted Supabase, a local supabase start
// stack, a standalone Postgres + GoTrue/Keycloak, …) works here. Configure
// via VITE_SUPABASE_URL (auth URL) + VITE_SUPABASE_ANON_KEY, or override the
// rest base with VITE_SUPABASE_REST_URL (local stacks split these: auth on
// /auth/v1, PostgREST on /rest/v1 under the same origin).
//
// When no endpoint is configured (local dev) the app still runs, but the
// vault is in-memory only: nothing is written to disk.
//
// The DB stores only AES-GCM ciphertext + salt + iv. No plaintext financial
// data ever reaches Supabase; the passphrase stays device-local.
// ============================================================================

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
// Optional override of the PostgREST base (default: the auth URL above).
// Needed when auth and REST live on different origins/ports (some local stacks).
const restUrlOverride = (import.meta.env.VITE_SUPABASE_REST_URL as string | undefined)?.trim() || undefined;

// Tolerate a one-letter-missing "htps://" typo in the configured URL and
// normalize it to a valid https scheme — so a single dropped character in a
// CI secret can never silently disable the whole cloud layer. (Local
// http:// endpoints — e.g. a supabase start stack — are allowed too.)
const normUrl = (() => {
  const raw = (url ?? '').trim();
  return /^htps:\//i.test(raw) ? raw.replace(/^htps:/i, 'https:') : raw;
})();

/**
 * True when a Supabase-compatible endpoint is configured (enables Auth +
 * cloud vault sync). Accepts http and https; must be a real hostname.
 */
export const isCloudEnabled = (): boolean =>
  !!normUrl && !!anonKey && /^https?:\/\/(www\.)?/.test(normUrl) && normUrl.includes('.');

/** Base URL the PostgREST API lives at (raw keepalive upserts). */
export function cloudRestUrl(): string | undefined {
  if (restUrlOverride) return restUrlOverride.replace(/\/+$/, '');
  if (!normUrl) return undefined;
  // Hosted Supabase serves auth and rest on the same origin.
  return normUrl;
}

let _client: SupabaseClient | null = null;

/** Lazily-constructed client (null when cloud is not configured). */
export function getSupabase(): SupabaseClient | null {
  if (!isCloudEnabled()) return null;
  if (!_client) {
    const restUrl = cloudRestUrl() ?? undefined;
    _client = createClient(normUrl, anonKey!, {
      ...(restUrl ? { rest: { url: restUrl } } : {}),
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

/**
 * Normalized PostgREST base + anon key, or null when cloud is not
 * configured. Exposed for the keepalive vault flush, which must talk to
 * PostgREST via raw fetch (the SDK cannot attach `keepalive: true`).
 */
export function cloudEndpoints(): { url: string; anonKey: string } | null {
  if (!isCloudEnabled()) return null;
  const r = cloudRestUrl();
  if (!r) return null;
  return { url: r, anonKey: anonKey! };
}
