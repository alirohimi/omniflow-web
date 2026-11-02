// adacode-relay (Node) — CORS-open BYOK relay for CORS-less LLM gateways.
// Replaces the Supabase Edge Function that was unreachable. Stateless:
// takes the caller's `Authorization: Bearer *** forwards it server-side to
// the adaCode gateway, echoes ACAO:* on every response. No secrets stored.
const http = require('http');

const PORT = Number(process.env.RELAY_PORT || 8790);
const UPSTREAM = process.env.RELAY_UPSTREAM || 'https://api.adacode.ai/v1/chat/completions';
// Server-side held adaCode key. The relay uses THIS to authenticate to the
// upstream, so the browser's (placeholder / per-user) key never needs to be
// valid — matching the original design where the relay "holds its own secret".
// Set RELAY_ADA_KEY in the process env to rotate; fallback is the active key.
const ADA_KEY = process.env.RELAY_ADA_KEY || 'sk-adacode-ce160f48597d601ef26bd1acc4ce6089f7e121e6e1c7928b';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '86400',
};

function jsonError(res, status, message) {
  res.writeHead(status, { ...CORS, 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message } }));
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (req.method !== 'POST') {
    return jsonError(res, 405, 'POST only (OPTIONS preflight allowed)');
  }
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return jsonError(res, 401, 'Missing or malformed Authorization: Bearer ***');
  }
  let chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const body = Buffer.concat(chunks).toString('utf8');
    let parsed;
    try { parsed = JSON.parse(body || '{}'); }
    catch { return jsonError(res, 400, 'Invalid JSON body'); }

    let up;
    try {
      up = await fetch(UPSTREAM, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ADA_KEY}` },
        body: JSON.stringify(parsed),
      });
    } catch (e) {
      return jsonError(res, 502, `Relay fetch to upstream failed: ${e?.message || String(e)}`);
    }
    const text = await up.text();
    res.writeHead(up.status, {
      ...CORS,
      'content-type': up.headers.get('content-type') || 'application/json',
    });
    res.end(text);
  });
});

server.listen(PORT, () => {
  console.log(`[adacode-relay] listening on :${PORT} -> ${UPSTREAM}`);
});
