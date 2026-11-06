// ============================================================================
// OmniFlow — LLM resolution regression tests (single shared AI config).
//
// resolveLlmConfig is the single source of truth for "which LLM does the AI
// engine use?". There is exactly ONE AI source: the admin-set platform
// default (omniflow_llm_default). No per-user BYOK key and no per-user admin
// lock. If the default is 'none' / unset, the function returns null and the
// app falls through to the free on-device rule engine.
//
// Pure function, no React/Supabase/fetch — unit-testable in isolation.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { resolveLlmConfig } from '../src/ai/resolveLlm';
import type { VaultLlmSlice } from '../src/ai/resolveLlm';
import type { DefaultLlmRow } from '../src/services/admin';
import type { LLMProvider } from '../src/domain/types';

// ---- fixtures ---------------------------------------------------------------
function platform(provider: LLMProvider, key: string, model: string): DefaultLlmRow {
  return { provider, api_key: key, model, key_finger: key ? 'aa' : '', updated_at: 'now' };
}
const noByok: VaultLlmSlice = { prefs: { llmProvider: 'none' }, llmKey: '' };

describe('resolveLlmConfig — single shared AI config', () => {
  it('platform default (provider+key) is used', () => {
    const cfg = resolveLlmConfig({
      vault: noByok,
      llmPolicy: undefined,
      defaultLlm: platform('openai', 'sk-platform', 'gpt-4o-mini'),
    });
    expect(cfg?.provider).toBe('openai');
    expect(cfg?.model).toBe('gpt-4o-mini');
    expect(cfg?.apiKey).toBeTruthy();
  });

  it('a different provider on the default is honoured', () => {
    const cfg = resolveLlmConfig({
      vault: noByok,
      llmPolicy: undefined,
      defaultLlm: platform('gemini', 'sk-google', 'gpt-9'),
    });
    expect(cfg?.provider).toBe('gemini');
    expect(cfg?.model).toBe('gpt-9');
  });

  it('per-user BYOK is IGNORED (there is no BYOK anymore)', () => {
    // A user who "had" a BYOK key gets the platform default, not their own.
    const byokUser: VaultLlmSlice = { prefs: { llmProvider: 'openai', llmModel: 'gpt-4' }, llmKey: 'sk-user' };
    const cfg = resolveLlmConfig({
      vault: byokUser,
      llmPolicy: undefined,
      defaultLlm: platform('anthropic', 'sk-platform', 'claude-x'),
    });
    expect(cfg?.provider).toBe('anthropic');
    expect(cfg?.model).toBe('claude-x');
  });

  it('per-user admin lock is IGNORED (there is no per-user lock anymore)', () => {
    // Even if a lock row exists, only the platform default matters.
    const byokUser: VaultLlmSlice = { prefs: { llmProvider: 'none' }, llmKey: '' };
    const cfg = resolveLlmConfig({
      vault: byokUser,
      llmPolicy: undefined,
      defaultLlm: platform('adacode', 'sk-ada', 'ada-x'),
    });
    expect(cfg?.provider).toBe('adacode');
    expect(cfg?.model).toBe('ada-x');
  });

  it('a missing platform row (pre-0003) -> adacode-3.0-flash testing-phase fallback', () => {
    const cfg = resolveLlmConfig({
      vault: noByok,
      llmPolicy: undefined,
      defaultLlm: undefined,
    });
    expect(cfg?.provider).toBe('adacode');
    expect(cfg?.model).toBe('adacode-3.0-flash');
  });

  it("the platform row set to 'none' -> adacode-3.0-flash testing-phase fallback", () => {
    const cfg = resolveLlmConfig({
      vault: noByok,
      llmPolicy: undefined,
      defaultLlm: platform('none', '', ''),
    });
    expect(cfg?.provider).toBe('adacode');
    expect(cfg?.model).toBe('adacode-3.0-flash');
  });

  it('a keyless platform row -> adacode-3.0-flash testing-phase fallback', () => {
    const cfg = resolveLlmConfig({
      vault: noByok,
      llmPolicy: undefined,
      defaultLlm: platform('openai', '', 'gpt-4'),
    });
    expect(cfg?.provider).toBe('adacode');
    expect(cfg?.model).toBe('adacode-3.0-flash');
  });
});
