// ============================================================================
// OmniFlow — Markdown: renders the compact-markdown AST from lib/markdown.ts
// as native React elements. Zero dependencies, zero innerHTML — LLM output
// becomes <strong>/<em>/<ul>/<pre>/... without any raw syntax surviving.
// ============================================================================

import type { ReactNode, ElementType } from 'react';
import { parseBlocks, type Block, type Inline } from '../lib/markdown';

let k = 0;
const nextKey = () => `md-${k++}`;

function inls(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        return n.v;
      case 'code':
        return <code key={i}>{n.v}</code>;
      case 'strong':
        return <strong key={i}>{inls(n.v)}</strong>;
      case 'em':
        return <em key={i}>{inls(n.v)}</em>;
    }
  });
}

type ListItem = { ind: number; inls: Inline[] };

/** Render the direct items of a list run. An item's children are the
 *  IMMEDIATELY following items that are indented deeper than it — the
 *  standard markdown rule, so "- a / - b /   - b's child" never attaches
 *  b's child to a. */
function renderItems(run: ListItem[]): ReactNode[] {
  const minInd = run.reduce((m, x) => Math.min(m, x.ind), run[0].ind);
  const lis: ReactNode[] = [];
  let i = 0;
  while (i < run.length) {
    const it = run[i];
    if (it.ind !== minInd) { i++; continue; } // can't happen for a well-formed run
    let j = i + 1;
    while (j < run.length && run[j].ind > minInd) j++;
    const sub = run.slice(i + 1, j);
    lis.push(
      <li key={`i${i}`}>
        {inls(it.inls)}
        {sub.length > 0 ? <ul>{renderItems(sub)}</ul> : null}
      </li>,
    );
    i = j;
  }
  return lis;
}

function renderList(items: ListItem[], ordered: boolean): ReactNode {
  const Tag = ordered ? 'ol' : 'ul';
  return <Tag>{renderItems(items)}</Tag>;
}

function renderBlock(b: Block, key: string): ReactNode {
  switch (b.t) {
    case 'p':
      return <p key={key}>{inls(b.inls)}</p>;
    case 'h':
      // Compact heading inside a chat bubble: same size as strong text,
      // just heavier — not a page <h2> that would re-flow the layout.
      return (
        <p key={key} className="md-h">
          {inls(b.inls)}
        </p>
      );
    case 'quote':
      return <blockquote key={key}>{inls(b.inls)}</blockquote>;
    case 'code':
      return <pre key={key}><code>{b.lines.join('\n')}</code></pre>;
    case 'list':
      return <div key={key} className="md-list">{renderList(b.items, b.ordered)}</div>;
  }
}

/** Public entry: parse + render. `as` lets the caller pick the wrapper
 *  element so the markdown sits inside a chat bubble (div) or a card (p). */
export function Markdown({
  text,
  as: Comp = 'div',
  className = '',
}: {
  text: string;
  as?: 'div' | 'p' | 'span';
  className?: string;
}) {
  if (!text || !text.trim()) return null;
  const blocks = parseBlocks(text);
  const body = blocks.map((b, i) => renderBlock(b, nextKey()));
  const C = Comp as React.ElementType;
  return <C className={className}>{body}</C>;
}

export default Markdown;
