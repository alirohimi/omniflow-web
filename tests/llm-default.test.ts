// ============================================================================
// OmniFlow — LLM resolution-chain regression tests (0003 platform default).
//
// resolveLlmConfig is the single source of truth for "which LLM does this
// user's AI engine use?". The chain is, in descending priority:
//   1. Admin per-user lock (omniflow_llm_policy)   -> final word
//   2. User's own BYOK key                          (vault.llmKey)
//   3. Platform default (omniflow_llm_default, 0003)
//   4. null -> free on-device rule engine
//
// Pure function, no React/Supabase/fetch — unit-testable in isolation.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { resolveLlmConfig } from '../src/ai/resolveLlm';
import type { VaultLlmSlice } from '../src/ai/resolveLlm';
import type { LlmPolicyRow, DefaultLlmRow } from '../src/services/admin';
import type { LLMProvider } from '../src/domain/types';

// ---- fixtures ---------------------------------------------------------------
function policy(provider: LLMProvider, key: string, model: string): LlmPolicyRow {
  return {
    user_id: 'u-1',
    provider,
    api_key: key,
    model,
    key_finger: key ? 'ff' : '',
    updated_at: 'now',
  };
}
function byok(provider: LLMProvider, key: string, model?: string): VaultLlmSlice {
  return { prefs: { llmProvider: provider, llmModel: model }, llmKey: key };
}
function platform(provider: LLMProvider, key: string, model: string): DefaultLlmRow {
  return { provider, api_key: key, model, key_finger: key ? 'aa' : '', updated_at: 'now' };
}
const noByok: VaultLlmSlice = { prefs: { llmProvider: 'none' }, llmKey: '' };

describe('resolveLlmConfig — admin lock wins everything', () => {
  it('lock (provider+key) overrides BYOK, platform default, and on-device', () => {
    const cfg = resolveLlmConfig({
      vault: byok('openai', 'sk-user'),
      llmPolicy: policy('anthropic', 'sk-admin', 'claude-x'),
      defaultLlm: platform('gemini', 'sk-google', 'gpt-9'),
    });
    expect(cfg?.provider).toBe('anthropic');
    expect(cfg?.model).toBe('claude-x');
    expect(cfg?.apiKey).toBeTruthy();
  });

  it("an explicit 'none' lock forces on-device even when BYOK + platform default exist", () => {
    const cfg = resolveLlmConfig({
      vault: byok('openai', 'sk-user'),
      llmPolicy: policy('none', '', ''),
      defaultLlm: platform('gemini', 'sk-google', 'gpt-9'),
    });
    expect(cfg).toBeNull();
  });

  it('a keyless lock also forces on-device (no fall-through)', () => {
    const cfg = resolveLlmConfig({
      vault: byok('openai', 'sk-user'),
      llmPolicy: policy('openai', '', 'gpt-4'),
      defaultLlm: platform('gemini', 'sk-google', 'gpt-9'),
    });
    expect(cfg).toBeNull();
  });
});

describe('resolveLlmConfig — user BYOK beats platform default', () => {
  it('BYOK key (no lock) is preferred over the platform default', () => {
    const cfg = resolveLlmConfig({
      vault: byok('openai', 'sk-user', 'gpt-4'),
      llmPolicy: undefined,
      defaultLlm: platform('gemini', 'sk-google', 'gpt-9'),
    });
    expect(cfg?.provider).toBe('openai');
    expect(cfg?.model).toBe('gpt-4');
    expect(cfg?.apiKey).toBeTruthy();
  });

  it('a BYOK provider set to none means "no personal key" -> platform default', () => {
    const cfg = resolveLlmConfig({
      vault: noByok,
      llmPolicy: undefined,
      defaultLlm: platform('gemini', 'sk-google', 'gpt-9'),
    });
    expect(cfg?.provider).toBe('gemini');
    expect(cfg?.model).toBe('gpt-9');
  });
});

describe('resolveLlmConfig — platform default (0003)', () => {
  it('no lock, no BYOK: the platform default row is used', () => {
    const cfg = resolveLlmConfig({
      vault: noByok,
      llmPolicy: undefined,
      defaultLlm: platform('openai', 'sk-platform', 'gpt-4o-mini'),
    });
    expect(cfg?.provider).toBe('openai');
    expect(cfg?.model).toBe('gpt-4o-mini');
    expect(cfg?.apiKey).toBeTruthy();
  });

  it('a missing platform row (pre-0003) still lets BYOK through', () => {
    const cfg = resolveLlmConfig({
      vault: byok('anthropic', 'sk-user'),
      llmPolicy: undefined,
      defaultLlm: undefined,
    });
    expect(cfg?.provider).toBe('anthropic');
  });
});

describe('resolveLlmConfig — free on-device fallback', () => {
  it('no lock, no BYOK, no platform default -> null (rule engine)', () => {
    const cfg = resolveLlmConfig({
      vault: noByok,
      llmPolicy: undefined,
      defaultLlm: undefined,
    });
    expect(cfg).toBeNull();
  });

  it('no lock, no BYOK, and the platform row is itself none -> null', () => {
    const cfg = resolveLlmConfig({
      vault: noByok,
      llmPolicy: undefined,
      defaultLlm: platform('none', '', ''),
    });
    expect(cfg).toBeNull();
  });
});
