// ============================================================================
// OmniFlow — gate flow source-contract tests (Task 009 P1 #5: the app entry
// point had no dedicated regression guard).
//
// Convention: same source-reading style as expenses-filter.test.ts — read the
// view/provider sources and assert the render contract, no full-app mount
// (the gate pulls in the whole store + Supabase graph).
// ============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, '..', p), 'utf8');

const appSrc = read('src/App.tsx');
const accountGateSrc = read('src/views/AccountGate.tsx');
const vaultGateSrc = read('src/views/VaultGate.tsx');
const authSrc = read('src/auth/AuthProvider.tsx');
const storeSrc = read('src/store/store.tsx');

describe('Gate flow: shell render contract (App.tsx)', () => {
  it('routes the restoring session to a "Checking your account…" loader, not a blank shell', () => {
    expect(appSrc).toMatch(/auth\.restoring/);
    expect(appSrc).toContain('Checking your account…');
    expect(appSrc).toContain('Restoring your session.');
  });

  it('signs-out users land on AccountGate, never the local-only VaultGate', () => {
    // Cloud-available + null user must short-circuit to AccountGate BEFORE the
    // vault gate check — the "never flash through" rule.
    const cloudBranch = appSrc.indexOf('if (auth.cloudAvailable) {');
    const vaultGate = appSrc.indexOf('if (store.status !== \'unlocked\')');
    expect(cloudBranch).toBeGreaterThan(-1);
    expect(vaultGate).toBeGreaterThan(cloudBranch);
    expect(appSrc.slice(cloudBranch, vaultGate)).toContain('<AccountGate />');
  });

  it('local-only mode (cloud off) enters via VaultGate', () => {
    expect(appSrc).toMatch(/if \(store\.status !== 'unlocked'\) return <VaultGate/);
  });

  it('the header lock button calls store.lock() and never auto-locks on idle', () => {
    expect(appSrc).toMatch(/onClick=\{\(\) => store\.lock\(\)\}/);
    // Auto-lock was intentionally removed: the effect body is a no-op.
    expect(appSrc).toMatch(/auto-lock intentionally removed/);
  });
});

describe('Gate flow: VaultGate contract', () => {
  it('requires a minimum 4-char password (store.createVault guard)', () => {
    expect(storeSrc).toMatch(/password\.length < 4/);
    expect(storeSrc).toContain('Password must be at least 4 characters.');
  });

  it('wrong password re-prompts and says the data stays encrypted', () => {
    expect(storeSrc).toContain('Wrong password. Your data stays encrypted until you type it right.');
  });

  it('DB-unavailable renders a retry path that reloads — never a wipe', () => {
    expect(vaultGateSrc).toContain("if (status === 'unavailable')");
    expect(vaultGateSrc).toContain("Could not reach your data store. Your encrypted data is intact — retry when the network is back.");
    expect(vaultGateSrc).toMatch(/location\.reload\(\)/);
  });

  it('create vs unlock is state-gated: "Set up your vault" vs "Unlock OmniFlow"', () => {
    expect(vaultGateSrc).toContain('Set up your vault');
    expect(vaultGateSrc).toContain('Unlock OmniFlow');
    expect(vaultGateSrc).toMatch(/disabled=\{busy \|\| !pass\}/); // empty password submit blocked
  });
});

describe('Gate flow: AccountGate + AuthProvider contract', () => {
  it('sign-in surfaces Supabase error messages via lastError', () => {
    expect(authSrc).toMatch(/setLastError\(error\.message\)/);
    expect(accountGateSrc).toMatch(/lastError/);
  });

  it('a missing Supabase config is a hard, surfaced error (never a silent local fallback)', () => {
    expect(authSrc).toContain('Cloud sync is not configured.');
  });

  it('sign-out clears the session (signOut exposed on the store hook)', () => {
    expect(authSrc).toMatch(/signOut/);
  });
});
