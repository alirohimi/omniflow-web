// yahoo-quote — stateless CORS-open Yahoo Finance v8 chart proxy.
//
// PROBLEM: query1.finance.yahoo.com does not return CORS headers to browsers,
// so GitHub Pages / PWA fetches for ETFs, stocks, and gold (CSPX.L, GLDM,
// ^GSPC, GC=F, 1155.KL) fail in the browser and fall back to flat refPrices.
//
// FIX: server-side fetch from Supabase Edge Function with ACAO:* and 60s
// edge caching. No credentials or user data ever transit this endpoint.

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
} as const;

const SYMBOL_RE = /^[A-Za-z0-9.^=-]{1,24}$/;

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "GET") {
    return jsonError(405, "GET only");
  }

  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") ?? "").trim();
  if (!symbol || !SYMBOL_RE.test(symbol)) {
    return jsonError(400, "Invalid or missing ?symbol=");
  }

  const upstream = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  let up: Response;
  try {
    up = await fetch(upstream, {
      signal: AbortSignal.timeout(8000),
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; OmniFlow/1.0)",
      },
    });
  } catch (e) {
    return jsonError(
      502,
      `Yahoo fetch failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const text = await up.text();
  return new Response(text, {
    status: up.status,
    headers: {
      ...CORS,
      "content-type": up.headers.get("content-type") ?? "application/json",
      "cache-control": up.ok ? "public, max-age=60" : "no-store",
    },
  });
});
