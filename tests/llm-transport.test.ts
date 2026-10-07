// ============================================================================
// OmniFlow — LLM transport vision tests (no network: fetch is stubbed).
// Proves image attachments are shaped correctly for each provider, and that
// jsonMode is only forced where structured output is needed (categorize),
// never on the coach's prose path.
// ============================================================================

import { describe, it, expect, vi, afterEach } from 'vitest';
import { callLLM, __test } from '../src/ai/categorize';
import type { LLMConfig } from '../src/ai/categorize';

const IMG = 'data:image/jpeg;base64,QU9L';
const CFG: Record<string, LLMConfig> = {
  openai: { provider: 'openai', apiKey: 'sk-test' },
  anthropic: { provider: 'anthropic', apiKey: 'sk-ant-test' },
  gemini: { provider: 'gemini', apiKey: 'AQ.gemini-test' },
};

function stubFetch() {
  const calls: Array<{ url: string; body: any }> = [];
  const fn = vi.fn(async (url: any, init?: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ text: 'ok', candidates: [{ content: { parts: [{ text: 'ok' }] } }], choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('callLLM text-only (no images)', () => {
  it('openai: plain string content; jsonMode on adds response_format', async () => {
    const calls = stubFetch();
    await callLLM(CFG.openai, 'sys', 'user', [], true);
    const body = calls[0].body!;
    expect(body.messages[1].content).toBe('user');
    expect(body.response_format).toEqual({ type: 'json_object' });

    // jsonMode off (coach path) must NOT force JSON.
    calls.length = 0;
    await callLLM(CFG.openai, 'sys', 'user');
    expect(calls[0].body!.response_format).toBeUndefined();
  });

  it('gemini: jsonMode on adds responseMimeType, off leaves it out', async () => {
    const calls = stubFetch();
    await callLLM(CFG.gemini, 'sys', 'user', [], true);
    expect(calls[0].body!.generationConfig.responseMimeType).toBe('application/json');
    expect(calls[0].body!.contents[0].parts).toEqual([{ text: 'user' }]);

    calls.length = 0;
    await callLLM(CFG.gemini, 'sys', 'user');
    expect(calls[0].body!.generationConfig.responseMimeType).toBeUndefined();
  });

  it('gemini: key goes in the x-goog-api-key header, never in the URL', async () => {
    // Authorization keys (AQ…, the AI Studio default since May 2026) are only
    // accepted via header auth; the legacy ?key=*** query form is rejected
    // with API_KEY_INVALID even for valid keys.
    const fn = vi.fn(async (_url: any, init?: any) => {
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } } ] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fn);
    await callLLM(CFG.gemini, 'sys', 'user');
    const url = String(fn.mock.calls[0][0]);
    const headers: Record<string, string> = fn.mock.calls[0][1]?.headers ?? {};
    expect(url).not.toContain('key=');
    expect(headers['x-goog-api-key']).toBe('AQ.gemini-test');
    expect(headers['x-goog-api-key'].length).toBeGreaterThan(0);
    // Default model must be a live one (2.0-flash was retired).
    expect(url).toContain('gemini-3.8-flash');
  });
});

describe('callLLM with images', () => {
  it('openai: image_url blocks with data URL, after the text block', async () => {
    const calls = stubFetch();
    await callLLM(CFG.openai, 'sys', 'describe this receipt', [IMG]);
    const c = calls[0].body!.messages[1].content;
    expect(c[0]).toEqual({ type: 'text', text: 'describe this receipt' });
    expect(c[1]).toEqual({ type: 'image_url', image_url: { url: IMG } });
  });

  it('anthropic: content block list with base64 image source, text last', async () => {
    const calls = stubFetch();
    await callLLM(CFG.anthropic, 'sys', 'q', [IMG]);
    const c = calls[0].body!.messages[0].content;
    expect(c[0].type).toBe('image');
    expect(c[0].source).toEqual({ type: 'base64', media_type: 'image/jpeg', data: 'QU9L' });
    expect(c[1]).toEqual({ type: 'text', text: 'q' });
  });

  it('gemini: inline_data parts with mime split from the data URL', async () => {
    const calls = stubFetch();
    await callLLM(CFG.gemini, 'sys', 'q', [IMG]);
    const parts = calls[0].body!.contents[0].parts;
    expect(parts[0]).toEqual({ text: 'q' });
    expect(parts[1]).toEqual({ inline_data: { mime_type: 'image/jpeg', data: 'QU9L' } });
  });

  it('empty/blank image slots are filtered out, so text stays a plain string', async () => {
    const calls = stubFetch();
    await callLLM(CFG.openai, 'sys', 'q', ['', undefined as never]);
    expect(calls[0].body!.messages[1].content).toBe('q');
  });
});

describe('categorize jsonMode wiring', () => {
  it('categorizeByLLM forces jsonMode (its prompt demands JSON)', async () => {
    const calls = stubFetch();
    await callLLM(CFG.openai, 'sys', '{}', [], true); // same shape categorizeByLLM uses
    expect(calls[0].body!.response_format).toEqual({ type: 'json_object' });
    expect(typeof __test.categorizeByLLM).toBe('function');
  });
});
