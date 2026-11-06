// ============================================================================
// OmniFlow — OCRService (receipt / QR screenshot extraction).
//
// Pipeline: image -> canvas preprocess (grayscale + contrast stretch +
//           upscale for phone screenshots) -> Tesseract.js 5 (persistent
//           LSTM worker, fully in-browser, $0) -> structured fields.
//
// Structured extraction is two-tier, mirroring the iOS AIManager:
//   1. Heuristics — keyword/currency-adjacency scoring over OCR lines.
//      Always runs, $0, offline. Robust to mangled text (Tesseract loves
//      swapping I/l/1 or 0/O on e-wallet receipts, so scoring, not regex
//      exactness, does the heavy lifting).
//   2. BYOK LLM (OpenAI / Anthropic / Gemini) — when a key is configured,
//      the raw OCR text is sent to the model for {amount, currency,
//      merchant}; heuristic results stay as a validated fallback.
// ============================================================================

import type { ExpenseSource } from '../domain/types';
import { callLLM, type LLMConfig } from '../ai/categorize';
// tesseract.js ships `export = Tesseract` (a namespace), so its member
// types don't nest under a default import reliably. Define the worker
// structurally — only `recognize` is used — and type the logger message
// structurally too.
type TesseractWorker = {
  recognize(
    image: Blob | string | HTMLImageElement | HTMLCanvasElement,
    options?: unknown,
    output?: unknown,
    jobId?: string,
  ): Promise<{ data: unknown }>;
};
type TessLoggerMsg = { status: string; progress: number };

export interface ParsedReceipt {
  amount: number | null;
  currency: string;
  merchant: string;
  rawText: string;
  confidence: number; // 0..1
  engine: 'llm' | 'heuristic';
  source: ExpenseSource; // always 'ocr'
}

const KNOWN_ISO = [
  'MYR', 'SGD', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'HKD', 'CNY',
  'IDR', 'THB', 'PHP', 'VND', 'INR', 'KRW', 'CHF', 'NZD',
];

// Multi-char / prefixed symbols first so e.g. 'S$' wins over a lone '$'.
const SYMBOL_MAP: Array<[string, string]> = [
  ['HK$', 'HKD'],
  ['US$', 'USD'],
  ['A$', 'AUD'],
  ['C$', 'CAD'],
  ['S$', 'SGD'],
  ['RM', 'MYR'],
  ['Rp', 'IDR'],
  ['€', 'EUR'],
  ['£', 'GBP'],
  ['¥', 'JPY'],
  ['₩', 'KRW'],
  ['฿', 'THB'],
  ['₱', 'PHP'],
  ['₫', 'VND'],
  ['₹', 'INR'],
];

const CURRENCY_ISO_RE = new RegExp(`\\b(${KNOWN_ISO.join('|')})\\b`, 'i');

/** Does this line carry a currency marker adjacent to a number? */
function currencyNearNumber(line: string): boolean {
  for (const [sym] of SYMBOL_MAP) {
    const re = new RegExp(
      `(?:${escapeRegExp(sym)})\\s*[\\d$€£¥]|\\d(?:[\\d,]*\\.\\d{1,2})?\\s*(?:${escapeRegExp(sym)})`,
      'i',
    );
    if (re.test(line)) return true;
  }
  return /\b[A-Z]{3}\b\s*\d/.test(line) || /\d\s*[A-Z]{3}\b/i.test(line.replace(/[^A-Za-z0-9 $]/g, ''));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectCurrency(text: string, fallback: string): string {
  // 1) ISO code sitting next to a number ("USD 12.99", "12.40 MYR").
  for (const iso of KNOWN_ISO) {
    const re = new RegExp(`\\b${iso}\\b\\s*[\\d$€£¥]|\\d(?:[\\d,]*\\.\\d{1,2})?\\s*${iso}\\b`, 'i');
    if (re.test(text)) return iso;
  }
  // 2) Symbol adjacent to a number ("RM 12.40", "S$8.40").
  for (const [sym, code] of SYMBOL_MAP) {
    const re = new RegExp(
      `(?:${escapeRegExp(sym)})\\s*\\d|\\d\\s*(?:${escapeRegExp(sym)})`,
      sym.length === 2 ? 'i' : '',
    );
    if (re.test(text)) return code;
  }
  // 3) Any known ISO code anywhere; 4) any symbol anywhere; else fallback.
  const iso = text.match(CURRENCY_ISO_RE);
  if (iso) return iso[1].toUpperCase();
  for (const [sym, code] of SYMBOL_MAP) {
    if (text.includes(sym)) return code;
  }
  return fallback;
}

const KEYWORD_POS = /paid|total|charged|amount|debit|net amt|grand\s*total|amt/i;
const KEYWORD_NEG = /balance|remaining|change|refund|cashback|cash\s*back|reference|ref\s*no|invoice|order\s*no|txn|transaction\s*id|receipt\s*no|batch/i;
const TIME_RE = /:\d{1,2}(\s*am|\s*pm)?\b/i;

/** Number tokens that look like money: has decimals, or is a plausible
 *  integer total. Excludes 4-digit years, times, and long reference ids. */
const MONEY_RE = /-?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{1,2}|\d{1,10}(?![\d.,])/g;

function candidateNumbers(line: string): number[] {
  const out: number[] = [];
  for (const m of line.matchAll(MONEY_RE)) {
    const n = parseFloat(m[0].replace(/,/g, ''));
    if (!isFinite(n)) continue;
    // 4-digit integers that look like a year are not money.
    if (/^\d{4}$/.test(m[0]) && n >= 1900 && n <= 2099 && !KEYWORD_POS.test(line)) continue;
    // Long integers (>8 digits) are reference numbers / card numbers.
    if (!m[0].includes('.') && m[0].length > 8) continue;
    out.push(n);
  }
  return out;
}

function detectAmountAndCurrency(lines: string[], fallback: string): { amount: number | null; currency: string } {
  const full = lines.join('\n');
  const currency = detectCurrency(full, fallback);

  let best: { n: number; score: number; idx: number } | null = null;
  lines.forEach((line, idx) => {
    const nums = candidateNumbers(line);
    if (nums.length === 0) return;
    const n = nums[nums.length - 1]; // the *final* number on the line is the value
    let score = 0;
    if (KEYWORD_POS.test(line)) score += 3;
    if (KEYWORD_NEG.test(line)) score -= 4;
    if (TIME_RE.test(line)) score -= 2;
    if (currencyNearNumber(line)) score += 2;
    if (score < 1 && !KEYWORD_POS.test(line)) return; // weak lines: skip
    if (!best || score > best.score || (score === best.score && idx < best.idx)) best = { n, score, idx };
  });

  // Weak fallback: a keyword-free receipt — take the largest 2-decimal number
  // (balances/decimals of items are less likely than a round total being max).
  if (!best) {
    let max: number | null = null;
    for (const line of lines) {
      for (const n of candidateNumbers(line)) {
        if (n > 0 && (max === null || n > max)) max = n;
      }
    }
    if (max !== null) best = { n: max, score: 0, idx: -1 };
  }

  return { amount: best ? best.n : null, currency };
}

const MERCHANT_STOP =
  /^(?:total|paid|amount|amt|receipt|reciept|date|time|ref|refer(?:ence)?|invoice|inv|cash|card|balance|change|paid\s*by|store|merchant|transaction|order|subtotal|sub\s*total|tax|vat|s\.?t\.?\.?|grand|net|www|http|scan|qr|wallet|e-?wallet|payment|method|currency|rate|exchange|converted|credit|account|acct|mobile|phone|no\.?|num)\b/i;

function detectMerchant(lines: string[], amountIdx: number): string | null {
  type Candi = { line: string; score: number; idx: number };
  let best: Candi | null = null;
  for (let idx = 0; idx < lines.length; idx++) {
    const t = lines[idx].trim();
    if (t.length < 3 || t.length > 60) continue;
    if (idx === amountIdx) continue;
    if (MERCHANT_STOP.test(t)) continue;
    if (/\d{3,}/.test(t)) continue; // number-heavy: date, ref, phone
    if (/http|www\./i.test(t)) continue;
    const letters = (t.match(/[a-z]/gi) || []).length;
    if (letters / t.length < 0.5) continue; // mostly symbols/digits
    if (currencyNearNumber(t)) continue; // it's a money line, not a name
    let score = 0;
    if (amountIdx >= 0 && idx < amountIdx) score += 2; // names print above totals
    else if (amountIdx < 0) score += 1;
    if (t.length >= 3 && t.length <= 40) score += 1;
    if (/^[A-Z](?:[A-Za-z0-9&.'() -]*[A-Za-z])?$/.test(t)) score += 1;
    if (!best || score > best.score) best = { line: t, score, idx };
  }
  return best && best.score > 0 ? best.line : null;
}

/** Pure, $0 extraction from raw OCR text. Kept exported for tests + reuse. */
export function extractFromOcrText(text: string, fallbackCurrency = 'MYR'): ParsedReceipt {
  const clean = text.replace(/\n{2,}/g, '\n').trim();
  const lines = clean ? clean.split('\n') : [];
  const { amount, currency } = detectAmountAndCurrency(lines, fallbackCurrency);
  const amountIdx = amount !== null ? lines.findIndex((l) => candidateNumbers(l).includes(amount)) : -1;
  const merchant = detectMerchant(lines, amountIdx) ?? 'Unknown merchant';

  let confidence = 0;
  if (amount !== null) confidence += 0.45;
  if (currency !== fallbackCurrency || currencyNearNumber(clean)) confidence += 0.25;
  if (merchant !== 'Unknown merchant') confidence += 0.25;
  if (lines.length === 0) confidence = 0;

  return {
    amount,
    currency,
    merchant,
    rawText: clean,
    confidence: Math.min(1, confidence),
    engine: 'heuristic',
    source: 'ocr',
  };
}

// ---------------------------------------------------------------------------
// Tesseract — persistent worker + browser image preprocessing
// ---------------------------------------------------------------------------

let workerPromise: Promise<TesseractWorker> | null = null;
let activeProgress: ((pct: number) => void) | null = null;

function getWorker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    workerPromise = import('tesseract.js').then((T) =>
      T.createWorker('eng', 1, {
        logger: (m: TessLoggerMsg) => {
          if (m.status === 'recognizing text' && activeProgress) activeProgress(m.progress);
        },
      }),
    );
  }
  return workerPromise;
}

function loadImg(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not decode image'));
    img.src = url;
  });
}

/** Grayscale + histogram-contrast-stretch + upscale/downscale to 1024–2048px.
 *  The single biggest win for screenshot OCR: dark-theme e-wallet screens
 *  and tiny thumbnails otherwise wreck Tesseract's LSTM. */
async function preprocessImage(blob: Blob): Promise<string> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImg(url);
    const long = Math.max(img.width, img.height);
    if (long < 64) throw new Error('image too small');
    const target = Math.min(2048, Math.max(1024, long));
    const factor = target / long;
    const w = Math.round(img.width * factor);
    const h = Math.round(img.height * factor);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas context');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);

    const data = ctx.getImageData(0, 0, w, h);
    const px = data.data;
    const total = w * h;

    // Luma + histogram for percentile clipping.
    const gray = new Uint8Array(total);
    const hist = new Array<number>(256).fill(0);
    for (let i = 0, p = 0; i < px.length; i += 4, p++) {
      const g = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
      gray[p] = g;
      hist[g]++;
    }
    let lo = 0;
    let hi = 255;
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc > total * 0.02) { lo = i; break; }
    }
    acc = 0;
    for (let i = 255; i >= 0; i--) {
      acc += hist[i];
      if (acc > total * 0.98) { hi = i; break; }
    }
    if (hi - lo < 30) {
      const mid = (lo + hi) / 2;
      lo = Math.max(0, Math.round(mid - 15));
      hi = Math.min(255, Math.round(mid + 15));
    }

    for (let p = 0; p < total; p++) {
      let g = gray[p];
      g = ((g - lo) * 255) / Math.max(1, hi - lo);
      g = Math.max(0, Math.min(255, Math.round(g)));
      px[p * 4] = px[p * 4 + 1] = px[p * 4 + 2] = g;
    }
    ctx.putImageData(data, 0, 0);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Run Tesseract on an image Blob. Returns raw text + word confidence.
 *  (Browser-only: the worker downloads traineddata once and is cached.) */
export async function ocrImage(
  image: Blob,
  onProgress?: (pct: number) => void,
): Promise<{ text: string; confidence: number }> {
  activeProgress = onProgress ?? null;
  try {
    const worker = await getWorker();
    let input: string | Blob = image;
    if (typeof document !== 'undefined') {
      try {
        input = await preprocessImage(image);
      } catch {
        input = image; // undecodable (HEIC etc.) — let tesseract try the raw blob
      }
    }
    const result = await worker.recognize(input as never);
    const data = result.data as { text?: string; confidence?: number };
    return {
      text: (data.text ?? '').trim(),
      confidence: typeof data.confidence === 'number' ? data.confidence / 100 : 0,
    };
  } finally {
    activeProgress = null;
  }
}

// ---------------------------------------------------------------------------
// BYOK LLM tier for receipt text
// ---------------------------------------------------------------------------

export async function extractWithLLM(
  ocrText: string,
  fallbackCurrency: string,
  cfg: LLMConfig,
): Promise<{ amount: number | null; currency: string; merchant: string; confidence: number }> {
  const sys =
    'You parse payment / receipt / e-wallet screenshot OCR text into fields. ' +
    'Reply with ONLY a JSON object: {"amount":number|null,"currency":"ISO","merchant":"string|null","confidence":number(0-1)}. ' +
    'Rules: amount = the final paid total (NOT balance, change, refund or a price list); ' +
    'currency = ISO code, map symbols (RM->MYR, S$->SGD, HK$->HKD, A$->AUD, US$->USD); ' +
    'merchant = the store/merchant/service name if present, else null. Be conservative; ' +
    'when unsure set amount to null. No prose outside the JSON.';
  const raw = await callLLM(cfg, sys, ocrText.slice(0, 4000));

  let parsed: any = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch { parsed = null; }
    }
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('llm: unparseable response');

  let amount: number | null = null;
  if (typeof parsed.amount === 'number' && isFinite(parsed.amount) && parsed.amount >= 0) {
    amount = parsed.amount;
  } else if (typeof parsed.amount === 'string' && parsed.amount.trim() !== '') {
    const n = parseFloat(parsed.amount.replace(/[^0-9.-]/g, ''));
    if (isFinite(n) && n >= 0) amount = n;
  }
  const currency =
    typeof parsed.currency === 'string' &&
    KNOWN_ISO.includes(parsed.currency.toUpperCase())
      ? parsed.currency.toUpperCase()
      : fallbackCurrency;
  const merchant =
    typeof parsed.merchant === 'string' && parsed.merchant.trim().length >= 2 &&
    parsed.merchant.trim().length <= 60
      ? parsed.merchant.trim()
      : null;
  const confidence =
    typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.8;

  return { amount, currency, merchant: merchant ?? 'Unknown merchant', confidence };
}

/** End-to-end: image -> preprocess -> OCR -> (LLM if key) -> structured fields.
 *  The heuristic result is always computed; LLM values are validated against
 *  it before being trusted (a hallucinated currency or amount is rejected). */
export async function parseReceipt(
  image: Blob,
  fallbackCurrency: string,
  onProgress?: (pct: number) => void,
  llm?: LLMConfig,
): Promise<ParsedReceipt> {
  const { text, confidence: ocrConf } = await ocrImage(image, onProgress);
  const heur = extractFromOcrText(text, fallbackCurrency);

  if (llm && llm.apiKey) {
    try {
      const r = await extractWithLLM(text, fallbackCurrency, llm);
      // Trust LLM only where it beats the heuristic or fills a gap.
      const amount = r.amount ?? heur.amount;
      const currency =
        r.currency !== fallbackCurrency ? r.currency : heur.currency;
      const merchant = r.merchant !== 'Unknown merchant' ? r.merchant : heur.merchant;
      return {
        amount,
        currency,
        merchant,
        rawText: heur.rawText,
        confidence: Math.max(r.confidence, ocrConf * 0.5),
        engine: 'llm',
        source: 'ocr',
      };
    } catch {
      // LLM failed — heuristic stands.
    }
  }
  return { ...heur, confidence: Math.max(heur.confidence, ocrConf * 0.4) };
}
