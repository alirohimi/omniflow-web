// ============================================================================
// OmniFlow - ThemedSelect migration test (Task 010 P2 #9).
//
// Locks in that every native <select> has been replaced by the themed
// ThemedSelect control, and that the control itself exposes the combobox /
// listbox ARIA contract + 44px HIG option rows it was built for.
//
// Pure source + CSS assertions (no DOM mount) so it runs in the plain node
// vitest environment alongside the rest of the suite.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const readSrc = (rel: string) => readFileSync(join(here, '..', rel), 'utf8');

const VIEW_FILES = [
  'src/views/ExpensesView.tsx',
  'src/views/SettingsView.tsx',
  'src/views/InvestmentsView.tsx',
  'src/views/EmergencyPanel.tsx',
  'src/views/AutoInvestPanel.tsx',
];

/**
 * Filter out lines that belong to comment blocks. Handles the comment shapes
 * that wrap native-select mentions in this codebase:
 *   - multi-line TSX block comments (opened with a JSX-style `{` + `/*`)
 *   - multi-line block comments
 *   - single-line slash-slash comments
 * A line is "active" only if it is not entirely inside a comment block.
 */
function stripComments(src: string): string[] {
  const lines = src.split('\n');
  const out: string[] = [];
  let inBlock = false;
  let blockOpen = -1; // -1 or 2: character offset where the opening marker began
  for (const line of lines) {
    let active: string | null = null;

    if (inBlock) {
      const close = line.indexOf('*/');
      if (close === -1) continue; // still inside
      inBlock = false;
      active = line.slice(close + 2); // rest after the closing */
    } else {
      // find the earliest opening marker: /* (block) or // (line comment)
      let openBlock = line.indexOf('/*');
      const openLine = line.indexOf('//');
      // a /* that appears after a // on the same line is inside the // comment
      if (openLine !== -1 && openBlock !== -1 && openLine < openBlock) openBlock = -1;
      if (openBlock !== -1) {
        inBlock = true;
        blockOpen = openBlock;
        active = line.slice(0, openBlock);
        // check if it closes on the same line
        const close = line.indexOf('*/', openBlock + 2);
        if (close !== -1) {
          inBlock = false;
          active = (line.slice(0, openBlock) + line.slice(close + 2)).trim();
        }
      } else if (openLine !== -1) {
        active = line.slice(0, openLine); // // comment: drop the rest
      } else {
        active = line; // no comment at all
      }
    }
    if (active !== null && active.trim() !== '') out.push(active);
  }
  return out;
}

describe('ThemedSelect - migration of all native <select> instances', () => {
  it('no native <select> element remains in any view (Task 010 P2 #9)', () => {
    for (const f of VIEW_FILES) {
      const src = readSrc(f);
      const activeLines = stripComments(src);
      // Match a bare native <select that is NOT the ThemedSelect usage.
      // ThemedSelect renders as <ThemedSelect so the literal '<select' can only
      // appear as a real native element (or inside a comment, which is stripped).
      const nativeSelects = activeLines
        .filter((l) => /<select[\s>]/.test(l))
        .map((l) => l.trim());
      expect(nativeSelects, `${f} still has native <select>:\n${nativeSelects.join('\n')}`).toHaveLength(0);
    }
  });

  it('every migrated view imports and uses the ThemedSelect control', () => {
    for (const f of VIEW_FILES) {
      const src = readSrc(f);
      expect(src).toContain('ThemedSelect');
      expect(src).toMatch(/from '\.\.\/components\/ThemedSelect'/);
      const usages = src.match(/<ThemedSelect\b/g) ?? [];
      expect(usages.length, `${f} imports ThemedSelect but never uses it`).toBeGreaterThan(0);
    }
  });

  it('the CSS defines a 44px HIG option row + 48px form trigger + compact override', () => {
    const css = readSrc('src/theme.css');
    expect(css).toMatch(/\.tsel-opt \{[\s\S]*?min-height: 44px/);
    expect(css).toMatch(/\.tsel-trigger \{[\s\S]*?min-height: 48px/);
    expect(css).toMatch(/\.tsel-compact \.tsel-trigger \{ min-height: 0/);
  });

  it('the ThemedSelect source exposes the combobox/listbox ARIA contract', () => {
    const src = readSrc('src/components/ThemedSelect.tsx');
    expect(src).toContain('role="combobox"');
    expect(src).toContain('aria-haspopup="listbox"');
    expect(src).toContain('aria-expanded={open}');
    expect(src).toContain('role="listbox"');
    expect(src).toContain('aria-selected={isSel}');
  });

  it('the ThemedSelect source wires the 44px HIG row + compact variant', () => {
    const src = readSrc('src/components/ThemedSelect.tsx');
    expect(src).toMatch(/tsel-compact/);
    expect(src).toMatch(/tsel-opt/);
  });
});
