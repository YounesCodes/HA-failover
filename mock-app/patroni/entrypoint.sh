#!/usr/bin/env bash
set -euo pipefail

: "${PATRONI_POSTGRESQL_DATA_DIR:=/data/pgdata}"

# The EBS mount is root-owned. Patroni runs as `postgres` and must be able to
# CREATE and RENAME its data dir (e.g. -> pgdata.failed on a failed bootstrap),
# which needs write on the PARENT dir too — so chown the parent, not just PGDATA.
PARENT=$(dirname "$PATRONI_POSTGRESQL_DATA_DIR")
mkdir -p "$PATRONI_POSTGRESQL_DATA_DIR"
chown postgres:postgres "$PARENT"
chown -R postgres:postgres "$PATRONI_POSTGRESQL_DATA_DIR"
chmod 700 "$PATRONI_POSTGRESQL_DATA_DIR"

# Render the config from env (only our known vars, so $ in params is left alone).
envsubst '$PATRONI_SCOPE $PATRONI_NAME $NODE_MESH_IP $ETCD3_HOSTS $PATRONI_POSTGRESQL_DATA_DIR $PG_SUPERUSER $PG_SUPERUSER_PASSWORD $PG_REPL_USER $PG_REPL_PASSWORD' \
  < /patroni.yml.tpl > /tmp/patroni.yml

exec gosu postgres patroni /tmp/patroni.yml
