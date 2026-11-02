// adacode-relay — stateless CORS-open BYOK relay for CORS-less LLM gateways.
//
// Lives on the MAIN Supabase project (tewaulkfcrakeyedxunj) so the browser
// can read LLM responses. The old host project (ijwpyikc...) is dead, which
// broke every adacode LLM call with an opaque "Load failed" — the coach then
// silently fell back to the on-device rule engine. This function restores the
// path.
//
// PROBLEM: api.adacode.ai sends CORS headers on the OPTIONS preflight ONLY and
// echoes ZERO access-control-allow-origin on actual responses (200 success,
// 4xx, 5xx alike). Browsers mask that as TypeError: Failed to fetch / Safari
// "Load failed" — no status, no body, unreadable in-app.
//
// THIS FIX: takes the user's `Authorization: Bearer *** from the incoming
// request, forwards it server-side to the gateway (server-side fetch has no
// CORS limit), and echoes ACAO:* on EVERY response including errors. BYOK
// stays honest: the key transits per-request over HTTPS, is stored nowhere,
// and never ships in the client bundle.
//
// DEPLOY (free tier, $0) — via Supabase CLI or Management API:
//   supabase functions deploy adacode-relay --project-ref <ref>
//   The function config MUST set verify_jwt = false (Edge Functions are
//   JWT-gated by default; without it the browser gets a 401 before relay
//   logic runs). With the Management API, pass the config via
//   POST /v1/projects/<ref>/functions and set "verify_jwt": false.
//
// CLIENT WIRING: point the adacode provider branch's endpoint at
//   https://<ref>.functions.supabase.co/adacode-relay
// (i.e. set VITE_ADACODE_RELAY_URL in CI secrets). Request/response shapes
// are unchanged (OpenAI-compatible), so existing provider extractors and the
// testLLMKey health probe keep working.

const UPSTREAM = "https://api.adacode.ai/v1/chat/completions";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
} as const;

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

export default {
  async handler(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (req.method !== "POST") {
      return jsonError(405, "POST only (OPTIONS preflight allowed)");
    }
    const auth = req.headers.get("authorization");
    if (!auth || !auth.startsWith("Bearer ")) {
      return jsonError(401, "Missing or malformed Authorization: Bearer ***");
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonError(400, "Invalid JSON body");
    }
    let up: Response;
    try {
      up = await fetch(UPSTREAM, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: auth,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return jsonError(
        502,
        `Relay fetch to upstream failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const text = await up.text();
    return new Response(text, {
      status: up.status,
      headers: {
        ...CORS,
        "content-type": up.headers.get("content-type") ?? "application/json",
      },
    });
  },
};
