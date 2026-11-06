// ============================================================================
// OmniFlow — keepalive vault-flush tests (no network, no DOM).
// Proves the unload-time last save re-sends the encrypted blob over a
// keepalive fetch, authenticates with the session JWT, and degrades to a
// no-op when there is nothing it can authenticate with.
// ============================================================================

import { describe, it, expect, vi, afterEach } from 'vitest';
import { flushVaultKeepalive } from '../src/services/cloudVault';
import type { VaultCipher } from '../src/security/vault';

const cipher: VaultCipher = { v: 1, salt: 's', iv: 'i', body: 'b' };
const ep = { url: 'https://xyz.supabase.co', anonKey: 'anon' };

function mockFetchOk() {
  const fn = vi.fn().mockResolvedValue({ ok: true } as unknown as Response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('flushVaultKeepalive', () => {
  it('POSTs a keepalive upsert to PostgREST with the session JWT', () => {
    const fn = mockFetchOk();
    flushVaultKeepalive('user-1', cipher, 'jwt-token', ep);
    expect(fn).toHaveBeenCalledTimes(1);
    const args = fn.mock.calls[0];
    expect(args[0]).toBe('https://xyz.supabase.co/rest/v1/omniflow_vaults');
    const init = args[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    const h = init.headers as Record<string, string>;
    expect(h.apikey).toBe('anon');
    expect(h.Authorization).toBe('Bearer jwt-token');
    expect(h['Content-Type']).toBe('application/json');
    expect(h.Prefer).toBe('resolution=merge-duplicates');
    const body = JSON.parse(init.body as string);
    expect(body.user_id).toBe('user-1');
    expect(body.v).toBe(1);
    expect(body.salt).toBe('s');
    expect(body.iv).toBe('i');
    expect(body.body).toBe('b');
    expect(typeof body.updated_at).toBe('string');
  });

  it('skips entirely when there is no access token', () => {
    const fn = mockFetchOk();
    flushVaultKeepalive('user-1', cipher, null, ep);
    expect(fn).not.toHaveBeenCalled();
  });

  it('skips entirely when endpoints are null (cloud not configured)', () => {
    const fn = mockFetchOk();
    flushVaultKeepalive('user-1', cipher, 'tok', null);
    expect(fn).not.toHaveBeenCalled();
  });

  it('swallows a fetch rejection (no throw, no unhandled rejection)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fn);
    expect(() => flushVaultKeepalive('user-1', cipher, 'tok', ep)).not.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
    // let the .catch() resolve so nothing becomes an unhandled rejection
    await new Promise((r) => setTimeout(r, 0));
  });
});
