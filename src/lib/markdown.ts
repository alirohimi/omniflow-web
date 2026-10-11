// ============================================================================
// OmniFlow — zero-dependency compact-markdown parser.
//
// LLM tiers emit compact markdown (lists, bold, headings, quotes, code).
// This module turns that text into a block/inline AST so a React component
// can render it as NATIVE elements — no dangerouslySetInnerHTML anywhere.
//
// Deliberately small: paragraphs, **bold**, *italic*, `code`, ``` fences,
// - / * / + bullets, 1. ordered lists, #..### headings, > quotes. Tables,
// links and images are NOT supported (prompts forbid them); anything
// unrecognized degrades to plain text, never raw-asterisk soup.
// ============================================================================

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; v: Inline[] }
  | { t: 'em'; v: Inline[] }
  | { t: 'code'; v: string };

export type Block =
  | { t: 'p'; inls: Inline[] }
  | { t: 'h'; level: number; inls: Inline[] }
  | { t: 'list'; ordered: boolean; items: { ind: number; inls: Inline[] }[] }
  | { t: 'code'; lang: string; lines: string[] }
  | { t: 'quote'; inls: Inline[] };

// ---------------------------------------------------------------------------
// Block level.
// ---------------------------------------------------------------------------

export function parseBlocks(src: string): Block[] {
  const lines = src.split(/\r?\n/);
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // Fenced code block.
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i]);
      i++; // skip closing fence (or EOF)
      blocks.push({ t: 'code', lang: fence[1] ?? '', lines: buf });
      continue;
    }

    const trimmed = line.trim();

    // Blockquote.
    if (trimmed.startsWith('>')) {
      blocks.push({ t: 'quote', inls: parseInline(trimmed.replace(/^>\s?/, '')) });
      i++;
      continue;
    }

    // ATX heading (#..### — deeper levels render as the same compact style).
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      blocks.push({ t: 'h', level: Math.min(3, h[1].length), inls: parseInline(h[2]) });
      i++;
      continue;
    }

    // List start. The ordered marker needs a following space ("3M10Y" or
    // "2021.5" never looks like a list marker).
    const isItem =
      /^[-*+]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed) || /^\d+\)\s/.test(trimmed);
    if (isItem) {
      const ordered = /^\d/.test(trimmed);
      const items: { ind: number; inls: Inline[] }[] = [];
      while (i < lines.length) {
        const l2 = lines[i];
        const t2 = l2.trim();
        if (!t2) {
          // A blank line ends the list unless the very next line continues it.
          if (i + 1 < lines.length) {
            const nt = lines[i + 1].trim();
            if (nt && (/^[-*+]\s/.test(nt) || /^\d+[.)]\s/.test(nt))) { i++; continue; }
          }
          break;
        }
        const m2 = t2.match(/^([-*+]|\d+[.)])\s+(.*)$/);
        if (!m2) break;
        const ind = (l2.match(/^ */) ?? [''])[0].length;
        items.push({ ind, inls: parseInline(m2[2]) });
        i++;
      }
      blocks.push({ t: 'list', ordered, items });
      continue;
    }

    // Paragraph: consume until a blank line or the start of another block.
    const buf = [line];
    i++;
    while (i < lines.length) {
      const t3 = lines[i].trim();
      if (
        !t3 || /^```/.test(t3) || /^>/.test(t3) || /^#{1,6}\s/.test(t3) ||
        /^[-*+]\s/.test(t3) || /^\d+[.)]\s/.test(t3)
      ) break;
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ t: 'p', inls: parseInline(buf.join('\n')) });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Inline level: `code` (verbatim, always first), **strong**, *em*.
// ---------------------------------------------------------------------------

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) { out.push({ t: 'text', v: buf }); buf = ''; }
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i) {
        flush();
        out.push({ t: 'code', v: s.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
    }
    if (c === '*' && s[i + 1] === '*' && s[i + 2] !== '*') {
      const close = findClose(s, i + 2, '**');
      if (close !== -1) {
        flush();
        out.push({ t: 'strong', v: parseInline(s.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }
    if (c === '*' && s[i + 1] !== '*' && s[i - 1] !== '*') {
      const close = findClose(s, i + 1, '*');
      if (close !== -1) {
        flush();
        out.push({ t: 'em', v: parseInline(s.slice(i + 1, close)) });
        i = close + 1;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/** Find the closing marker not adjacent to extra stars (avoids *** runs). */
function findClose(s: string, from: number, marker: string): number {
  const m = marker.length;
  let idx = s.indexOf(marker, from);
  while (idx !== -1) {
    const prev = idx > 0 ? s[idx - 1] : '';
    const next = s[idx + m] ?? '';
    if (prev !== '*' && next !== '*') return idx;
    idx = s.indexOf(marker, idx + m);
  }
  return -1;
}

export const __test = { parseBlocks, parseInline };
