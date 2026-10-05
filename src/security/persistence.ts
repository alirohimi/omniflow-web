// ============================================================================
// OmniFlow — persistence (IndexedDB via Dexie).
//
// One table, one row: the encrypted vault. The raw AES-GCM ciphertext is
// what's at rest; IndexedDB itself is opaque to the user and contains no
// readable financial data.
// ============================================================================

import Dexie, { type Table } from 'dexie';
import type { VaultCipher } from './vault';

interface VaultRecord {
  key: number; // always 1
  cipher: VaultCipher;
  storedAt: number;
}

class OmniFlowDB extends Dexie {
  vault!: Table<VaultRecord, number>;
  constructor() {
    super('omniflow');
    this.version(1).stores({ vault: 'key' });
  }
}

export const db = new OmniFlowDB();

export async function hasVault(): Promise<boolean> {
  const row = await db.vault.get(1);
  return !!row;
}

export async function saveVault(cipher: VaultCipher): Promise<void> {
  await db.vault.put({ key: 1, cipher, storedAt: Date.now() });
}

export async function loadCipher(): Promise<VaultCipher | undefined> {
  const row = await db.vault.get(1);
  return row?.cipher;
}

/** Wipe local data (Settings -> "Erase all data"). */
export async function wipe(): Promise<void> {
  await db.vault.clear();
}
