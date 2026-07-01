#!/usr/bin/env bash
set -euo pipefail

: "${PATRONI_POSTGRESQL_DATA_DIR:=/data/pgdata}"

# Own only our own PGDATA subdir (etcd/redis use sibling dirs under /data).
mkdir -p "$PATRONI_POSTGRESQL_DATA_DIR"
chown -R postgres:postgres "$PATRONI_POSTGRESQL_DATA_DIR"
chmod 700 "$PATRONI_POSTGRESQL_DATA_DIR"

# Render the config from env (only our known vars, so $ in params is left alone).
envsubst '$PATRONI_SCOPE $PATRONI_NAME $NODE_MESH_IP $ETCD3_HOSTS $PATRONI_POSTGRESQL_DATA_DIR $PG_SUPERUSER $PG_SUPERUSER_PASSWORD $PG_REPL_USER $PG_REPL_PASSWORD' \
  < /patroni.yml.tpl > /tmp/patroni.yml

exec gosu postgres patroni /tmp/patroni.yml
