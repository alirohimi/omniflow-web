import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Regression guard: the Investments tab must not reintroduce the cramped
 * per-account action row that broke on phones (three side-by-side ghost
 * buttons + a 44px delete icon fighting the title/chips for horizontal
 * space). Account actions now live in a single themed overflow menu and the
 * account is rendered as a stacked card.
 */

const here = dirname(fileURLToPath(new URL(import.meta.url)));
const invSrc = readFileSync(join(here, '..', 'src', 'views', 'InvestmentsView.tsx'), 'utf8');
const themeSrc = readFileSync(join(here, '..', 'src', 'theme.css'), 'utf8');
const iconsSrc = readFileSync(join(here, '..', 'src', 'icons.tsx'), 'utf8');

describe('InvestmentsView account-card layout (mobile UX)', () => {
  it('renders accounts as stacked .acc-card blocks, not the old flat .item rows', () => {
    expect(invSrc).toContain('acc-card');
    expect(invSrc).toContain('acc-head');
    expect(invSrc).toContain('acc-value');
    expect(invSrc).toContain('acc-foot');
  });

  it('collapses all account actions into a themed overflow MenuButton', () => {
    expect(invSrc).toContain('MenuButton');
    // The destructive delete must stay reachable through the menu, not as a
    // bare always-visible button in the card head.
    expect(invSrc).toContain("label: 'Delete account'");
    expect(invSrc).toMatch(/danger:\s*true,\s*onClick:\s*\(\)\s*=>\s*removeAccount/);
  });

  it('uses a two-tap armed confirmation for the in-menu delete', () => {
    expect(invSrc).toContain("Tap again to confirm");
  });

  it('no longer crams a visible "To reserve" / "Set target" ghost button into the card head', () => {
    // Those actions are menu items / chips now; the old standalone ghost
    // buttons rendered literally in the .item row are gone.
    expect(invSrc).not.toContain('To reserve');
    expect(invSrc).not.toContain('Set target');
  });

  it('renders the per-account starting-capital editor as a themed component', () => {
    // The account footer exposes a deposit editor that opens the capital modal.
    expect(invSrc).toContain('dep-edit');
    expect(invSrc).toContain('openDeposit');
    // The modal lists one input per account, driven by the data-dep-focus marker.
    expect(invSrc).toContain('data-dep-focus');
    expect(invSrc).toContain('dep-input');
    expect(themeSrc).toContain('.dep-input');
    expect(themeSrc).toContain('.dep-edit');
  });

  it('gives account-card chips and the deposit editor a coarse-pointer hit area', () => {
    expect(themeSrc).toMatch(/\.acc-name button\.chip \{ min-height: 40px/);
  });
});
