// ============================================================================
// OmniFlow — AI categorization engine (hybrid tier, port of the iOS AIManager).
//
//   Tier 1: Dictionary / regex — always available, $0, offline.
//   Tier 2: BYOK LLM (OpenAI, Anthropic, or Gemini) — only called if the
//           user stored a key in the vault. The request is a small,
//           well-scoped prompt; the key never leaves the browser.
//
// The LLM returns { category, merchant?, confidence }; on any failure we
// fall back to the dictionary result and tag the tier so the UI can show
// which engine produced the category.
// ============================================================================

import type { AITier, Category, LLMProvider } from '../domain/types';

export interface CategorizeInput {
  merchant: string;
  description?: string;
  amount?: number;
  currency?: string;
}

export interface CategorizeResult {
  category: string;
  merchant: string;
  confidence: number; // 0..1
  tier: AITier;
  matchedOn?: string;
}

// ---------------------------------------------------------------------------
// Dictionary / regex tier
// ---------------------------------------------------------------------------

interface Rule {
  test: RegExp;
  category: string;
}

const RULES: Rule[] = [
  { test: /\b(7-?eleven|subway|kfc|mcdonald|burger|pizza|starbucks|luckin|coffee|cafe|restaurant|foodpanda|grabfood|gofood|deliveroo|domino|halal|laksa|bakkt|nyonya|char kuey|papadom|nasi|roti|kopi|teh)\b/i, category: 'Food & Dining' },
  { test: /\b(groceries|lotus|carrefour|aesop|jmart|giant|mydin|shopee mart|grabmart|99|cemega|krisflyer|grocery|fresh|supermarket)\b/i, category: 'Groceries' },
  { test: /\b(grab|gojek|taxi|uber|transit|mrt|lrt|monorail|rapid|flyer|flyt|bus|bike|tokoc|petronas|shell|caltex|fuel|petrol|oil|highway|toll)\b/i, category: 'Transport' },
  { test: /\b(rent|deposit|property|management|strata|condo|condominium|landlord|slam|tln|tenaga|air|water|electric|samsung|telekom|celcom|maxis|digi|tm|unifi|yes|wifi|broadband|internet|bill|utility)\b/i, category: 'Utilities' },
  { test: /\b(school|university|tutor|course|class| tuition|coursera|edward|learn|education|book|textbook)\b/i, category: 'Education' },
  { test: /\b(clinic|hospital|pharm|chemist|guardian|watson|eye|dental|gym|fitness|wellness|supplement|vitamin)\b/i, category: 'Health & Beauty' },
  { test: /\b(netflix|spotify|disney|hulu|crunchyroll|steam|playstation|nintendo|iqiyi|tiktok|youtube|google|apple|subscri|premium|membership|pro)\b/i, category: 'Entertainment' },
  { test: /\b(amazon|shein|aliexpress|lazada|shopee|taobao|ikea|uniqlo|gucci|zara|ikea|home|furniture|apple store|samsung store|electronics|philel|fashion)\b/i, category: 'Shopping' },
  { test: /\b(airasia|scoot|tiger|malindo|traveloka|klook|hotel|resort|booking|agoda|flight|ticket|visa|immigration|trav)\b/i, category: 'Travel' },
  { test: /\b(bank|transfer|savings|fund|portfolio|broker|trade|invest|dividend|reinvest|purchase|etf|shares|crypto|coin|bit|swap)\b/i, category: 'Investments' },
  { test: /\b(salary|payroll|bonus|commission|freelance|gig|income|refund|cashback)\b/i, category: 'Income' },
];

export function categorizeByDictionary(
  input: CategorizeInput,
  categories: Category[],
): CategorizeResult {
  const haystack = `${input.merchant} ${input.description ?? ''}`.toLowerCase();
  for (const rule of RULES) {
    if (rule.test.test(haystack)) {
      const cat = categories.find((c) => c.name.toLowerCase() === rule.category.toLowerCase());
      return {
        category: cat?.name ?? 'Other',
        merchant: input.merchant,
        confidence: 0.7,
        tier: 'dictionary',
        matchedOn: rule.test.source.slice(0, 60),
      };
    }
  }
  // No rule matched — return "Other".
  const other = categories.find((c) => c.name === 'Other') ?? categories[categories.length - 1];
  return {
    category: other?.name ?? 'Other',
    merchant: input.merchant,
    confidence: 0.2,
    tier: 'dictionary',
  };
}

// ---------------------------------------------------------------------------
// BYOK LLM tier
// ---------------------------------------------------------------------------

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  model?: string;
}

export async function categorizeByLLM(
  input: CategorizeInput,
  categories: Category[],
  cfg: LLMConfig,
): Promise<CategorizeResult> {
  const catNames = categories.map((c) => c.name);
  const sys = `You are a personal finance categorisation engine. Given a merchant name and optional description, pick exactly one category from this list: [${catNames.join(', ')}]. If none fit, use "Other". Reply with ONLY a JSON object: {"category":string,"merchant":string,"confidence":number(0-1),"reason":string(<=20 words)}. No other text.`;

  const user = JSON.stringify({
    merchant: input.merchant,
    description: input.description ?? '',
    amount: input.amount ?? null,
    currency: input.currency ?? null,
  });

  const raw = await callLLM(cfg, sys, user, [], true);
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The LLM returned prose; best-effort regex extraction.
    const m = raw.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : { category: 'Other', confidence: 0.1 };
  }
  const valid = catNames.includes(parsed.category) ? parsed.category : 'Other';
  return {
    category: valid,
    merchant: parsed.merchant || input.merchant,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    tier: 'llm-byok',
    matchedOn: parsed.reason,
  };
}

// ---------------------------------------------------------------------------
// LLM transport — one branch per provider.
// ---------------------------------------------------------------------------

// Pull a human-readable reason out of a provider's error body so the UI can
// show *why* a call failed (invalid key, quota, blocked content, ...). The
// key itself is never echoed; only the provider's message field.

// CORS-open relay in front of the adaCode gateway. The gateway sends CORS
// headers on the OPTIONS preflight but NOT on actual responses (verified: a
// 200 success carries zero access-control-allow-origin headers), so
// browsers cannot read ANY response from it — Safari surfaces the failure
// as an opaque "Load failed" and the provider's real error message never
// reaches the UI. The relay is a stateless Supabase Edge Function that
// forwards the request server-side and echoes CORS headers on every
// response, success and error. It stores no secrets: the user's key only
// transits it per-request. Override with VITE_ADACODE_RELAY_URL if you
// deploy your own relay (e.g. on your own Supabase project).
const ADACODE_RELAY_URL: string =
  (import.meta.env.VITE_ADACODE_RELAY_URL as string | undefined) ??
  'https://ijwpyikcbqdskuynwsuz.functions.supabase.co/adacode-relay';

async function apiErrorBody(res: Response): Promise<string> {
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t);
      const m = j?.error?.message ?? j?.message;
      if (typeof m === 'string' && m) return m;
    } catch {
      /* not JSON — fall through to raw (truncated) text */
    }
    return t.slice(0, 160);
  } catch {
    return 'no response body';
  }
}

export async function callLLM(
  cfg: LLMConfig,
  sys: string,
  user: string,
  images: string[] = [],
  jsonMode = false,
): Promise<string> {
  const imgs = images.filter(Boolean);
  if (cfg.provider === 'anthropic') {
    const model = cfg.model ?? 'claude-3-5-sonnet-latest';
    // With images the user content becomes a block list: text + image.
    const content: unknown = imgs.length === 0
      ? user
      : [
          ...imgs.map((d) => {
            const m = d.match(/^data:([^;]+);base64,(.*)$/);
            return {
              type: 'image',
              source: { type: 'base64', media_type: m?.[1] ?? 'image/jpeg', data: m?.[2] ?? d },
            };
          }),
          { type: 'text', text: user },
        ];
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: 256,
        system: sys,
        messages: [{ role: 'user', content }],
      }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${await apiErrorBody(res)}`);
    const j = await res.json();
    return j?.content?.[0]?.text ?? '';
  }

  if (cfg.provider === 'gemini') {
    // Gemini (AI Studio) — $0 free tier. Since May 2026 AI Studio issues
    // "authorization keys" (AQ…) by default; those are ONLY accepted via
    // header auth (x-goog-api-key) — the legacy ?key=*** query form is
    // rejected with API_KEY_INVALID even for perfectly valid keys. Legacy
    // AIza… keys work either way, so we always send the header. The
    // preflight from a static origin explicitly allows this header.
    // Default model tracks the current API recommendation; override via
    // prefs.llmModel if a different model is wanted.
    const model = cfg.model ?? 'gemini-3.8-flash';
    const url =
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) + ':generateContent';
    const parts: Record<string, unknown>[] = [{ text: user }];
    for (const d of imgs) {
      const m = d.match(/^data:([^;]+);base64,(.*)$/);
      parts.push({ inline_data: { mime_type: m?.[1] ?? 'image/jpeg', data: m?.[2] ?? d } });
    }
    const body = JSON.stringify({
      contents: [{ role: 'user', parts }],
      systemInstruction: { parts: [{ text: sys }] },
      generationConfig: {
        temperature: 0,
        ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
      },
    });
    // The free tier sheds load with 503 "high demand" and 429 rate limits;
    // both are transient, so retry with backoff before declaring failure.
    // Bounded so a permanently-unavailable model still fails fast-ish.
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
        body,
      });
      if (res.ok || !(res.status === 503 || res.status === 429) || attempt >= 2) break;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
    if (!res.ok) throw new Error(`gemini ${res.status}: ${await apiErrorBody(res)}`);
    const j = await res.json();
    // A blocked/failed generation returns no candidates — surface the reason.
    const parts2 = j?.candidates?.[0]?.content?.parts;
    if (!parts2?.length && j?.candidates?.length) {
      const reason = j.candidates[0]?.finishReason ? ` (finishReason: ${j.candidates[0].finishReason})` : '';
      throw new Error(`gemini empty response${reason}`);
    }
    if (!parts2?.length) throw new Error(`gemini empty response: ${JSON.stringify(j).slice(0, 160)}`);
    return parts2[0].text ?? '';
  }

  if (cfg.provider === 'adacode') {
    // adaCode — OpenAI-compatible gateway (Bearer key, /v1/chat/completions,
    // OpenAI-shaped request/response incl. response_format json_mode and
    // image_url blocks). The gateway sends CORS headers on the OPTIONS
    // preflight only — actual responses (200 success AND 401/403 errors)
    // carry NO access-control-allow-origin header, so browsers cannot read
    // any response from it (Safari: opaque "Load failed"). All browser
    // traffic therefore goes through the CORS-open relay (ADACODE_RELAY_URL),
    // a stateless Supabase Edge Function that forwards server-side and
    // echoes CORS on every response. The user's key still transits the relay
    // per-request (HTTPS only); it is stored nowhere.
    // Default model is adacode-3.0-flash; override via prefs.llmModel
    // (claude-*, gpt-*, gemini-*, deepseek-*, glm-*, qwen-*, adacode-*-flash…).
    const model = cfg.model ?? 'adacode-3.0-flash';
    const content: unknown = imgs.length === 0
      ? user
      : [
          { type: 'text', text: user },
          ...imgs.map((d) => ({ type: 'image_url', image_url: { url: d } })),
        ];
    let res: Response;
    try {
      res = await fetch(ADACODE_RELAY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content },
          ],
        }),
      });
    } catch (e) {
      // With the relay, provider errors are readable (ACAO: * on every
      // response), so a fetch rejection here means the relay itself was
      // unreachable (network down, DNS, relay project disabled) — not a
      // hidden provider 401/403. Surface the relay URL so the user can
      // diagnose it.
      const raw = e instanceof Error ? e.message : String(e);
      throw new Error(
        `adacode: relay unreachable ("${raw}") — the CORS-open relay at ` +
          `${ADACODE_RELAY_URL} could not be reached. If you deploy your own ` +
          `relay, set VITE_ADACODE_RELAY_URL and rebuild. Provider errors ` +
          `(invalid key, unavailable model) now surface as normal adacode ` +
          `responses, so any remaining failure is transport-side.`,
      );
    }
    if (!res.ok) throw new Error(`adacode ${res.status}: ${await apiErrorBody(res)}`);
    const j = await res.json();
    return j?.choices?.[0]?.message?.content ?? '';
  }

  // Default: OpenAI.
  const model = cfg.model ?? 'gpt-4o-mini';
  const content: unknown = imgs.length === 0
    ? user
    : [
        { type: 'text', text: user },
        ...imgs.map((d) => ({ type: 'image_url', image_url: { url: d } })),
      ];
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content },
      ],
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${await apiErrorBody(res)}`);
  const j = await res.json();
  return j?.choices?.[0]?.message?.content ?? '';
}

// ---------------------------------------------------------------------------
// Unified entry point
// ---------------------------------------------------------------------------

export async function categorize(
  input: CategorizeInput,
  categories: Category[],
  llm?: LLMConfig,
): Promise<CategorizeResult> {
  // Tier 1 is always computed; it's the guaranteed fallback.
  const dictResult = categorizeByDictionary(input, categories);
  if (llm && llm.apiKey) {
    try {
      return await categorizeByLLM(input, categories, llm);
    } catch {
      // fall through to dictionary
    }
  }
  return dictResult;
}

// ---------------------------------------------------------------------------
// Key health check — a minimal one-token call so Settings can confirm a key
// actually works before the user relies on it. Returns { ok, detail } where
// detail carries the provider's own error message on failure (key problems,
// quota, model not found). The key never leaves this function's scope.
// ---------------------------------------------------------------------------

export async function testLLMKey(
  cfg: LLMConfig,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const out = await callLLM(cfg, 'Reply with exactly: OK', 'ping', []);
    if (out.trim()) return { ok: true, detail: 'Connected' };
    return { ok: false, detail: 'Empty response from the model' };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export const __test = { RULES, categorizeByDictionary, categorizeByLLM, callLLM, testLLMKey };
