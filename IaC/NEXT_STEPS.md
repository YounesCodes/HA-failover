# After `terraform apply`

With `tailscale_auth_key` **and** `mock_app_repo` set, user-data does almost
everything on first boot: mounts `/data`, adds swap, installs **Docker +
Dokploy + Tailscale**, joins the mesh (MagicDNS), and brings up the stack. Nodes
address each other by MagicDNS name (`app-a1`, `app-b1`, `witness`), so the etcd
+ Patroni clusters self-assemble. How the stack is brought up depends on
`deploy_via_dokploy` (see §E).

**With `enable_cloudflare_lb = true` the load balancer is created by the same
apply, so in DNS-only mode there is nothing left to do by hand** (§A covers the
options). Everything below §A is verification + optional.

```bash
terraform output            # region_a / region_b app EIPs, witness IP
terraform output ssh_hints
```

Layout: `app-a1` + `app-b1` (each = the write-workload app + Postgres + etcd +
Patroni), `witness` (etcd vote). etcd = 3 members, majority 2. The pair
`app-a1↔app-b1` shares Patroni scope `app1`. (`app_count` > 1 adds more pairs.)

---

## A. Global load balancing (traffic routing)

A global load balancer fronts the app, health-checks `:8080/health` (green only
on the writable leader), and always serves whichever region holds the primary.
Two options, toggled in `terraform.tfvars`:

**Cloudflare Load Balancing (default, `enable_cloudflare_lb = true`).** Terraform
creates the origin pools, the health monitor, and the load balancer for you —
nothing to configure by hand in DNS-only mode. Reach the app at
`http://app1.<cloudflare_lb_domain>:8080`. For HTTPS at the edge
(`cloudflare_lb_proxied = true`), add one Cloudflare dashboard rule: an Origin
Rule rewriting the origin port to 8080, plus an SSL/TLS mode. Needs the Cloudflare
API token / account / zone set in tfvars.

**Route 53 DNS failover (alternative, `enable_route53 = true`).** Terraform creates
a hosted zone, failover records, and health checks for a delegated subdomain
(PRIMARY → app-a1 EIP, SECONDARY → app-b1 EIP, health-checked on `:8080/health`,
low TTL). The one manual step is pasting the 4 returned nameservers
(`terraform output route53_nameservers`) into your parent DNS to delegate the
subdomain.

(App EIPs come from `terraform output region_a`/`region_b`.)

## B. Verify the auto-deploy (should already be running)

```bash
ssh ubuntu@<app-a1-ip> 'tailscale status'                 # all 3 nodes present
ssh ubuntu@<app-a1-ip> 'sudo tail -n 40 /var/log/ha-bootstrap.log'   # bootstrap trace
ssh ubuntu@<app-a1-ip> 'docker ps'                        # etcd, postgres, app up
curl -s http://<app-a1-ip>:8080/api/status                # role: leader
curl -s http://<app-b1-ip>:8080/api/status                # role: replica, lag ~0
```
Open `http://<app-a1-ip>:8080` and fire some writes (the buttons on the page);
open `http://<app-b1-ip>:8080` and watch the counts appear (read-only) — that's
replication.

## C. Rehearse failover (the actual test)

Drive the workload through the load-balancer hostname; pass both node URLs so the
probe can also measure end-to-end replication lag:

```bash
node ../mock-app/probe.mjs http://app1.<domain>:8080 \
  --conc 8 --nodes http://<app-a1-ip>:8080,http://<app-b1-ip>:8080 --csv run1.csv
# kill the leader's region:
#   graceful : ssh in and `docker stop` its Postgres container   (promotes in ~3 s)
#   hard     : aws ec2 stop-instances --force <id>                (promotes in ~20 s, TTL)
#   -> Region B etcd + witness keep quorum; Patroni promotes app-b1
#   -> its /health flips to 200; the load balancer routes traffic to Region B
# Ctrl-C -> throughput, RTO per outage, EXACT RPO (no acked write lost), sync-lag p50/p95/max.
```

## D. Failback
Bring Region A back (it rejoins as standby via `reinit`/`pg_rewind`), then during
a window `patronictl switchover`; the load balancer sees A healthy again and
routes back to Region A. Manual, never automatic.

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

Each server runs its **own local Dokploy**; the script runs on both app servers. I  

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

1. **Load-balancer manual bits** — §A above. Cloudflare DNS-only: none. Cloudflare
   proxied: the Origin Rule (port 8080) + SSL mode. Route 53: the nameserver
   delegation into your parent DNS.
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
5. **TLS** (optional for a test) — the app is HTTP on 8080. For HTTPS: easiest is
   **Cloudflare edge TLS** (`cloudflare_lb_proxied = true` + the Origin Rule, §A);
   or terminate in-region at Traefik with a DNS-01 ACME challenge so the warm
   standby renews without traffic (see Architecture Report §4.7).
6. **Tailscale key — MUST be EPHEMERAL** (+ reusable, pre-approved, tagged,
   MagicDNS on). Nodes address each other by MagicDNS name (`app-a1`, `witness`).
   A **non-ephemeral** key leaves the destroyed instances' devices in the tailnet
   holding those names, so the next apply's nodes become `app-a1-1`, … and
   MagicDNS resolves to **dead** nodes → etcd can't form quorum → Postgres never
   starts. Ephemeral devices auto-remove when offline, avoiding this. **Between
   applies with a non-ephemeral key, delete the old ha-failover devices in the
   Tailscale admin console first.** To recover a live fleet that already collided:
   delete the offline devices, then on each node
   `sudo tailscale set --hostname=<clean-name>` and restart its etcd container.

---

### Teardown
```bash
terraform destroy
```
Or **stop** the instances between sessions to keep state and pay only for EBS/EIPs.

> Regions are currently `eu-north-1 ↔ eu-central-1` (~20–25 ms). Fine for the
> mock; revisit for prod so synchronous replication stays cheap (~10 ms).
