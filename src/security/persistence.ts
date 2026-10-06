// ============================================================================
// OmniFlow — persistence (IndexedDB via Dexie).
//
// One table per "scope": the encrypted vault. The raw AES-GCM ciphertext is
// what's at rest; IndexedDB itself is opaque to the user and contains no
// readable financial data.
//
// A *scope* is either 'local' (single-device, no cloud account) or a Supabase
// user id (per-account offline cache). This lets one device hold several
// users' encrypted vaults side by side, each restoring from its own cache.
// ============================================================================

import Dexie, { type Table } from 'dexie';
import type { VaultCipher } from './vault';

/** Legacy global row key for local-only mode. */
const LOCAL = 'local';

interface VaultRecord {
  scope: string; // user id, or 'local'
  cipher: VaultCipher;
  storedAt: number;
}

class OmniFlowDB extends Dexie {
  vault!: Table<VaultRecord, string>;
  constructor() {
    super('omniflow');
    // v1 shipped a single numeric-keyed row; v2 keys by string scope so a
    // device can cache one encrypted vault per signed-in user. The upgrade
    // only *adds* the new key; existing data is migrated in the hook.
    this.version(1).stores({ vault: '' });
    this.version(2)
      .stores({ vault: 'scope' })
      .upgrade((tx) => {
        // Move the old key=1 row into scope='local' if present.
        tx.table('vault').toCollection().filter((r: unknown) => {
          const row = r as { key?: unknown };
          return row?.key === 1 || row?.key === '1';
        })
          .modify((r) => {
            const row = r as Record<string, unknown>;
            delete row.key;
            row.scope = LOCAL;
          });
      });
  }
}

export const db = new OmniFlowDB();

export async function hasVaultFor(scope: string): Promise<boolean> {
  const row = await db.vault.get(scope);
  return !!row;
}

export async function loadCipherFor(
  scope: string,
): Promise<{ cipher: VaultCipher; storedAt: number } | undefined> {
  const row = await db.vault.get(scope);
  if (!row) return undefined;
  return { cipher: row.cipher, storedAt: row.storedAt };
}

export async function saveVaultFor(scope: string, cipher: VaultCipher): Promise<void> {
  await db.vault.put({ scope, cipher, storedAt: Date.now() });
}

/** Wipe a single scope (e.g. the current user's offline cache). */
export async function wipeFor(scope: string): Promise<void> {
  await db.vault.delete(scope);
}

/** Wipe every cached vault on this device (Settings -> "Erase all data"). */
export async function wipeAllLocal(): Promise<void> {
  await db.vault.clear();
}

// ---- Legacy local-only helpers (scope 'local') — kept for existing callers ----
export async function hasVault(): Promise<boolean> {
  return hasVaultFor(LOCAL);
}
export async function loadCipher(): Promise<VaultCipher | undefined> {
  return (await loadCipherFor(LOCAL))?.cipher;
}
export async function saveVault(cipher: VaultCipher): Promise<void> {
  await saveVaultFor(LOCAL, cipher);
}
export async function wipe(): Promise<void> {
  await wipeFor(LOCAL);
}
