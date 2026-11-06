// ============================================================================
// OmniFlow — SecurityManager (browser port of the iOS SecurityManager).
//
// The iOS app binds secrets to the Secure Enclave with biometric-gated
// Keychain access. The browser equivalent is a *passphrase-gated* encrypted
// vault:
//
//   PBKDF2(passphrase, salt, 210_000 iters, SHA-256)  ->  AES-256-GCM key
//
// The ciphertext (header + salt + IV + body) is what gets persisted to the
// shared database (one encrypted row per user, RLS-scoped). Without the
// passphrase, the bytes are unrecoverable — no plaintext anywhere. A wrong
// passphrase surfaces a decrypt failure (auth-tag mismatch), never a partial
// read.
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

// TS >= 5.7 ships generic typed arrays. `new Uint8Array(n)` is
// Uint8Array<ArrayBuffer> (backed by a plain ArrayBuffer) — a valid WebCrypto
// BufferSource (ArrayBufferView<ArrayBuffer> | ArrayBuffer). We type every
// buffer concretely as Uint8Array<ArrayBuffer> so the DOM lib's BufferSource
// check passes. A bare `Uint8Array` (= Uint8Array<ArrayBufferLike>) would be
// rejected in TS 5.8/5.9.
type U8 = Uint8Array<ArrayBuffer>;

function bufToB64(b: ArrayBuffer | U8): string {
  const s = b instanceof Uint8Array ? b : new Uint8Array(b);
  let out = '';
  for (let i = 0; i < s.length; i++) out += String.fromCharCode(s[i]);
  return btoa(out);
}

function b64ToU8(b: string): U8 {
  const s = atob(b);
  const out = new Uint8Array(s.length); // Uint8Array<ArrayBuffer>
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Derive a usable AES-GCM CryptoKey from a passphrase + salt. */
async function deriveKey(
  passphrase: string,
  salt: U8,
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
  const salt = crypto.getRandomValues(new Uint8Array(16)); // U8
  const iv = crypto.getRandomValues(new Uint8Array(12)); // U8
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
  const salt = b64ToU8(c.salt);
  const iv = b64ToU8(c.iv);
  const body = b64ToU8(c.body);
  const key = await deriveKey(passphrase, salt);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    body,
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

export const __test = { bufToB64, b64ToU8, PBKDF2_ITERATIONS };
