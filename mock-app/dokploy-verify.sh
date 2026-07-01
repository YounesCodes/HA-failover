#!/usr/bin/env bash
# dokploy-verify.sh — confirm the two response shapes the auto-deploy relies on
# (environmentId, composeId), so you can patch the (VERIFY) jq paths in
# /opt/dokploy-deploy.sh if your Dokploy version differs. Read-only by default.
#
#   on an app server:      ./dokploy-verify.sh
#   remote + API token:    DOK_TOKEN=xxx ./dokploy-verify.sh https://dok.example.com
#   fresh box (make admin): DOK_EMAIL=a@b.c DOK_PASS=secret ./dokploy-verify.sh
set -uo pipefail

BASE="${1:-http://127.0.0.1:3000}"
API="$BASE/api"
command -v jq >/dev/null || { echo "install jq first (apt-get install -y jq)"; exit 1; }
CJ="$(mktemp)"; trap 'rm -f "$CJ" "$CJ.spec"' EXIT

auth=()
if [ -n "${DOK_EMAIL:-}" ] && [ -n "${DOK_PASS:-}" ]; then
  echo "# auth: better-auth sign-up (first run) + sign-in as ${DOK_EMAIL}"
  curl -s -X POST "$API/auth/sign-up/email" -H 'content-type: application/json' \
    -d "{\"name\":\"Admin\",\"email\":\"${DOK_EMAIL}\",\"password\":\"${DOK_PASS}\"}" >/dev/null 2>&1 || true
  curl -s -c "$CJ" -X POST "$API/auth/sign-in/email" -H 'content-type: application/json' \
    -d "{\"email\":\"${DOK_EMAIL}\",\"password\":\"${DOK_PASS}\"}" >/dev/null 2>&1 || true
  auth=(-b "$CJ")
else
  echo "# no DOK_EMAIL/DOK_PASS given — anonymous checks only"
fi

echo
echo "=== 1) OpenAPI schema — exact field names (no auth needed) ==="
SPEC=""
for p in /api/openapi.json /openapi.json /api/swagger.json /swagger.json; do
  if curl -fsS "$BASE$p" -o "$CJ.spec" 2>/dev/null; then SPEC="$CJ.spec"; echo "spec: $BASE$p"; break; fi
done
if [ -n "$SPEC" ]; then
  echo "-- paths mentioning project/compose --"
  jq -r '.paths | keys[] | select(test("project|compose"))' "$SPEC" 2>/dev/null | sort -u | head -40
else
  echo "(no OpenAPI endpoint reachable — open ${BASE}/swagger in a browser instead)"
fi

echo
echo "=== 2) live project.all — confirm the nesting (project -> environments -> compose) ==="
if [ "${#auth[@]}" -gt 0 ]; then
  curl -s "${auth[@]}" -G "$API/trpc/project.all" --data-urlencode 'batch=1' \
    --data-urlencode 'input={"0":{"json":null}}' | jq '.[0].result.data.json' 2>/dev/null \
    || echo "(couldn't parse — check auth)"
else
  echo "(need auth: pass DOK_EMAIL + DOK_PASS)"
fi

echo
echo "=== paths dokploy-deploy.sh uses (verified on v0.29.8) ==="
echo "  project.create response  -> .[0].result.data.json.environment.environmentId"
echo "  project.all (find env)   -> .[].environments[]|select(.isDefault).environmentId"
echo "  compose.create response  -> .[0].result.data.json.composeId"
echo "  project.all (find comp.) -> .[].environments[].compose[]|select(.name==NODE).composeId"
echo "If a newer Dokploy changes these, patch dokploy-deploy.sh (repo) +"
echo "/opt/dokploy-deploy.sh (each server), then re-run /opt/dokploy-deploy.sh."
