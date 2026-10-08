// ============================================================================
// OmniFlow — admin & LLM policy service (Supabase, RLS-enforced).
//
// The browser only ever holds the public anon key. Authorization is enforced
// entirely by row-level security on three small tables (see
// supabase/migrations/0002_admin_and_llm_policy.sql):
//
//   omniflow_admins      user_id registry. Reading is open to signed-in users
//                        (UI gating); writing requires admin status, which
//                        makes self-escalation impossible from the client.
//   omniflow_members     self-registry of signed-in users (directory). Each
//                        user can only upsert their own row; admins read all.
//   omniflow_llm_policy  admin-assigned LLM provider/key/model per user.
//                        A user may read ONLY their own row; writing requires
//                        admin status.
//
// Every function is a no-op / safe default when the cloud layer is off or the
// schema has not been applied yet, so the app keeps working end-to-end before
// the migration is run (and never crashes on the "table missing" error).
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase, isCloudEnabled } from './supabase';
import type { LLMProvider } from '../domain/types';

/** A registered member (directory row). No financial data, by design. */
export interface MemberRow {
  user_id: string;
  display_name: string;
  email: string;
  last_seen_at: string;
}

/** Admin-assigned LLM policy for one user. */
export interface LlmPolicyRow {
  user_id: string;
  provider: LLMProvider;
  api_key: string;
  model: string;
  key_finger: string;
  updated_at: string;
}

/** Vault-row sync metadata (admin directory view). Ciphertext only. */
export interface VaultSyncRow {
  user_id: string;
  created_at: string;
  updated_at: string;
}

/**
 * Errors that mean "the schema/migration has not been applied to this
 * project yet". All others (network, auth) are propagated as `undefined`
 * results with a console warning — callers treat missing as "feature off".
 */
function schemaMissing(err: { message?: string }): boolean {
  const m = (err.message ?? '').toLowerCase();
  return (
    m.includes('relation "public.omniflow_') ||
    m.includes('does not exist') ||
    m.includes('pgrst205') ||
    m.includes('pgrst204')
  );
}

// ---- membership (self) -------------------------------------------------------

/** Register/refresh the current user in the member directory (fire-and-forget). */
export async function upsertSelfMember(
  userId: string,
  email: string,
  displayName: string,
): Promise<boolean> {
  if (!isCloudEnabled()) return false;
  const sb: SupabaseClient = getSupabase()!;
  const { error } = await sb.from('omniflow_members').upsert({
    user_id: userId,
    email: email.toLowerCase(),
    display_name: displayName,
    last_seen_at: new Date().toISOString(),
  });
  if (error) {
    if (!schemaMissing(error)) console.warn('[admin] member upsert:', error.message);
    return false;
  }
  return true;
}

// ---- admin status -------------------------------------------------------------

/** True when `userId` is in the admin registry. */
export async function isAdmin(userId: string): Promise<boolean> {
  if (!isCloudEnabled()) return false;
  const sb = getSupabase()!;
  const { data, error } = await sb
    .from('omniflow_admins')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    if (!schemaMissing(error)) console.warn('[admin] isAdmin:', error.message);
    return false;
  }
  return data != null;
}

/** All user_ids currently in the admin registry (for UI badges). */
export async function listAdminIds(): Promise<string[]> {
  if (!isCloudEnabled()) return [];
  const sb = getSupabase()!;
  const { data, error } = await sb.from('omniflow_admins').select('user_id');
  if (error) {
    if (!schemaMissing(error)) console.warn('[admin] listAdminIds:', error.message);
    return [];
  }
  return (data ?? []).map((r) => r.user_id);
}

/** Admin only: promote a user to admin. Returns false when not permitted. */
export async function grantAdmin(actorUserId: string, targetUserId: string): Promise<boolean> {
  if (!isCloudEnabled()) return false;
  const sb = getSupabase()!;
  const { error } = await sb.from('omniflow_admins').upsert({
    user_id: targetUserId,
    created_by: actorUserId,
  });
  if (error) {
    console.warn('[admin] grant:', error.message);
    return false;
  }
  return true;
}

/** Admin only: demote a user. */
export async function revokeAdmin(actorUserId: string, targetUserId: string): Promise<boolean> {
  if (!isCloudEnabled()) return false;
  const sb = getSupabase()!;
  const { error } = await sb.from('omniflow_admins').delete().eq('user_id', targetUserId);
  if (error) {
    console.warn('[admin] revoke:', error.message);
    return false;
  }
  return true;
}

// ---- directory (admin read; all users may read) --------------------------------

/** All registered members. [] when cloud is off or the schema is missing. */
export async function listMembers(): Promise<MemberRow[]> {
  if (!isCloudEnabled()) return [];
  const sb = getSupabase()!;
  const { data, error } = await sb.from('omniflow_members').select(
    'user_id, display_name, email, last_seen_at',
  );
  if (error) {
    if (!schemaMissing(error)) console.warn('[admin] listMembers:', error.message);
    return [];
  }
  return (data ?? []) as MemberRow[];
}

/** Per-user vault sync metadata (admin read). Ciphertext rows only. */
export async function listVaultSync(): Promise<VaultSyncRow[]> {
  if (!isCloudEnabled()) return [];
  const sb = getSupabase()!;
  const { data, error } = await sb
    .from('omniflow_vaults')
    .select('user_id, created_at, updated_at')
    .order('updated_at', { ascending: false });
  if (error) {
    if (!schemaMissing(error)) console.warn('[admin] listVaultSync:', error.message);
    return [];
  }
  return (data ?? []) as VaultSyncRow[];
}

// ---- LLM policy ----------------------------------------------------------------

/**
 * Read the admin-assigned LLM policy for `userId` (their own row).
 * `undefined` when none, cloud off, or schema missing — the app then falls
 * back to the user's local BYOK settings.
 */
export async function getMyLlmPolicy(userId: string): Promise<LlmPolicyRow | undefined> {
  if (!isCloudEnabled()) return undefined;
  const sb = getSupabase()!;
  const { data, error } = await sb
    .from('omniflow_llm_policy')
    .select('user_id, provider, api_key, model, key_finger, updated_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    if (!schemaMissing(error)) console.warn('[admin] getMyLlmPolicy:', error.message);
    return undefined;
  }
  if (!data) return undefined;
  return data as LlmPolicyRow;
}

/**
 * Admin only: lock a user's LLM provider/key/model. Provider 'none' + empty
 * key means "unlock — use the user's own BYOK settings".
 */
export async function setLlmPolicy(
  actorUserId: string,
  targetUserId: string,
  provider: LLMProvider,
  apiKey: string,
  model: string,
  keyFinger: string,
): Promise<boolean> {
  if (!isCloudEnabled()) return false;
  const sb = getSupabase()!;
  const { error } = await sb.from('omniflow_llm_policy').upsert({
    user_id: targetUserId,
    provider,
    api_key: apiKey,
    model: model || '',
    key_finger: keyFinger || '',
    set_by: actorUserId,
  });
  if (error) {
    console.warn('[admin] setLlmPolicy:', error.message);
    return false;
  }
  return true;
}

/**
 * Admin only: list the LLM policy rows for all members. Returns a map of
 * user_id -> {provider, keyFinger, model, updatedAt}. The api_key is NEVER
 * exposed here — only its fingerprint — so an admin can see "who is locked
 * to which provider" without ever reading the raw key.
 */
export interface PolicySummary {
  user_id: string;
  provider: LLMProvider;
  key_finger: string;
  model: string;
  updated_at: string;
}

export async function listPolicies(): Promise<PolicySummary[]> {
  if (!isCloudEnabled()) return [];
  const sb = getSupabase()!;
  const { data, error } = await sb
    .from('omniflow_llm_policy')
    .select('user_id, provider, key_finger, model, updated_at');
  if (error) {
    if (!schemaMissing(error)) console.warn('[admin] listPolicies:', error.message);
    return [];
  }
  return (data ?? []) as unknown as PolicySummary[];
}

/** Admin only: clear a user's policy (fully unlock their LLM section). */
export async function clearLlmPolicy(actorUserId: string, targetUserId: string): Promise<boolean> {
  if (!isCloudEnabled()) return false;
  const sb = getSupabase()!;
  const { error } = await sb.from('omniflow_llm_policy').delete().eq('user_id', targetUserId);
  if (error) {
    console.warn('[admin] clearLlmPolicy:', error.message);
    return false;
  }
  return true;
}

// ---- admin data wipe --------------------------------------------------------------

/** Admin only: delete a member's encrypted vault row (irreversible). */
export async function wipeMemberVault(actorUserId: string, targetUserId: string): Promise<boolean> {
  if (!isCloudEnabled()) return false;
  const sb = getSupabase()!;
  const { error } = await sb.from('omniflow_vaults').delete().eq('user_id', targetUserId);
  if (error) {
    console.warn('[admin] wipeMemberVault:', error.message);
    return false;
  }
  return true;
}
