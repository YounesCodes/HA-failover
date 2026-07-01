# After `terraform apply`

With `tailscale_auth_key` **and** `mock_app_repo` set, user-data does almost
everything on first boot: mounts `/data`, adds swap, installs **Docker +
Dokploy + Tailscale**, joins the mesh (MagicDNS), clones the repo, writes each
node's `.env`, and `docker compose up`s the stack. Nodes address each other by
MagicDNS name (`app-a1`, `app-b2`, `witness`), so the etcd + Patroni clusters
self-assemble.

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

---

## Things that are NOT IaC (do them yourself)

1. **Route 53 failover** — §A above (your zone/domain).
2. **Cluster convergence** — on first boot, if a node came up before its peers'
   MagicDNS was ready, the compose retry loop usually still converges. If a box
   isn't healthy after ~5 min: `ssh` in, `cd /opt/mock-src/testing/mock-app &&
   docker compose --env-file .env up -d`. (Check `/var/log/ha-bootstrap.log`.)
3. **`ETCD_INITIAL_CLUSTER_STATE`** — user-data writes `new` for the initial
   bring-up. After the cluster is formed, edit each `.env` to `existing` so a
   later reboot rejoins instead of trying to re-bootstrap.
4. **Dokploy first-run** — browse `http://<ip>:3000` to set the admin user. Not
   needed for the failover test (the app runs via compose on 8080, independent of
   Dokploy); it's installed for parity only.
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
