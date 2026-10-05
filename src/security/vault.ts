// ============================================================================
// OmniFlow — SecurityManager (browser port of the iOS SecurityManager).
//
// The iOS app binds secrets to the Secure Enclave with biometric-gated
// Keychain access. The browser equivalent is a *passphrase-gated* encrypted
// vault:
//
//   PBKDF2(passphrase, salt, 210_000 iters, SHA-256)  ->  AES-256-GCM key
//
// The ciphertext (header + salt + IV + body) is what gets persisted to
// IndexedDB. Without the passphrase, the bytes are unrecoverable — no
// server, no plaintext at rest. A wrong passphrase surfaces a decrypt
// failure (auth-tag mismatch), never a partial read.
// ============================================================================

export interface VaultCipher {
  // base64 of: version | salt(16) | iv(12) | authTag(16) | body
  v: number;
  salt: string;
  iv: string;
  body: string;
}

const PBKDF2_ITERATIONS = 210_000; // OWASP-adjacent floor for SHA-256+PBKDF2
const ENC = new TextEncoder();
const DEC = new TextDecoder();

function bufToB64(b: ArrayBuffer): string {
  const s = Uint8Array.from(b);
  let out = '';
  for (let i = 0; i < s.length; i++) out += String.fromCharCode(s[i]);
  return btoa(out);
}

function b64ToBuf(b: string): ArrayBuffer {
  const s = atob(b);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Derive a usable AES-GCM CryptoKey from a passphrase + salt. */
async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    ENC.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt any serialisable object with a passphrase. */
export async function encryptVault(
  payload: unknown,
  passphrase: string,
): Promise<VaultCipher> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const body = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    ENC.encode(JSON.stringify(payload)),
  );
  return { v: 1, salt: bufToB64(salt), iv: bufToB64(iv), body: bufToB64(body) };
}

/** Decrypt a vault produced by encryptVault. Throws on wrong passphrase. */
export async function decryptVault<T>(
  c: VaultCipher,
  passphrase: string,
): Promise<T> {
  const salt = b64ToBuf(c.salt);
  const iv = b64ToBuf(c.iv);
  const body = b64ToBuf(c.body);
  const key = await deriveKey(passphrase, new Uint8Array(salt));
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv) },
    key,
    new Uint8Array(body),
  );
  const text = DEC.decode(plain);
  return JSON.parse(text) as T;
}

/** SHA-256 fingerprint of a BYOK LLM key — displayed to the user, never
 *  the key itself. */
export async function fingerprintSecret(
  secret: string,
): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', ENC.encode(secret));
  return bufToB64(h).slice(0, 16);
}

export const __test = { bufToB64, b64ToBuf, PBKDF2_ITERATIONS };
