// ============================================================================
// resolveLlm — pure, side-effect-free LLM resolution chain.
//
// Resolution order:
//   1. Admin per-user lock (omniflow_llm_policy row). If this row exists,
//      it is the final authority: provider!=none + key -> use it; provider
//      'none' or missing key -> null (admin forced on-device rules, NO
//      fall-through to BYOK or platform default).
//   2. User's own BYOK key (vault.llmKey, encrypted inside the vault).
//   3. Platform default (omniflow_llm_default single row, set by an admin).
//   4. null  -> free on-device rule engine (no LLM call).
//
// This module is pure: no React, no Supabase, no fetch.  It is a simple
// data-in / data-out function so it can be unit-tested in isolation and
// consumed by the store's llmConfig useMemo.
// ============================================================================

import type { LLMConfig } from './categorize';
import type { LLMProvider } from '../domain/types';
import type { LlmPolicyRow, DefaultLlmRow } from '../services/admin';

/** Minimal vault slice the resolver needs (avoids a full VaultBlob import). */
export interface VaultLlmSlice {
  prefs: { llmProvider: LLMProvider; llmModel?: string };
  llmKey: string; // encrypted-at-rest BYOK key; '' when not set
}

export interface ResolveArgs {
  vault: VaultLlmSlice | null;
  llmPolicy: LlmPolicyRow | undefined;
  defaultLlm: DefaultLlmRow | undefined;
}

/**
 * Compute the effective LLM configuration from the three sources, in
 * descending priority. Returns null when no cloud LLM applies and the
 * app should fall through to the free on-device rule engine.
 */
export function resolveLlmConfig(args: ResolveArgs): LLMConfig | null {
  const vault = args.vault;
  const lock = args.llmPolicy;
  const def = args.defaultLlm;

  // ---- Tier 1: admin per-user lock (omniflow_llm_policy) ----
  // If the admin has set a row for this user, it is the final word.
  // A 'none' provider or empty key means "force on-device"; do NOT fall
  // through to BYOK or the platform default.
  if (lock) {
    if (lock.provider !== 'none' && lock.api_key) {
      const k = lock.api_key;
      const m = lock.model?.trim();
      return { provider: lock.provider, apiKey: k, model: m || undefined };
    }
    // Explicit 'none' or keyless policy -> on-device only.
    return null;
  }

  // ---- Tier 2: the user's own BYOK key ----
  if (vault && vault.prefs.llmProvider !== 'none' && vault.llmKey) {
    const k = vault.llmKey;
    const m = vault.prefs.llmModel?.trim();
    return { provider: vault.prefs.llmProvider, apiKey: k, model: m || undefined };
  }

  // ---- Tier 3: platform default (omniflow_llm_default) ----
  if (def && def.provider !== 'none' && def.api_key) {
    const k = def.api_key;
    const m = def.model?.trim();
    return { provider: def.provider, apiKey: k, model: m || undefined };
  }

  // ---- Tier 4: free on-device rule engine ----
  return null;
}
