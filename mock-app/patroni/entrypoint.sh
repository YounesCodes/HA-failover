#!/usr/bin/env bash
set -euo pipefail

: "${PATRONI_POSTGRESQL_DATA_DIR:=/data/pgdata}"
: "${PATRONI_NAME:=}"
: "${PRIMARY_PEER:=}"        # Patroni name of the designated primary-region peer for this scope (e.g. app-a1)
: "${BOOTSTRAP_WAIT:=120}"   # max seconds a standby-region node waits for the primary on a COLD start

# The EBS mount is root-owned. Patroni runs as `postgres` and must be able to
# CREATE and RENAME its data dir (e.g. -> pgdata.failed on a failed bootstrap),
# which needs write on the PARENT dir too — so chown the parent, not just PGDATA.
PARENT=$(dirname "$PATRONI_POSTGRESQL_DATA_DIR")
mkdir -p "$PATRONI_POSTGRESQL_DATA_DIR"
chown postgres:postgres "$PARENT"
chown -R postgres:postgres "$PATRONI_POSTGRESQL_DATA_DIR"
chmod 700 "$PATRONI_POSTGRESQL_DATA_DIR"

# Region A is primary by default. The node whose name == PRIMARY_PEER IS the
# designated primary; it gets the higher failover priority, the standby region a
# lower one. With 2-node scopes priority only breaks a tie when BOTH nodes race
# from a cold start — it never demotes a healthy leader (Patroni does not
# auto-fail-back), so once B takes over it stays primary until it dies.
if [ -n "$PRIMARY_PEER" ] && [ "$PATRONI_NAME" = "$PRIMARY_PEER" ]; then
  IS_PRIMARY_REGION=true
  PATRONI_FAILOVER_PRIORITY=100
else
  IS_PRIMARY_REGION=false
  PATRONI_FAILOVER_PRIORITY=1
fi
export PATRONI_FAILOVER_PRIORITY

# Render the config from env (only our known vars, so $ in params is left alone).
envsubst '$PATRONI_SCOPE $PATRONI_NAME $NODE_MESH_IP $ETCD3_HOSTS $PATRONI_POSTGRESQL_DATA_DIR $PG_SUPERUSER $PG_SUPERUSER_PASSWORD $PG_REPL_USER $PG_REPL_PASSWORD $PATRONI_FAILOVER_PRIORITY' \
  < /patroni.yml.tpl > /tmp/patroni.yml

# --- Deterministic "Region A is primary by default" on a COLD bootstrap -------
# Only when this is a standby-region node AND its data dir has never been
# initialised (no PG_VERSION). Wait for the primary-region peer to take the
# leader lock so it becomes the initial primary. We DELIBERATELY skip this once
# the node has data: delaying a restart could let the leader lock expire and get
# handed to the peer, which would break the "whoever is primary stays primary"
# rule. The timeout is a fallback so B still bootstraps if region A is genuinely
# down at provision time.
if [ "$IS_PRIMARY_REGION" != "true" ] && [ -n "$PRIMARY_PEER" ] && [ ! -s "$PATRONI_POSTGRESQL_DATA_DIR/PG_VERSION" ]; then
  echo "[entrypoint] standby-region cold start: waiting up to ${BOOTSTRAP_WAIT}s for primary peer '$PRIMARY_PEER' to lead"
  deadline=$(( $(date +%s) + BOOTSTRAP_WAIT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if python3 - "$PRIMARY_PEER" <<'PY'
import sys, urllib.request
try:
    with urllib.request.urlopen("http://%s:8008/primary" % sys.argv[1], timeout=3) as r:
        sys.exit(0 if r.status == 200 else 1)
except Exception:
    sys.exit(1)
PY
    then
      echo "[entrypoint] primary peer '$PRIMARY_PEER' is leading — joining as replica"
      break
    fi
    sleep 3
  done
fi

exec gosu postgres patroni /tmp/patroni.yml
