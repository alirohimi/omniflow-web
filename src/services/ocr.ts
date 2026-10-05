// ============================================================================
// OmniFlow — OCRService (receipt / QR screenshot text extraction).
//
// Tesseract.js runs fully client-side (no backend, no key, $0). It is
// lazily imported on first use so the ~3MB wasm + language-data download
// doesn't slow the initial app load.
//
// The raw OCR text is passed to the AI engine (dictionary, or BYOK LLM if
// configured) to extract { amount, currency, merchant }. This mirrors the
// iOS ParseTransactionScreenshotIntent pipeline (Vision -> AIManager).
// ============================================================================

import type { ExpenseSource } from '../domain/types';

export interface ParsedReceipt {
  amount: number | null;
  currency: string;
  merchant: string;
  rawText: string;
  confidence: number; // 0..1 rough OCR confidence
  source: ExpenseSource; // always 'ocr'
}

/** Regex heuristics used as a pre-pass / fallback when no LLM is available
 *  and to sanity-check LLM output. Works on most "Paid RM12.40" / "S$8.40"
 *  / "USD 12.99" style confirmation lines. */
export function extractFromOcrText(text: string, fallbackCurrency = 'MYR'): ParsedReceipt {
  const clean = text.replace(/\n{2,}/g, '\n');

  // Currency: ISO code or common symbol -> ISO mapping.
  const symbolMap: Record<string, string> = {
    'RM': 'MYR', 'S$': 'SGD', '$': 'USD', '€': 'EUR', '£': 'GBP',
    '¥': 'JPY', 'A$': 'AUD', 'C$': 'CAD', 'HK$': 'HKD', '฿': 'THB',
    '₱': 'PHP', '₫': 'VND', '₹': 'INR', 'Rp': 'IDR', '₩': 'KRW',
  };
  let currency = fallbackCurrency;
  const iso = clean.match(/\b([A-Z]{3})\b/);
  const known = ['MYR', 'SGD', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'HKD', 'CNY', 'IDR', 'THB', 'PHP', 'VND', 'INR', 'KRW', 'CHF'];
  if (iso && known.includes(iso[1])) currency = iso[1];
  else {
    for (const [sym, code] of Object.entries(symbolMap)) {
      if (clean.includes(sym)) { currency = code; break; }
    }
  }

  // Amount: last number that looks like a payment total. Prefer "paid",
  // "total", "amt", "amount" proximity; else the final numeric token.
  let amount: number | null = null;
  const paid = clean.match(/(?:paid|total|amount|amt|debit|charged)[^\d-]{0,16}(-?\d[0-9,]*\.?\d{0,2})/i);
  if (paid) amount = parseNum(paid[1]);
  if (amount === null) {
    const nums = clean.match(/-?\d[0-9,]*\.?\d{1,2}/g);
    if (nums && nums.length) amount = parseNum(nums[nums.length - 1]);
  }

  // Merchant: a line that is mostly letters, short, not containing "paid/total".
  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
  const merchant =
    lines.find((l) => /^[A-Z0-9&.,'() -]{2,40}$/.test(l) && !/\b(paid|total|amount|receipt)\b/i.test(l)) ??
    'Unknown merchant';

  const totalDigits = (clean.match(/\d/g) || []).length;
  const confidence = clean.length === 0 ? 0 : Math.min(1, totalDigits / 12);

  return { amount, currency, merchant, rawText: clean, confidence, source: 'ocr' };
}

function parseNum(s: string): number | null {
  const n = parseFloat(s.replace(/,/g, ''));
  return isFinite(n) ? n : null;
}

/** Run Tesseract on an image File/Blob. Returns raw text. */
export async function ocrImage(
  image: Blob,
  onProgress?: (pct: number) => void,
): Promise<string> {
  const T = (await import('tesseract.js')) as any;
  const result = await T.recognize(image, 'eng', {
    logger: (m: any) => {
      if (m.status === 'recognizing text' && onProgress) onProgress(m.progress);
    },
  });
  return (result?.data?.text ?? '').trim();
}

/** End-to-end: image -> OCR text -> structured receipt fields. */
export async function parseReceipt(
  image: Blob,
  fallbackCurrency: string,
  onProgress?: (pct: number) => void,
): Promise<ParsedReceipt> {
  const text = await ocrImage(image, onProgress);
  return extractFromOcrText(text, fallbackCurrency);
}
