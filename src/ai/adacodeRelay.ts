// ============================================================================
// adacodeRelay — runtime source of the adaCode relay URL.
//
// Priority (runtime, no build-time env needed):
//   1. public/adacode-relay.json     — a tiny JSON file in the Pages bundle;
//      the ONLY editable source. Point the app at a new relay (self-host,
//      Supabase, …) by updating this file; it takes effect on the next app
//      load — no rebuild, no CI secret, no env vars.
//   2. VITE_ADACODE_RELAY_URL        — build-time override (kept for anyone
//      who builds with env injection).
//   3. hardcoded Supabase default    — last resort.
//
// The relay must be CORS-open (echoes ACAO: * on POST responses and serves a
// 204 OPTIONS preflight). Self-host: `node tools/adacode-relay-node.cjs`
// behind a tunnel/domain.
// ============================================================================

const HARDCODED_RELAY =
  'https://tewaulkfcrakeyedxunj.functions.supabase.co/adacode-relay';

const buildTime =
  typeof import.meta !== 'undefined' && import.meta.env
    ? import.meta.env.VITE_ADACODE_RELAY_URL
    : undefined;

type RelayConfig = { relayUrl?: string };

let fileConfig: RelayConfig | null = null;
let fileConfigLoaded = false;
let lastFailAt = 0;

/**
 * Fetch the relay config file. Resolves immediately with the cached value once
 * fetched this session; on a failed fetch, caches the failure for 60s so a
 * downed config host doesn't add a network trip to every LLM call.
 */
export async function loadRelayConfig(): Promise<RelayConfig | null> {
  if (fileConfigLoaded) return fileConfig;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}adacode-relay.json`, {
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fileConfig = (await res.json()) as RelayConfig;
    fileConfigLoaded = true;
    return fileConfig;
  } catch {
    const now = Date.now();
    if (now - lastFailAt < 60_000) return fileConfig; // still in negative cache
    lastFailAt = now;
    fileConfig = null;
    fileConfigLoaded = true;
    return null;
  }
}

/** Resolve the relay URL: file config > build-time env > hardcoded. */
export async function getRelayUrl(): Promise<string> {
  const cfg = await loadRelayConfig();
  const fromFile = cfg?.relayUrl?.trim();
  if (fromFile) return fromFile;
  if (typeof buildTime === 'string' && buildTime.trim()) return buildTime.trim();
  return HARDCODED_RELAY;
}

/** Synchronous last-known relay URL (for diagnostics only). */
export function lastKnownRelayUrl(): string {
  const fromFile = fileConfig?.relayUrl?.trim();
  if (fromFile) return fromFile;
  if (typeof buildTime === 'string' && buildTime.trim()) return buildTime.trim();
  return HARDCODED_RELAY;
}
