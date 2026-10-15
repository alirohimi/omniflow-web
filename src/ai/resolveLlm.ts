// ============================================================================
// resolveLlm — pure, side-effect-free LLM resolution.
//
// There is exactly ONE AI source: the admin-set platform default
// (omniflow_llm_default single row). No per-user BYOK key and no per-user
// admin lock.
//
// TESTING PHASE OVERRIDE: when the admin default row is 'none' / unset, we
// fall back to a built-in platform default (adaCode provider, adacode-3.0-flash
// model, relay key) instead of null, so every user — existing or new — gets
// the LLM-powered coach and categorizer without anyone having to set the
// admin row. Revert `TESTING_PHASE_FALLBACK` to null (or delete the whole
// block) when the paywall / real admin row goes live.
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

// ---------------------------------------------------------------------------
// Testing-phase fallback: adaCode adacode-3.0-flash via the CORS-open relay.
// The relay (Supabase Edge Function) forwards server-side and stores nothing;
// the key transits per-request and is the shared adaCode relay key. When the
// real admin-set platform default row exists, it takes priority over this.
// ---------------------------------------------------------------------------
const TESTING_PHASE_FALLBACK: LLMConfig | null = {
  provider: 'adacode',
  apiKey: 'adacode-relay-shared-key', // relay ignores the client key for auth; it holds its own secret
  model: 'adacode-3.0-flash',
};

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
  // No shared admin row (or it's 'none'): during the testing phase, fall back
  // to the built-in adaCode default so every user gets LLM features.
  if (TESTING_PHASE_FALLBACK) return TESTING_PHASE_FALLBACK;
  return null;
}
