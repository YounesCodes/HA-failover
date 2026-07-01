scope: ${PATRONI_SCOPE}
name: ${PATRONI_NAME}

restapi:
  listen: 0.0.0.0:8008
  connect_address: ${NODE_MESH_IP}:8008

etcd3:
  hosts: ${ETCD3_HOSTS}

bootstrap:
  dcs:
    ttl: 30
    loop_wait: 10
    retry_timeout: 10
    maximum_lag_on_failover: 1048576
    # RPO ~ 0 in normal operation; non-strict so the primary degrades to async
    # (instead of blocking writes) if its standby is lost.
    synchronous_mode: true
    synchronous_node_count: 1
    postgresql:
      use_pg_rewind: true
      parameters:
        synchronous_commit: "on"
        wal_level: replica
        hot_standby: "on"
        max_wal_senders: 10
        max_replication_slots: 10
  initdb:
    - encoding: UTF8
    - data-checksums
  # Applied at initdb. Allow the standby (replicator) + apps to connect over the
  # mesh. DB ports aren't publicly exposed (not in the SG), so 0.0.0.0/0 here
  # just means "any mesh peer".
  pg_hba:
    - local all all trust
    - host replication ${PG_REPL_USER} 0.0.0.0/0 md5
    - host all all 0.0.0.0/0 md5

postgresql:
  listen: 0.0.0.0:5432
  connect_address: ${NODE_MESH_IP}:5432
  data_dir: ${PATRONI_POSTGRESQL_DATA_DIR}
  pgpass: /tmp/pgpass
  authentication:
    superuser:
      username: ${PG_SUPERUSER}
      password: ${PG_SUPERUSER_PASSWORD}
    replication:
      username: ${PG_REPL_USER}
      password: ${PG_REPL_PASSWORD}
  # Runtime pg_hba (reapplied on reload) — same rules as bootstrap so a standby
  # rebuilt via pg_basebackup keeps accepting replication.
  pg_hba:
    - local all all trust
    - host replication ${PG_REPL_USER} 0.0.0.0/0 md5
    - host all all 0.0.0.0/0 md5
  parameters:
    unix_socket_directories: /var/run/postgresql

tags:
  # Region A is primary by default: A nodes render 100, B nodes render 1.
  # Higher wins a leader election among equals; it never demotes a live leader.
  failover_priority: ${PATRONI_FAILOVER_PRIORITY}
  nofailover: false
  noloadbalance: false
  clonefrom: false
  nosync: false
