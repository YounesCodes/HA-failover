#!/usr/bin/env bash
# Drive the heartbeat during a failover test.
#   ./loadtest.sh https://app1.example.com
# Writes one /beat per second and prints the result; on failover you'll see a
# gap (RTO) then writes resume. Afterwards, GET /last on the promoted region
# and confirm the last id you saw before the gap is present (RPO = 0).
set -uo pipefail

BASE="${1:?usage: loadtest.sh <base-url>}"
INTERVAL="${2:-1}"

echo "beating $BASE every ${INTERVAL}s — Ctrl-C to stop"
while true; do
  ts=$(date -u +%H:%M:%S)
  body=$(curl -s -m 3 -o - -w '\n%{http_code}' -X POST "$BASE/beat" || echo $'\n000')
  code=$(printf '%s' "$body" | tail -n1)
  json=$(printf '%s' "$body" | sed '$d')
  echo "$ts  HTTP $code  $json"
  sleep "$INTERVAL"
done
