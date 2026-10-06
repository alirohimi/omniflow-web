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
import { getSupabase, isCloudEnabled } from './supabase';

interface VaultRow {
  user_id: string;
  v: number;
  salt: string;
  iv: string;
  body: string;
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
