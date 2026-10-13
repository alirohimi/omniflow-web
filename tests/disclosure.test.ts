import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Regression guard: mobile UX. The Portfolio tab used to stack five
 * same-looking form blocks down the page (create account, reserve line
 * form, target form, add holding...) so "add holding" effectively
 * repeated itself. Secondary config sections now collapse behind themed
 * Disclosure toggles on coarse pointers; payoff data (account cards,
 * holdings lists, emergency hero) stays always visible. Desktop keeps
 * the full one-glance view via @media (pointer: fine).
 */

const here = dirname(fileURLToPath(new URL(import.meta.url)));
const read = (p: string) => readFileSync(join(here, '..', p), 'utf8');

const discSrc = read('src/components/Disclosure.tsx');
const invSrc = read('src/views/InvestmentsView.tsx');
const emSrc = read('src/views/EmergencyPanel.tsx');
const themeSrc = read('src/theme.css');

describe('Disclosure (mobile-first collapsible sections)', () => {
  it('exports a Disclosure component with aria-expanded + sessionStorage memory', () => {
    expect(discSrc).toContain('export function Disclosure');
    expect(discSrc).toContain('aria-expanded={open}');
    expect(discSrc).toContain('sessionStorage');
  });

  it('gives the disclosure a themed 48px tap target with a chevron indicator', () => {
    expect(themeSrc).toMatch(/\.disclosure-toggle \{[\s\S]*min-height: 48px/);
    expect(themeSrc).toContain('.disclosure-chev');
  });

  it('auto-expands and hides the toggle on fine pointers (desktop keeps one-glance view)', () => {
    expect(themeSrc).toMatch(/@media \(pointer: fine\)\s*\{[\s\S]*\.disclosure-toggle \{ display: none; \}/);
  });

  it('wraps the Portfolio secondary sections (accounts, add holding, emergency forms)', () => {
    expect(invSrc).toContain('<Disclosure id="accounts"');
    expect(invSrc).toContain('<Disclosure id="add-holding"');
    expect(emSrc).toContain('<Disclosure id="em-addline"');
    expect(emSrc).toContain('<Disclosure id="em-target"');
  });

  it('keeps the payoff data (holdings list) always visible, outside any Disclosure', () => {
    // The grouped holdings map must render at the same level as the
    // Disclosure, not nested inside it.
    const holdingsIdx = invSrc.indexOf('[...grouped.entries()]');
    expect(holdingsIdx).toBeGreaterThan(0);
    // The add-holding Disclosure closes BEFORE the holdings list begins.
    const addHoldDisclosureStart = invSrc.indexOf('<Disclosure id="add-holding"');
    const disclosureCloseAfterHoldingForm = invSrc.indexOf('</Disclosure>', addHoldDisclosureStart);
    expect(disclosureCloseAfterHoldingForm).toBeGreaterThan(addHoldDisclosureStart);
    expect(disclosureCloseAfterHoldingForm).toBeLessThan(holdingsIdx);
  });
});
