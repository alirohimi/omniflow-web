// ============================================================================
// resolveLlm — pure, side-effect-free LLM resolution.
//
// There is exactly ONE AI source: the admin-set platform default
// (omniflow_llm_default single row). No per-user BYOK key and no per-user
// admin lock. If the default is 'none' / unset, we return null and the app
// falls through to the free on-device rule engine.
//
// This module is pure: no React, no Supabase, no fetch. It is a simple
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
  // There is exactly ONE AI source: the admin-set platform default.
  // No per-user BYOK key and no per-user admin lock.
  const def = args.defaultLlm;
  if (def && def.provider !== 'none' && def.api_key) {
    return { provider: def.provider, apiKey: def.api_key, model: def.model?.trim() || undefined };
  }
  // No shared model set: null -> free on-device rule engine.
  return null;
}
