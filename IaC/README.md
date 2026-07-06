# HA Failover — Terraform stack (Option A)

Provisions and **auto-deploys** the cross-region active-passive failover test on
AWS. With `tailscale_auth_key` + `mock_app_repo` set, one `terraform apply`
brings up the servers, installs Docker + Dokploy + Tailscale, self-deploys the
full stack, and (with `enable_cloudflare_lb = true`) creates the **Cloudflare
load balancer** too — so there is nothing left to wire by hand in DNS-only mode.

Global load balancing has two options (see `NEXT_STEPS.md` §A):
**Cloudflare Load Balancing** (default here, `enable_cloudflare_lb = true`) or
**Route 53 DNS failover** (`enable_route53 = true`) as an alternative.

Design docs: `../../HA_Failover_Architecture.docx`, `../../HA_Failover_Build_Plan.docx`.

## What it creates (Option A, default — `enable_witness = true`)

| Region | Resources |
|--------|-----------|
| A (primary) | 1 self-contained app server (`app-a1`) |
| B (standby) | 1 self-contained app server (`app-b1`) |
| Witness     | 1 etcd vote-only node (`witness`) |

= **3 instances** (the minimal single-app topology; `app_count = 1`). Each app
server is self-contained (the write-workload app + its own Postgres + Patroni +
etcd), with a dedicated **data EBS volume** (`/data`) and an **Elastic IP**.
etcd = 2 app members + witness = **3, majority 2** (losing a whole region leaves
2 → promotion proceeds; the witness is what keeps quorum when one region is
gone). The pair `app-a1↔app-b1` shares Patroni scope `app1`. Set `app_count`
higher to add more independent app pairs (`app-a2↔app-b2 = app2`, …).

Plus, per region: a minimal VPC (public subnet + IGW), the app security group,
and a key pair from your `public_key`. Postgres passwords are generated
(`random_password`) — not stored in tfvars.

### What user-data does on first boot
mount `/data` → 2 GB swap → install **Docker** → join **Tailscale** (MagicDNS
hostname) → install **Dokploy** → bring up the stack. Nodes reach each other by
MagicDNS name, so etcd/Patroni self-assemble. Trace: `/var/log/ha-bootstrap.log`.

The bring-up depends on `deploy_via_dokploy`:
- **`false`** (default): raw `docker compose up` of the repo (reliable).
- **`true`**: deploys the stack as a **Dokploy Compose app** via Dokploy's
  headless API (prod-faithful, managed in the UI). Rides version-sensitive
  endpoints — see `NEXT_STEPS.md` §E. App stays on 8080 either way.

### Toggles
- `enable_witness = false` → **Option B** (streaming replication + scripted
  promotion, no auto quorum): drops the witness, leaving the 2 app servers.
- `deploy_via_dokploy = true` → deploy through Dokploy instead of raw compose.

## Ports / security model

DB / etcd / Patroni traffic rides the **Tailscale interface**, which the
SGs don't govern — those ports are never public. Security groups allow:

- **App servers**: `22` + `3000` (Dokploy UI) from `allowed_ssh_cidr`;
  `80`/`443` (Dokploy Traefik) + **`8080` (the mock app)** from `allowed_http_cidrs`.
- **Witness**: `22` only.

The mock app is on **8080** so it doesn't clash with Dokploy's 80/443/3000.
The load balancer (Cloudflare or Route 53) health-checks `:8080/health`.

## Prerequisites

- Terraform ≥ 1.5, AWS provider ~> 6.0, random ~> 3.6
- AWS credentials with EC2/VPC permissions in all three regions
- An SSH public key
- A **Tailscale auth key** (ephemeral, pre-approved, tagged; MagicDNS on) — required for auto-assembly
- A **git repo** containing `testing/mock-app` for `mock_app_repo` (auto-deploy)

## Usage

```bash
cd IaC
cp terraform.tfvars.example terraform.tfvars   # set public_key, allowed_ssh_cidr,
                                               # tailscale_auth_key, mock_app_repo
terraform init
terraform apply
terraform output
```
With `enable_cloudflare_lb = true` (+ the Cloudflare token/zone in tfvars) the load
balancer is created by this apply — no manual step in DNS-only mode. See
`NEXT_STEPS.md` §A for the Cloudflare/Route 53 options.

Tear down: `terraform destroy` (or **stop** instances between sessions — EBS persists).

## Cost note (mock profile)

24/7 in EU regions, roughly: 2×`t3.medium` + 1×`t3.micro` + EBS + EIPs.
`t3.medium` (not `t3.small`) because each box runs the app **and** a local
Dokploy stack; drop to `t3.small` if you set `mock_app_repo`/Dokploy aside.
App servers are stateful (live DB) → **not** Spot; witness stays On-Demand too.

## After apply

See **`NEXT_STEPS.md`** — §A (global load balancing: Cloudflare / Route 53) plus
verification, the failover rehearsal, and the list of things that aren't IaC.
