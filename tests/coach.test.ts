// ============================================================================
// OmniFlow — coach engine tests (no network, no DOM).
// Proves the conversational advisor is grounded in real data, degrades
// gracefully, and never fabricates numbers.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { buildBrief, coachSystemPrompt, coachFallback, coachAsk } from '../src/ai/coach';
import type { CoachContext } from '../src/ai/coach';
import type { LLMConfig } from '../src/ai/categorize';
import type { CoachMessage } from '../src/domain/types';

const MYR = 'MYR';

function ctx(over: Partial<CoachContext> = {}): CoachContext {
  return {
    expenses: [],
    accounts: [],
    holdings: [],
    quotes: {},
    prefs: { baseCurrency: MYR, displayName: '', llmProvider: 'none', llmKeyFinger: '', autoCategorize: true, advisorRules: false },
    portfolio: null,
    ...over,
  };
}

describe('coach buildBrief', () => {
  it('derives net worth from live quotes when portfolio is absent', () => {
    const c = ctx({
      holdings: [
        {
          symbol: 'BTC',
          assetClass: 'crypto',
          units: 1,
          holdingCurrency: 'USD',
          currentPriceBase: 200000,
        } as never,
        {
          symbol: 'CSPX.L',
          assetClass: 'etf',
          units: 2,
          holdingCurrency: 'USD',
          currentPriceBase: 100,
        } as never,
      ],
    });
    const b = buildBrief(c);
    expect(b.netWorthBase).toBeCloseTo(200200, 2);
    expect(b.cryptoSharePct).toBeCloseTo(99.9, 0);
    expect(b.topHolding?.symbol).toBe('BTC');
  });

  it('computes FX exposure as non-base currency share', () => {
    const c = ctx({
      holdings: [
        { symbol: 'USD', assetClass: 'cash', units: 100, holdingCurrency: 'USD', currentPriceBase: 100 } as never,
        { symbol: 'MYR', assetClass: 'cash', units: 100, holdingCurrency: MYR, currentPriceBase: 100 } as never,
      ],
    });
    const b = buildBrief(c);
    expect(b.fxExposurePct).toBeCloseTo(50, 0);
  });

  it('splits allocation by asset class and lists top category', () => {
    const c = ctx({
      expenses: [
        { category: 'Food', baseAmount: 600, timestamp: Date.now() } as never,
        { category: 'Food', baseAmount: 400, timestamp: Date.now() } as never,
        { category: 'Transport', baseAmount: 250, timestamp: Date.now() } as never,
      ],
    });
    const b = buildBrief(c);
    expect(b.topCategory?.name).toBe('Food');
    expect(b.topCategory?.pct).toBeCloseTo(80, 0);
  });
});

describe('coach persona', () => {
  it('injects the brief and a value-investor voice', () => {
    const c = ctx({
      holdings: [{ symbol: 'AAPL', assetClass: 'equity', units: 1, holdingCurrency: 'USD', currentPriceBase: 1000 } as never],
    });
    const p = coachSystemPrompt(buildBrief(c));
    expect(p).toContain('MYR');
    expect(p).toContain('1000');
    expect(p.toLowerCase()).toMatch(/margin of safety|discipline|time horizon|concentrat/);
  });
});

describe('coach fallback (no key)', () => {
  it('answers allocation intent from rules', () => {
    const c = ctx({
      holdings: [
        { symbol: 'AAPL', assetClass: 'equity', units: 1, holdingCurrency: 'USD', currentPriceBase: 1000 } as never,
        { symbol: 'BTC', assetClass: 'crypto', units: 1, holdingCurrency: 'USD', currentPriceBase: 500 } as never,
      ],
    });
    const a = coachFallback('how is my portfolio allocated', buildBrief(c));
    expect(a.source).toBe('rules');
    expect(a.text).toMatch(/equity|66\.7|33\.3/i);
  });

  it('always returns something grounded, never empty', () => {
    const a = coachFallback('hello', buildBrief(ctx()));
    expect(a.text.length).toBeGreaterThan(10);
    expect(a.source).toBe('system');
  });
});

describe('coach orchestration', () => {
  const llm: LLMConfig = { provider: 'openai', apiKey: 'test-key' };

  it('Tier 1: returns LLM answer when key present', async () => {
    const fake = async () => 'Invest with margin of safety.';
    const a = await coachAsk('should I buy more', ctx(), llm, [], [], fake);
    expect(a.source).toBe('llm');
    expect(a.degraded).toBe(false);
    expect(a.text).toContain('margin of safety');
  });

  it('degrades to rules when LLM transport throws', async () => {
    const fake = async (): Promise<string> => {
      throw new Error('network down');
    };
    const a = await coachAsk(
      'how is my portfolio allocated',
      ctx({ holdings: [{ symbol: 'AAPL', assetClass: 'equity', units: 1, holdingCurrency: 'USD', currentPriceBase: 500 } as never] }),
      llm,
      [],
      [],
      fake,
    );
    expect(a.source).toBe('rules');
    expect(a.degraded).toBe(true);
  });

  it('no key -> pure rules, not degraded', async () => {
    const a = await coachAsk('hello', ctx(), null, [] as CoachMessage[]);
    expect(a.source).toBe('system');
    expect(a.degraded).toBe(false);
  });

  it('images are forwarded to the LLM transport, one entry per attachment', async () => {
    let got: string[] | undefined;
    const fake = async (_c: LLMConfig, _s: string, _u: string, images?: string[]) => {
      got = images;
      return 'ok';
    };
    await coachAsk('what does this receipt show?', ctx(), llm, [], ['data:image/jpeg;base64,AAA'], fake);
    expect(got).toEqual(['data:image/jpeg;base64,AAA']);
  });

  it('rules tier with an image says it cannot read images on-device', async () => {
    const fake = async (): Promise<string> => {
      throw new Error('down');
    };
    const a = await coachAsk(
      'how is my portfolio allocated',
      ctx({ holdings: [{ symbol: 'AAPL', assetClass: 'equity', units: 1, holdingCurrency: 'USD', currentPriceBase: 500 } as never] }),
      llm,
      [],
      ['data:image/png;base64,AAA'],
      fake,
    );
    expect(a.source).toBe('rules');
    expect(a.degraded).toBe(true);
    expect(a.text).toMatch(/can'?t read images/i);
  });

  it('rules tier without images has no image note', () => {
    const fb = coachFallback('hello', buildBrief(ctx()));
    expect(fb.text).not.toMatch(/read images/i);
  });
});
