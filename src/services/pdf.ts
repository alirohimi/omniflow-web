// ============================================================================
// OmniFlow — PDF statement import (100% client-side, $0, offline-capable).
//
// pdf.js turns the .pdf into ordered text on the device (the file never
// leaves the browser), then hands it to the pure statement engine in
// `./statement`, which does LLM-or-regex parsing + auto-categorization.
//
// Split rationale: `statement.ts` has zero pdf.js/DOM dependencies so it is
// unit-testable under Node/vitest. This file owns the pdf.js plumbing only.
// ============================================================================

import * as pdfjs from 'pdfjs-dist';
// Vite bundles the pdf.js worker correctly via the `?worker` import — no
// public/ copy needed, no network fetch at runtime.
import PdfJsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';
import type { LLMConfig } from '../ai/categorize';
import type { Category } from '../domain/types';
import {
  parseStatementText,
  type ParsedStatementLine,
  type ParseStatementResult,
} from './statement';

// Install the worker port once at module load.
pdfjs.GlobalWorkerOptions.workerPort = new PdfJsWorker();

export type { ParsedStatementLine, ParseStatementResult } from './statement';

// ---------------------------------------------------------------------------
// 1. PDF -> text
// ---------------------------------------------------------------------------

export async function extractPdfText(
  file: File,
  onProgress?: (p: number) => void,
): Promise<string> {
  const data = await file.arrayBuffer();
  const task = pdfjs.getDocument({ data });
  const doc = await task.promise;
  let out = '';
  for (let i = 1; i <= doc.numPages; i++) {
    onProgress?.(i / doc.numPages);
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    out += buildLines(content.items as TextItem[]).join('\n') + '\n';
  }
  await task.destroy();
  onProgress?.(1);
  return out;
}

/** Minimal shape of pdf.js TextItem we actually use (avoids version drift). */
interface TextItem {
  str: string;
  transform?: number[];
}

/** Rebuild visual lines from pdf.js items: group by y, order by x. */
export function buildLines(items: TextItem[]): string[] {
  const rows: { y: number; parts: { x: number; s: string }[] }[] = [];
  for (const it of items) {
    const s = it.str ?? '';
    if (!s.trim()) continue;
    const x = it.transform?.[4] ?? 0;
    const y = it.transform?.[5] ?? 0;
    let row = rows.find((r) => Math.abs(r.y - y) < 2.5);
    if (!row) {
      row = { y, parts: [] };
      rows.push(row);
    }
    row.parts.push({ x, s });
  }
  rows.sort((a, b) => b.y - a.y); // top of the page first
  return rows
    .map((r) => {
      r.parts.sort((a, b) => a.x - b.x);
      return r.parts
        .map((p) => p.s)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// 2. End-to-end: extract text -> parse (LLM or regex) -> categorize
// ---------------------------------------------------------------------------

/**
 * Read a PDF statement from disk, then run the pure statement engine on the
 * extracted text. If the PDF has no extractable text layer (scanned image),
 * the caller should fall back to the QR / screenshot OCR path instead.
 */
export async function importStatement(
  file: File,
  opts: {
    llm?: LLMConfig | null;
    categories?: Category[];
    onProgress?: (p: number, phase: string) => void;
  },
): Promise<ParseStatementResult> {
  opts.onProgress?.(0.05, 'Reading PDF');
  let text: string;
  try {
    text = await extractPdfText(file, (p) =>
      opts.onProgress?.(0.05 + p * 0.4, 'Reading PDF'),
    );
  } catch (e) {
    throw new Error(
      'Could not read that PDF. ' +
        (e instanceof Error
          ? e.message
          : 'It may be scanned-image-only (no text layer).'),
    );
  }

  opts.onProgress?.(0.5, 'Parsing');
  const result = await parseStatementText(text, {
    llm: opts.llm ?? undefined,
    categories: opts.categories,
    onProgress: (p, phase) =>
      opts.onProgress?.(0.5 + p * 0.5, phase),
  });
  opts.onProgress?.(1, 'Done');
  return result;
}
