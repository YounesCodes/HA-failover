# After `terraform apply`

With `tailscale_auth_key` **and** `mock_app_repo` set, user-data does almost
everything on first boot: mounts `/data`, adds swap, installs **Docker +
Dokploy + Tailscale**, joins the mesh (MagicDNS), and brings up the stack. Nodes
address each other by MagicDNS name (`app-a1`, `app-b2`, `witness`), so the etcd
+ Patroni clusters self-assemble. How the stack is brought up depends on
`deploy_via_dokploy` (see §E).

**So after apply the only required step is Route 53** (§A). Everything below §A
is verification + optional.

```bash
terraform output            # region_a / region_b app EIPs, witness IP
terraform output ssh_hints
```

Layout: `app-a1..3` + `app-b1..3` (each = to-do app + Postgres + Redis + etcd +
Patroni), `witness` (etcd vote). etcd = 7 members, majority 4. DB pairs
`app-a{n}↔app-b{n}` share Patroni scope `app{n}`.

---

## A. Configure Route 53 failover  ← the one required manual step

Route 53 can't be fully declared here because you configure it against your own
hosted zone / domain. Per app, create a record with **failover routing**:

- `app{n}.example.com` PRIMARY → `app-a{n}` EIP, SECONDARY → `app-b{n}` EIP.
- A **Route 53 health check** per target: **HTTP `GET :8080/health`**, 30 s
  interval, fail after 3. `/health` is green only on the writable leader, so the
  SECONDARY is served exactly when Patroni has promoted Region B.
- **Low record TTL (30–60 s)** — DNS caching is the failover tail (RTO).

(App EIPs come from `terraform output region_a`/`region_b`.)

## B. Verify the auto-deploy (should already be running)

```bash
ssh ubuntu@<app-a1-ip> 'tailscale status'                 # all 7 nodes present
ssh ubuntu@<app-a1-ip> 'sudo tail -n 40 /var/log/ha-bootstrap.log'   # bootstrap trace
ssh ubuntu@<app-a1-ip> 'docker ps'                        # etcd, postgres, redis, app up
curl -s http://<app-a1-ip>:8080/api/status                # role: leader
curl -s http://<app-b1-ip>:8080/api/status                # role: replica, lag ~0
```
Open `http://<app-a1-ip>:8080` and add a todo; open `http://<app-b1-ip>:8080` and
watch it appear (read-only) — that's replication.

## C. Rehearse failover (the actual test)

```bash
node ../mock-app/probe.mjs http://<app-a1-ip>:8080 1000 run1.csv
# kill Region A (stop app-a* or power them off)
#   -> Region B etcd + witness keep quorum; Patroni promotes app-b{n}
#   -> their /health flips to 200; Route 53 returns the SECONDARY record
# Ctrl-C -> RTO per outage + RPO verdict (no acked todo lost).
```

## D. Failback
Bring Region A back (it rejoins as standby via `reinit`/`pg_rewind`), then during
a window `patronictl switchover`; Route 53 sees A healthy again and serves PRIMARY.
Manual, never automatic.

## E. How the stack is brought up — `deploy_via_dokploy`

**`false` (default, most reliable):** user-data clones the repo, writes each
node's `.env`, and runs `docker compose up`. The containers are byte-identical to
what Dokploy would run; the app just isn't shown in Dokploy's UI.

**`true` (prod-faithful):** user-data installs Dokploy, then runs
`/opt/dokploy-deploy.sh`, which drives Dokploy's **headless API** (verified on
**v0.29.8 / better-auth**): `POST /api/auth/sign-up/email` + `sign-in/email`
(session cookie) → `project.create` (environmentId comes back in its response) →
`compose.create` → `compose.update` (git source = your repo, `composePath =
testing/mock-app/docker-compose.yml`, per-node env) → `compose.deploy`. It's
idempotent (find-or-create), so it's safe to re-run. The stack then appears as a
**Dokploy Compose app** in the UI — exactly like prod. App still on **8080**.

> **Repo prerequisite:** `mock_app_repo` must be a **public** git repo (Dokploy
> clones it anonymously) that actually **contains `testing/mock-app/`** on the
> `main` branch. An empty/private repo → `compose status = error`, nothing runs.

Each server runs its **own local Dokploy**; the script runs on all six.

Admin login (same on every server): `terraform output -json dokploy_admin`.
Browse `http://<ip>:3000`.

**Before trusting it (recommended), confirm the two response shapes** with the
helper — it dumps the OpenAPI field names + a live `project.all`, read-only:
```bash
# on an app server, or remotely with a token
DOK_EMAIL=<your-admin-email> DOK_PASS=$(terraform output -raw ... ) \
  ../mock-app/dokploy-verify.sh
# (remote: DOK_TOKEN=xxx ../mock-app/dokploy-verify.sh http://<ip>:3000)
```
It prints exactly where `environmentId` / `composeId` live and which two lines
to patch if they differ.

**If it doesn't converge** (Dokploy's headless path is version-sensitive):
- Logs: `/var/log/ha-bootstrap.log` and `/tmp/dok-*.json` on the server.
- Patch the two `(VERIFY)` jq paths in `/opt/dokploy-deploy.sh` per
  `dokploy-verify.sh` / `http://<ip>:3000/swagger`, then re-run
  `/opt/dokploy-deploy.sh`.
- Or set `deploy_via_dokploy = false` and re-apply for the raw-compose path.

---

## Things that are NOT IaC (do them yourself)

1. **Route 53 failover** — §A above (your zone/domain).
2. **Cluster convergence** — on first boot, if a node came up before its peers'
   MagicDNS was ready, the retry loop usually still converges. If a box isn't
   healthy after ~5 min, re-run the deploy: raw path → `cd
   /opt/mock-src/testing/mock-app && docker compose --env-file .env up -d`;
   Dokploy path → `/opt/dokploy-deploy.sh`. (Check `/var/log/ha-bootstrap.log`.)
3. **`ETCD_INITIAL_CLUSTER_STATE`** — user-data writes `new` for the initial
   bring-up. After the cluster is formed, flip it to `existing` (in each `.env`,
   or the Dokploy compose env) so a later reboot rejoins instead of re-bootstrapping.
4. **Dokploy admin** — auto-created when `deploy_via_dokploy = true` (creds via
   `terraform output -json dokploy_admin`). With the default (`false`), set the
   admin yourself at `http://<ip>:3000` if you want to use the UI — not needed
   for the failover test.
5. **TLS** (optional for a test) — the app is HTTP on 8080. For HTTPS, terminate
   in-region at Traefik with the **DNS-01 (Route 53) ACME** challenge so the warm
   standby renews without traffic (see Architecture Report §4.7).
6. **Tailscale key** — must be an ephemeral, pre-approved, tagged key with
   MagicDNS enabled on the tailnet, or the auto-deploy can't self-assemble.

---

### Teardown
```bash
terraform destroy
```
Or **stop** the instances between sessions to keep state and pay only for EBS/EIPs.

> Regions are currently `eu-north-1 ↔ eu-central-1` (~20–25 ms). Fine for the
> mock; revisit for prod so synchronous replication stays cheap (~10 ms).
