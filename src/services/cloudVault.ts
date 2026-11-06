// ============================================================================
// OmniFlow — per-user cloud vault sync (Supabase Postgres).
//
// Stores ONLY the encrypted VaultCipher (v, salt, iv, body) for a given user,
// in the `omniflow_vaults` table scoped to `user_id = auth.uid()` via RLS.
// Ciphertext is the payload; no plaintext ever reaches the database.
//
// Each method is a no-op (resolves undefined / null) when the cloud client is
// not configured, so callers can always invoke it and rely on local mode.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { VaultCipher } from '../security/vault';
import { cloudEndpoints, getSupabase, isCloudEnabled } from './supabase';

interface VaultRow {
  user_id: string;
  v: number;
  salt: string;
  iv: string;
  body: string;
}

/**
 * Strict read: `undefined` only on a genuine no-row, but THROWS on any
 * database / network error. Callers that must distinguish "no data" from
 * "couldn't reach the DB" (e.g. the auto-create path) use this so a
 * transient failure can never be mistaken for first-run and wipe a real
 * vault. The lenient `fetchCloudVault` above is kept for fire-and-forget
 * reads that are happy to treat an error as "no row yet".
 */
export async function fetchCloudVaultStrict(userId: string): Promise<VaultCipher | undefined> {
  if (!isCloudEnabled()) return undefined;
  const sb: SupabaseClient = getSupabase()!;
  const { data, error } = await sb
    .from('omniflow_vaults')
    .select('v, salt, iv, body')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    // RLS deny (no policy yet) is a configuration gap, not a real failure —
    // surface it as "no cloud row" so local dev still works. Everything else
    // (network, PostgREST down) is a genuine error: throw so the caller
    // falls back to an "unavailable / retry" state instead of wiping data.
    if (/row-level security|policy|permission/i.test(error.message)) {
      console.warn('[cloudVault] fetch (RLS deny, treating as no row):', error.message);
      return undefined;
    }
    throw error;
  }
  const r = data as unknown as VaultRow | null;
  if (!r) return undefined;
  return { v: r.v, salt: r.salt, iv: r.iv, body: r.body };
}

/** Read the encrypted blob for a user, or undefined when none / cloud off. */
export async function fetchCloudVault(userId: string): Promise<VaultCipher | undefined> {
  if (!isCloudEnabled()) return undefined;
  const sb: SupabaseClient = getSupabase()!;
  const { data, error } = await sb
    .from('omniflow_vaults')
    .select('v, salt, iv, body')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    // RLS deny (no policy yet) surfaces as a PostgREST permission error — treat
    // as "no cloud row" rather than crashing the local flow.
    console.warn('[cloudVault] fetch:', error.message);
    return undefined;
  }
  const r = data as unknown as VaultRow | null;
  if (!r) return undefined;
  return { v: r.v, salt: r.salt, iv: r.iv, body: r.body };
}

/** Upsert the encrypted blob for a user. Returns true on success. */
export async function saveCloudVault(userId: string, cipher: VaultCipher): Promise<boolean> {
  if (!isCloudEnabled()) return false;
  const sb: SupabaseClient = getSupabase()!;
  const { error } = await sb.from('omniflow_vaults').upsert({
    user_id: userId,
    v: cipher.v,
    salt: cipher.salt,
    iv: cipher.iv,
    body: cipher.body,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    console.warn('[cloudVault] save:', error.message);
    return false;
  }
  return true;
}

/** Delete a user's cloud row (used on "Erase all data"). */
export async function deleteCloudVault(userId: string): Promise<void> {
  if (!isCloudEnabled()) return;
  const sb: SupabaseClient = getSupabase()!;
  const { error } = await sb.from('omniflow_vaults').delete().eq('user_id', userId);
  if (error) console.warn('[cloudVault] delete:', error.message);
}

// ---------------------------------------------------------------------------
// Keepalive flush (unload-time last save)
// ---------------------------------------------------------------------------

/**
 * Best-effort keepalive upsert of the last encrypted vault blob.
 *
 * The normal save path (saveCloudVault, via the Supabase SDK) is
 * fire-and-forget: if the tab reloads or closes while the last upsert is in
 * flight, that fetch is aborted and the newest vault change (chat history,
 * expenses) never reaches the DB. A raw fetch with `keepalive: true` is the
 * only transport that survives document teardown, so on visibility-hidden /
 * pagehide the store re-sends the last encrypted blob here.
 *
 * It talks to PostgREST directly (POST {url}/rest/v1/omniflow_vaults with
 * Prefer: resolution=merge-duplicates, i.e. an upsert) using the session JWT
 * as Bearer, because the SDK cannot attach keepalive. The payload is
 * ciphertext only — a leaked body reveals nothing. Idempotent: re-sending
 * the same blob changes no data (the touch trigger may refresh updated_at,
 * which is harmless).
 *
 * Known limit: some engines cap keepalive request bodies (~64KB in older
 * Chromium). A very large vault may not flush reliably — still strictly
 * better than never flushing, since the background save has usually
 * completed by the time the user leaves.
 *
 * @param userId    the signed-in user's uuid (auth.uid() for RLS)
 * @param cipher    the last encrypted blob (VaultCipher)
 * @param accessToken the session access token (JWT) — required; without a
 *                    valid JWT, RLS auth.uid() is null and the upsert is
 *                    denied, so we skip instead of failing.
 * @param endpoints optional PostgREST base + anon key (defaults to the
 *                    configured cloud endpoints); injectable for tests.
 */
export function flushVaultKeepalive(
  userId: string,
  cipher: VaultCipher,
  accessToken: string | null,
  endpoints?: { url: string; anonKey: string } | null,
): void {
  const ep = endpoints === undefined ? cloudEndpoints() : endpoints;
  if (!ep || !accessToken) return; // cloud off, or nothing we can authenticate with
  try {
    void fetch(`${ep.url}/rest/v1/omniflow_vaults`, {
      method: 'POST',
      keepalive: true,
      headers: {
        apikey: ep.anonKey,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        user_id: userId,
        v: cipher.v,
        salt: cipher.salt,
        iv: cipher.iv,
        body: cipher.body,
        updated_at: new Date().toISOString(),
      }),
    }).catch(() => {
      /* Best-effort: nothing left to do once the document is gone. */
    });
  } catch {
    /* fetch unavailable in the engine — skip silently. */
  }
}
