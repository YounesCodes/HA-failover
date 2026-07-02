# ---------------------------------------------------------------------------
# Cloudflare Load Balancing — production-style alternative to route53.tf.
#
# WHY / HOW:
#   Same active-passive failover as Route 53, but at Cloudflare's edge. Per app:
#   two origin POOLS (Region A, Region B), each with one origin (the app's EIP),
#   health-checked by a MONITOR that hits :8080/health (200 only on the writable
#   Patroni leader). A LOAD BALANCER (the hostname appN.<domain>) serves pools in
#   failover order [A, B] — A while healthy, else B. Because /health is leader-
#   only, the standby region's pool stays unhealthy, so it follows Patroni.
#
#   ACCOUNT ALIGNMENT (important): pools + monitors are ACCOUNT-scoped, the load
#   balancer is ZONE-scoped, and they MUST live in the SAME Cloudflare account.
#   So the domain (var.cloudflare_lb_domain) must be an active zone in the account
#   identified by var.cloudflare_account_id. Here: othpwn.com in the company acct.
#
#   Everything is gated behind enable_cloudflare_lb (default off), independent of
#   route53.tf — you can run both in parallel during testing.
#
# PROXIED vs DNS-ONLY (cloudflare_lb_proxied):
#   false (default) = DNS-only. Behaves like Route 53 (clients connect straight to
#     the EIP on :8080). Simplest first test; no TLS/port handling needed.
#   true = edge-proxied. Clients hit https://appN.<domain> (443); add a Cloudflare
#     Origin Rule to rewrite the origin port to 8080, and set an SSL/TLS mode. This
#     is where the edge benefits (no DNS-cache tail, moves keep-alive connections,
#     free TLS) kick in. Do the Origin Rule in the dashboard to keep the token scope
#     minimal.
# ---------------------------------------------------------------------------

variable "enable_cloudflare_lb" {
  description = "Create Cloudflare LB monitor/pools/load balancers."
  type        = bool
  default     = false
}
variable "cloudflare_api_token" {
  description = "API token: Account>Load Balancing:Monitors and Pools=Edit + Zone>Load Balancers=Edit, scoped to the zone."
  type        = string
  default     = ""
  sensitive   = true
}
variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns the zone (company account)."
  type        = string
  default     = ""
}
variable "cloudflare_zone_id" {
  description = "Zone ID of the domain used for the LB (e.g. othpwn.com)."
  type        = string
  default     = ""
}
variable "cloudflare_lb_domain" {
  description = "Domain for the LB hostnames, e.g. othpwn.com -> app1.othpwn.com."
  type        = string
  default     = ""
}
variable "cloudflare_lb_proxied" {
  description = "true = edge-proxied (needs Origin Rule for :8080 + TLS mode); false = DNS-only."
  type        = bool
  default     = false
}
variable "cloudflare_lb_app_count" {
  description = "How many app pairs to expose. 1 = 2 origins = free endpoints; 3 = 6 origins (~$20/mo)."
  type        = number
  default     = 1
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

locals {
  cf_apps = var.enable_cloudflare_lb ? {
    for i in range(var.cloudflare_lb_app_count) : "app${i + 1}" => {
      a = module.region_a.app_public_ips[i]
      b = module.region_b.app_public_ips[i]
    }
  } : {}
}

# ----- Monitor: leader-only :8080/health (shared by all pools) --------------
resource "cloudflare_load_balancer_monitor" "health" {
  count          = var.enable_cloudflare_lb ? 1 : 0
  account_id     = var.cloudflare_account_id
  type           = "http"
  method         = "GET"
  path           = "/health"
  port           = 8080
  expected_codes = "200"
  interval       = 60 # plan minimum; detection floor for this LB
  retries        = 2
  timeout        = 5
  description    = "hatest leader-only /health"
}

# ----- Pools: one per region, per app (Region A preferred) ------------------
resource "cloudflare_load_balancer_pool" "a" {
  for_each   = local.cf_apps
  account_id = var.cloudflare_account_id
  name       = "hatest-${each.key}-a"
  monitor    = cloudflare_load_balancer_monitor.health[0].id
  origins {
    name    = "${each.key}-a"
    address = each.value.a
    enabled = true
  }
}
resource "cloudflare_load_balancer_pool" "b" {
  for_each   = local.cf_apps
  account_id = var.cloudflare_account_id
  name       = "hatest-${each.key}-b"
  monitor    = cloudflare_load_balancer_monitor.health[0].id
  origins {
    name    = "${each.key}-b"
    address = each.value.b
    enabled = true
  }
}

# ----- Load balancers: hostname per app, failover order [A, B] --------------
resource "cloudflare_load_balancer" "app" {
  for_each         = local.cf_apps
  zone_id          = var.cloudflare_zone_id
  name             = "${each.key}.${var.cloudflare_lb_domain}"
  default_pool_ids = [cloudflare_load_balancer_pool.a[each.key].id, cloudflare_load_balancer_pool.b[each.key].id]
  fallback_pool_id = cloudflare_load_balancer_pool.b[each.key].id
  proxied          = var.cloudflare_lb_proxied
  steering_policy  = "off" # "off" = serve pools in default_pool_ids order (failover)
  session_affinity = "none"
  description      = "hatest ${each.key} — Region A primary, Region B failover"
}

output "cloudflare_lb_hosts" {
  description = "Cloudflare LB hostnames (DNS-only: reach on :8080; proxied: on 443)."
  value       = var.enable_cloudflare_lb ? [for k in keys(local.cf_apps) : "${k}.${var.cloudflare_lb_domain}"] : null
}
