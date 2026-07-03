# haload — cross-region write-workload app

A **write-heavy** app used to make cross-region **replication and failover**
both *visible* and *measurable*. It exercises many write patterns and funnels
every acknowledged write into a single append-only ledger, so failover data loss
(RPO) can be checked **exactly** and replication sync speed measured. Deploy the
same bundle to every app server; the witness runs etcd alone.

> **Why not the old to-do app?** The previous version had one write path (insert
> a todo) and checked only that the *highest* id survived. haload has eight write
> patterns and verifies that **every** acknowledged write survives — the rigorous
> RPO test — plus it measures how fast writes reach the standby.

Each app server runs **two separate Dokploy services** (like prod's app / db
cards), each its own compose file:

| Dokploy service | compose file | What | Network |
|---|---|---|---|
| `db` | `docker-compose.db.yml` | **etcd + Patroni-managed Postgres** (HA) | host (mesh, `:5432`) |
| `app` | `docker-compose.app.yml` | Node write-workload API + live dashboard | `:8080`; reaches db via host-gateway |

> Ports: **Dokploy** owns 80/443 (Traefik) + 3000 (UI); the app runs on **8080**
> so they don't clash. Browser + Route 53 health check target `:8080`.
> The witness runs `docker-compose.witness.yml` (etcd only).

### Patroni vs the built-in Dokploy Postgres resource
The `db` service is a **Compose service running Patroni** — *not* Dokploy's
built-in Postgres resource. They're mutually exclusive: Patroni must own the
Postgres process/data/config to elect a leader, promote, and fence, whereas the
built-in resource is a standalone `postgres` container Dokploy controls (no
replication/failover). So the only way to have a **Dokploy-managed, HA** Postgres
is this Compose service.

### Migrating an existing built-in Postgres → this Patroni service (prod)
1. Stand up the Patroni `db` Compose service **alongside** the current built-in
   Postgres (different port), as an empty new cluster.
2. Load your data: `pg_dump` the built-in DB → `pg_restore`/`psql` into the
   Patroni leader (or, for near-zero downtime, add the Patroni primary as a
   logical-replication subscriber to the built-in DB and let it catch up).
3. Cut over in a short window: stop writes, confirm the Patroni leader is
   caught up, repoint the app's DB host/port at the Patroni service, resume.
4. Retire the built-in Postgres resource once verified.
The app change is only the connection host/port — the schema and data are
identical, so it's a data-move + repoint, not a rewrite.

## How it shows replication working

Open `http://<server-ip>:8080` on any node. The colored banner shows the serving
**region / node**, **LEADER (writable)** vs **REPLICA (read-only)**, and the live
**replication lag**; below it are per-table counts and a live feed of recent
writes. Buttons fire each write pattern; **▶ hammer mixed** fires a rapid mixed
workload.

- On a **Region A** server (leader): fire writes — the counts and feed climb.
- On its **Region B** twin (replica): the same counts appear within the lag
  window — **that's replication** — and the write buttons are disabled (read-only).
- On **failover**, the Region B server flips to LEADER (writable), the banner
  turns green, and the load balancer sends traffic there.

The DB pair shares a Patroni scope: `app-a1+app-b1 = app1`. (Adding more app pairs via `app_count` would add `a2+b2 = app2`, etc.)

## Write patterns & the durability ledger

Every successful write — whatever its pattern — inserts one row into the
append-only **`writes`** ledger *in the same transaction* and returns a
server-assigned monotonic **`seq`** plus the post-commit WAL **`lsn`**. `seq` is
the durability token used for exact RPO checks; `lsn` lets a client time when the
write became durable on the standby.

| Pattern | Endpoint | Stresses |
|---|---|---|
| insert  | `POST /api/insert` | plain append |
| upsert  | `POST /api/kv` | `INSERT … ON CONFLICT` |
| counter | `POST /api/counter/:name` | hot-row `UPDATE` |
| ledger  | `POST /api/ledger` | txn read-modify-write (`SELECT … FOR UPDATE`) |
| doc     | `POST /api/doc` | large JSONB insert |
| batch   | `POST /api/batch` `{n}` | many rows in one txn |
| patch   | `PATCH /api/row/:id` | `UPDATE` |
| delete  | `DELETE /api/row/:id` | `DELETE` |

## Endpoints

| Method | Path | Behaviour |
|--------|------|-----------|
| `GET` | `/` | the dashboard UI |
| `GET` | `/health` | `200` only on the writable leader, else `503` (the LB probes this) |
| `GET` | `/api/status` | node, region, role, per-table counts, max seq, replication lag (native) |
| `GET` | `/api/lsn` | this node's WAL position (leader: current; replica: replayed) — for sync-lag timing |
| `POST` | `/api/write` `{kind?,client_id,client_seq}` | one write (leader only); `kind` omitted/`"mixed"` picks a random pattern |
| `POST` | `/api/verify` `{seqs:[…]}` | **exact RPO**: returns `{present, missing_count, missing[]}` for the given acked seqs |
| `GET` | `/api/feed` | recent writes (for the dashboard) |
| — | *per-pattern write endpoints* | see the table above (all leader-only) |

## Deploy

**Automatic (default):** if you set `mock_app_repo` + `tailscale_auth_key` in the
IaC, every server brings the stack up on first boot — nothing to do here. See
`../IaC/NEXT_STEPS.md`. With `deploy_via_dokploy = true` it's deployed as a
**Dokploy Compose app** (prod-faithful); run **`dokploy-verify.sh`** first to
confirm the API response shapes for your Dokploy version (NEXT_STEPS §E).

**By hand (per server):**
```bash
cp .env.example .env      # set PATRONI_NAME/ETCD_NAME/NODE_MESH_IP/PATRONI_SCOPE/REGION for THIS node
docker compose --env-file .env up -d --build         # app servers
docker compose -f docker-compose.witness.yml --env-file .env up -d   # witness
```
`NODE_MESH_IP` is the node's **Tailscale MagicDNS name** (e.g. `app-a1`), not an IP.

> First bring-up uses `ETCD_INITIAL_CLUSTER_STATE=new`. Once the cluster is
> formed, flip it to `existing` so restarts rejoin instead of re-bootstrapping.

## Verify

```bash
etcdctl member list                       # 3 members, 1 leader
patronictl -c /tmp/patroni.yml list        # per scope: A = Leader, B = Sync Standby, lag ~0
curl -s http://localhost:8080/api/status   # role: leader (A) / replica (B)
```

## Failover test (measured)

Drive the workload through the load-balancer hostname (or an app EIP), passing the
two node URLs so it can also measure end-to-end sync lag:

```bash
node probe.mjs http://app1.<domain>:8080 \
  --conc 8 --nodes http://<app-a1-ip>:8080,http://<app-b1-ip>:8080 --csv run1.csv
# then kill the leader's region:
#   graceful : docker stop <postgres container>       (Patroni releases the lock → fast promote)
#   hard     : aws ec2 stop-instances --force <id>     (TTL-bound promote — worst case)
#  -> the standby is promoted; /health flips to 200 there; the LB routes to it.
# Ctrl-C -> summary: throughput, per-kind counts, RTO per outage,
#           EXACT RPO (acked writes lost), and sync-lag percentiles.
```

What it measures:
- **RTO** — downtime per outage (gap between the last good write and the first good write after promotion).
- **RPO (exact)** — on each recovery it calls `POST /api/verify` with the **full set** of acked `seq`s and reports how many acknowledged writes did *not* survive on the new leader. Expect **0** (synchronous replication).
- **Sync speed** — *native* (`pg_stat_replication` replay_lag sampled from the leader) and, with `--nodes`, *end-to-end* (write on the leader, then poll the standby's replayed LSN until it passes the write's LSN, timed from the probe's own clock — no clock skew). Reported as p50/p95/max.

Flags: `--conc N` (concurrent writers, default 8), `--rate R` (target writes/s, default unthrottled), `--kind K` (a single pattern instead of mixed), `--duration S`, `--csv FILE`. Concurrency matters: many in-flight writes at the instant of failure is what actually stresses the zero-loss guarantee.

## Notes
- Postgres (the `writes` ledger + the pattern tables) is the only durable,
  replicated state — this test is purely about active-passive DB sync between the
  primary and standby.
- Networking uses host mode for `etcd`/`postgres` (mesh) + bridge for the `app`.
- Mock only: the app connects as the Postgres superuser to `postgres`. Not for prod.
