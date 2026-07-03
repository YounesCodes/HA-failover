#!/usr/bin/env bash
# Simple shell driver for the haload app during a failover test. This is the
# minimal, dependency-free alternative to probe.mjs (which does concurrency,
# exact RPO verification, and sync-lag percentiles — prefer it for real runs).
#
#   ./loadtest.sh https://app1.example.com [intervalSeconds] [kind]
#
# Writes one record per tick via POST /api/write and prints the result. On
# failover you'll see a gap (RTO) then writes resume on the promoted region.
# Afterwards, POST /api/verify with the seqs you saw (or just eyeball the last
# seq before the gap) on the new leader to confirm it survived (RPO = 0).
set -uo pipefail

BASE="${1:?usage: loadtest.sh <base-url> [intervalSeconds] [kind]}"
INTERVAL="${2:-1}"
KIND="${3:-mixed}"
CLIENT="loadtest-$$"
seq=0

echo "writing to $BASE every ${INTERVAL}s (kind=$KIND) — Ctrl-C to stop"
while true; do
  seq=$((seq + 1))
  ts=$(date -u +%H:%M:%S)
  body=$(curl -s -m 4 -o - -w '\n%{http_code}' -X POST -H 'content-type: application/json' \
    -d "{\"kind\":\"$KIND\",\"client_id\":\"$CLIENT\",\"client_seq\":$seq}" "$BASE/api/write" || echo $'\n000')
  code=$(printf '%s' "$body" | tail -n1)
  json=$(printf '%s' "$body" | sed '$d')
  echo "$ts  HTTP $code  $json"
  sleep "$INTERVAL"
done
