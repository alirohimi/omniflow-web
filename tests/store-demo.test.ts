// ============================================================================
// OmniFlow — loadDemo data-path integration test (no network, no DOM).
//
// Exercises the exact pipeline behind Settings -> "Load demo data":
//   1. demoVault() ships the full demo dataset
//   2. the store updater merge preserves the user's prefs + demo records
//   3. the persist round-trip (AES-GCM encrypt -> decrypt) survives
// ============================================================================

import { describe, it, expect } from 'vitest';
import { emptyVault, demoVault } from '../src/domain/seed';
import { encryptVault, decryptVault } from '../src/security/vault';
import type { VaultBlob } from '../src/domain/types';

/** Mirrors store.tsx loadDemo: replace financial data, keep prefs/keys. */
function applyLoadDemo(prev: VaultBlob): VaultBlob {
  const demo = demoVault();
  return {
    ...demo,
    prefs: prev.prefs,
    llmKey: prev.llmKey,
    createdAt: prev.createdAt,
    updatedAt: Date.now(),
  };
}

describe('loadDemo data path', () => {
  it('demoVault ships a populated dataset', () => {
    const demo = demoVault();
    expect(demo.expenses.length).toBe(4);
    expect(demo.accounts.length).toBe(3);
    expect(demo.holdings.length).toBe(3);
    // Platform-agnostic accounts + mixed asset classes present.
    expect(demo.accounts.map((a) => a.platformName)).toEqual(
      expect.arrayContaining(['Luno', 'IBKR', 'StashAway']),
    );
    expect(demo.holdings.map((h) => h.assetClass)).toEqual(
      expect.arrayContaining(['crypto', 'equity-us', 'etf']),
    );
  });

  it('updater merge keeps the user prefs/llmKey but takes demo records', () => {
    const prev = emptyVault({ baseCurrency: 'SGD' });
    const next = applyLoadDemo(prev);
    expect(next.prefs.baseCurrency).toBe('SGD'); // prefs preserved
    expect(next.expenses).toHaveLength(4);
    expect(next.accounts).toHaveLength(3);
    expect(next.holdings).toHaveLength(3);
    expect(next.expenses.map((e) => e.id)).toEqual(
      ['ex-1', 'ex-2', 'ex-3', 'ex-4'],
    );
    // Foreign expenses carry pre-computed base amounts (FX snapshot at seed).
    const usd = next.expenses.find((e) => e.originalCurrency === 'USD');
    expect(usd?.baseAmount).toBeCloseTo(12.99 * 4.21, 1);
  });

  it('merged blob survives the persist round-trip (encrypt -> decrypt)', async () => {
    const prev = emptyVault({ baseCurrency: 'SGD' });
    const next = applyLoadDemo(prev);
    const cipher = await encryptVault(next, 'test-passphrase');
    const restored = await decryptVault<VaultBlob>(cipher, 'test-passphrase');
    expect(restored.expenses).toHaveLength(4);
    expect(restored.accounts).toHaveLength(3);
    expect(restored.holdings).toHaveLength(3);
    expect(restored.prefs.baseCurrency).toBe('SGD');
  });
});
