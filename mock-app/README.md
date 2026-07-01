# CRUD to-do mock app

A small **to-do list** app used to make cross-region **replication and failover
visible**. Deploy the same bundle to every app server; the witness runs etcd alone.

Per app server (`app-a1..3`, `app-b1..3`):

| Service | What | Port / network |
|---------|------|----------------|
| `app` | Node CRUD API + live HTML UI | **8080** (bridge → host) |
| `postgres` | Postgres managed by **Patroni** (one member of its pair's cluster) | host (mesh) |
| `etcd` | one etcd quorum member | host (mesh) |
| `redis` | local Redis | bridge |

> Ports: **Dokploy** owns 80/443 (Traefik) + 3000 (UI); the mock app runs on
> **8080** so they don't clash. Browser + Route 53 health check target `:8080`.

## How it shows replication working

Open `http://<server-ip>:8080` on any node. The colored banner shows the serving
**region / node**, whether it's **LEADER (writable)** or **REPLICA (read-only)**,
the **replication lag**, and the live list.

- On a **Region A** server (leader): add / toggle / delete todos.
- On its **Region B** twin (replica): the same rows appear within the lag window
  — **that's replication** — and the form is disabled (read-only standby).
- On **failover**, the Region B server flips to LEADER (writable) and the banner
  turns green; Route 53 sends traffic there.

DB pairs share a Patroni scope: `app-a1+app-b1 = app1`, `a2+b2 = app2`, `a3+b3 = app3`.

## Endpoints

| Method | Path | Behaviour |
|--------|------|-----------|
| `GET` | `/` | the HTML UI |
| `GET` | `/health` | `200` only on the writable leader, else `503` (Route 53 probes this) |
| `GET` | `/api/status` | node, region, role, replication lag, todo count |
| `GET` | `/api/todos` | list (works on a replica — proves replication) |
| `POST` | `/api/todos` `{title}` | create (leader only; `503` on a standby) |
| `PATCH` | `/api/todos/:id` `{title?,done?}` | update (leader only) |
| `DELETE` | `/api/todos/:id` | delete (leader only) |

## Deploy

**Automatic (default):** if you set `mock_app_repo` + `tailscale_auth_key` in the
IaC, every server clones this repo, writes its own `.env`, and `docker compose up`s
on first boot — nothing to do here. See `../IaC/NEXT_STEPS.md`.

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
etcdctl member list                       # 7 members, 1 leader
patronictl -c /tmp/patroni.yml list        # per scope: A = Leader, B = Sync Standby, lag ~0
curl -s http://localhost:8080/api/status   # role: leader (A) / replica (B)
```

## Failover test (measured)

```bash
node probe.mjs http://<app1-ip>:8080 1000 run1.csv
# then kill Region A (stop app-a* or power them off)
#  -> Region B etcd members + witness keep quorum; Patroni promotes app-b{n}
#  -> their /health flips to 200; Route 53 returns the Region B record
# Ctrl-C -> summary with RTO per outage + RPO verdict (no acked todo lost).
```
The probe creates a todo each tick and, on recovery, checks the highest acked id
still exists → RTO + RPO as numbers. The CSV's `node` column shows the exact tick
traffic moved from `app-a*` to `app-b*`.

## Notes
- Redis is **per-server, not replicated** — only the Postgres `todos` table is the
  durable, replicated source of truth.
- Networking uses host mode for `etcd`/`postgres` (mesh) + bridge for `app`/`redis`.
- Mock only: the app connects as the Postgres superuser to `postgres`. Not for prod.
