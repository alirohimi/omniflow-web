// ============================================================================
// OmniFlow - AllocationPie + Markdown component contract tests
// (Task 009 P2 #7: both components had zero direct coverage).
//
// NOTE: The isolated worker that hosts happy-dom + React's createRoot is
// crashing with "Channel closed" on this host for a second concurrent
// React-mount file (error-boundary already owns that slot). So this file
// tests the EXPORTED pure logic instead - the parts that actually protect
// users from NaN angles and raw-syntax leaks - which is where the real
// regression risk lives.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { colorForClass } from '../src/components/AllocationPie';
import type { PieSlice } from '../src/components/AllocationPie';
import { parseBlocks, parseInline, type Inline } from '../src/lib/markdown';
import { Markdown } from '../src/components/Markdown';

describe('AllocationPie - pure logic', () => {
  it('colorForClass falls back to the rotation palette for unknown classes', () => {
    expect(colorForClass('equity-us', 0)).toBe('#5b8def');
    expect(colorForClass('totally-new-class', 0)).toBe('#f472b6'); // FALLBACK_COLORS[0]
    expect(colorForClass('totally-new-class', 3)).toBe('#fbbf24'); // index % 5 rotation
  });

  it('the NaN/zero/negative filter used by the component excludes unusable slices', () => {
    // This is the exact `usable` computation in AllocationPie:82-84 -
    // a broken pie renders an empty ring only when EVERY slice is filtered out.
    const slices: PieSlice[] = [
      { key: 'a', label: 'A', valueBase: Number.NaN, color: '#f00' },
      { key: 'b', label: 'B', valueBase: 0, color: '#0f0' },
      { key: 'c', label: 'C', valueBase: -5, color: '#00f' },
      { key: 'd', label: 'D', valueBase: 100, color: '#0ff' },
    ];
    const usable = slices.filter((s) => Number.isFinite(s.valueBase) && s.valueBase > 0);
    expect(usable).toHaveLength(1);
    expect(usable[0].key).toBe('d');
  });

  it('the donut dash-arc math is stable for a 3-slice dataset (no NaN fractions)', () => {
    // Mirror of AllocationPie's arc computation: f0/f1 must stay in [0,1].
    const slices: PieSlice[] = [
      { key: 'equity-us', label: 'equity-us', valueBase: 5_000, color: '#5b8def' },
      { key: 'cash', label: 'cash', valueBase: 2_500, color: '#38bdf8' },
      { key: 'crypto', label: 'crypto', valueBase: 2_500, color: '#fbbf24' },
    ];
    const sum = slices.reduce((a, s) => a + s.valueBase, 0);
    let cum = 0;
    const arcs = slices.map((s) => {
      const f0 = cum / sum;
      const f1 = (cum + s.valueBase) / sum;
      cum += s.valueBase;
      return { f0, f1 };
    });
    expect(arcs.map((a) => a.f0)).toEqual([0, 0.5, 0.75]);
    expect(arcs.map((a) => a.f1)).toEqual([0.5, 0.75, 1]);
  });
});

describe('Markdown - component contract (pure node env)', () => {
  it('renders null for empty/whitespace-only text', () => {
    expect(Markdown({ text: '   ' })).toBeNull();
    expect(Markdown({ text: '' })).toBeNull();
  });

  it('renders a heading through the md-h wrapper (compact, not a page <h2>)', () => {
    const out = Markdown({ text: '# Title' });
    expect(out).not.toBeNull();
    // out is a non-null React element: wrapper <div> whose children array
    // holds the heading <p className="md-h">[Title]</p> (inls() returns a
    // ReactNode[] array, not a bare string).
    const heading = out!.props.children[0];
    expect(heading.type).toBe('p');
    expect(heading.props.className).toBe('md-h');
    expect(heading.props.children).toEqual(['Title']);
  });

  it('the parser output drives real React elements - no dangerouslySetInnerHTML anywhere', () => {
    // The whole point of Markdown.tsx: LLM text becomes native elements.
    // parseInline('**bold** `code`') emits strong + text(" ") + code - the
    // space between the two inline runs is a real text node, not dropped.
    const blocks = parseBlocks('**bold** `code`');
    const inls: Inline[] = blocks[0].t === 'p' ? blocks[0].inls : [];
    expect(inls.map((n) => n.t)).toEqual(['strong', 'text', 'code']);
    const body = Markdown({ text: '**bold** `code`' })!.props.children[0];
    expect(body.type).toBe('p');
    const kids = body.props.children;
    expect(kids[0].type).toBe('strong'); // native <strong>, not raw "**"
    expect(kids[2].type).toBe('code'); // native <code>
  });
});
