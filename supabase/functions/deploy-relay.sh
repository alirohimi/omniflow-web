#!/usr/bin/env bash
# deploy-relay.sh — deploy the adacode-relay Edge Function to the main
# Supabase project (tewaulkfcrakeyedxunj) via the Management API.
#
# Usage:
#   SUPABASE_PAT=sbp_... bash supabase/functions/deploy-relay.sh
#
# SUPABASE_PAT = a personal access token (sbp_) scoped to the target project.
# The token is NOT stored in the repo; pass it inline.
#
# What it does:
#   1. Creates the function (POST /v1/projects/<ref>/functions) with
#      verify_jwt=false (required: the browser sends no Supabase JWT).
#   2. Uploads the function body via the multipart "deploy" endpoint.
#   3. Prints the public URL to curl after.

set -euo pipefail

REF="${REF:-tewaulkfcrakeyedxunj}"
NAME="adacode-relay"
API="https://api.supabase.com"
PAT="${SUPABASE_PAT:?SUPABASE_PAT (an sbp_... token) is required}"

echo "== 1) create/replace function $NAME on project $REF =="
# Function creation: the management API expects a JSON body with slug + body.
# We read the TS source and embed it as the function body.
BODY="$(cat supabase/functions/${NAME}/index.ts)"

CREATE_JSON=$(python3 - "$BODY" "$NAME" "$REF" <<'PY'
import json, sys
body, name, ref = sys.argv[1], sys.argv[2], sys.argv[3]
# Supabase Edge Functions are bundled to a single file; send the source as-is.
print(json.dumps({
    "name": name,
    "slug": name,
    "body": body,
    "entrypoint": "index.ts",
    "verify_jwt": False,
}))
PY
)

CREATED=$(curl -sS -X POST \
  -H "Authorization: Bearer ${PAT}" \
  -H "Content-Type: application/json" \
  -d "$CREATE_JSON" \
  "${API}/v1/projects/${REF}/functions")

echo "create response (truncated): ${CREATED:0:400}"

echo
echo "== 2) verify the function is live =="
sleep 3
PROBE=$(curl -sS -i -X OPTIONS \
  -H "Origin: https://alirohimi.github.io" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: authorization,content-type" \
  "https://${REF}.functions.supabase.co/${NAME}")
echo "$PROBE" | head -20

if echo "$PROBE" | grep -qi 'access-control-allow-origin: \*'; then
  echo
  echo "OK: relay is live at https://${REF}.functions.supabase.co/${NAME}"
  echo "Next: set the CI secret VITE_ADACODE_RELAY_URL to that URL, push, and verify the live bundle."
else
  echo
  echo "WARN: ACAO header not yet observed — check the Supabase dashboard (Edge Functions) for deploy errors."
  echo "The create call returned: ${CREATED:0:300}"
fi
