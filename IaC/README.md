# HA Failover — Terraform stack (Option A)

Provisions and **auto-deploys** the cross-region active-passive failover test on
AWS. With `tailscale_auth_key` + `mock_app_repo` set, one `terraform apply`
brings up the servers, installs Docker + Dokploy + Tailscale, and self-deploys
the full stack — leaving **only Route 53** to configure by hand.

Design docs: `../../HA_Failover_Architecture.docx`, `../../HA_Failover_Build_Plan.docx`
(those describe the Cloudflare reference design; this test uses Route 53).

## What it creates (Option A, default — `enable_witness = true`)

| Region | Resources |
|--------|-----------|
| A (primary) | 3 self-contained app servers (`app-a1..3`) |
| B (standby) | 3 self-contained app servers (`app-b1..3`) |
| Witness     | 1 etcd vote-only node (`witness`) |

= **7 instances**. Each app server is self-contained (CRUD to-do app + its own
Postgres + Redis + Patroni + etcd), with a dedicated **data EBS volume**
(`/data`) and an **Elastic IP**. etcd = 6 app members + witness = **7, majority 4**
(losing a whole region leaves 4 → promotion proceeds). DB pairs
`app-a{n}↔app-b{n}` share Patroni scope `app{n}`.

Plus, per region: a minimal VPC (public subnet + IGW), the app security group,
and a key pair from your `public_key`. Postgres passwords are generated
(`random_password`) — not stored in tfvars.

### What user-data does on first boot
mount `/data` → 2 GB swap → install **Docker** → join **Tailscale** (MagicDNS
hostname) → install **Dokploy** → (if `mock_app_repo` set) clone it, write this
node's `.env`, `docker compose up`. Nodes reach each other by MagicDNS name, so
etcd/Patroni self-assemble. Trace: `/var/log/ha-bootstrap.log`.

### Toggle
- `enable_witness = false` → **Option B** (streaming replication + scripted
  promotion, no auto quorum): drops the witness, leaving the 6 app servers.

## Ports / security model

DB / Redis / etcd / Patroni traffic rides the **Tailscale interface**, which the
SGs don't govern — those ports are never public. Security groups allow:

- **App servers**: `22` + `3000` (Dokploy UI) from `allowed_ssh_cidr`;
  `80`/`443` (Dokploy Traefik) + **`8080` (the mock app)** from `allowed_http_cidrs`.
- **Witness**: `22` only.

The mock app is on **8080** so it doesn't clash with Dokploy's 80/443/3000.
Route 53 health-checks `:8080/health`.

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
Then configure **Route 53** (see `NEXT_STEPS.md` §A) — that's the only manual step.

Tear down: `terraform destroy` (or **stop** instances between sessions — EBS persists).

## Cost note (mock profile)

24/7 in EU regions, roughly: 6×`t3.medium` + 1×`t3.micro` + EBS + EIPs.
`t3.medium` (not `t3.small`) because each box runs the app **and** a local
Dokploy stack; drop to `t3.small` if you set `mock_app_repo`/Dokploy aside.
App servers are stateful (live DB) → **not** Spot; witness stays On-Demand too.

## After apply

See **`NEXT_STEPS.md`** — §A (Route 53, the one required step) plus verification,
the failover rehearsal, and the list of things that aren't IaC.
