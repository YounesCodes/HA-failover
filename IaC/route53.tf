# ---------------------------------------------------------------------------
# Route 53 DNS failover for the HA test.
#
# WHY THIS IS SELF-CONTAINED & OPTIONAL:
#   Your domain example.com is registered at Namecheap with nameservers
#   pointed at Cloudflare — Cloudflare is authoritative. We do NOT move it.
#   Instead we create a Route 53 *public hosted zone* for a delegated
#   subdomain (default: aws.example.com) and put the failover records there.
#   Everything is gated behind `enable_route53` so a normal apply is unaffected
#   until you opt in.
#
# THE ONE MANUAL STEP (in Cloudflare, once):
#   After `terraform apply`, run `terraform output route53_nameservers` and add
#   4 `NS` records in the example.com Cloudflare zone, all named `aws`, one per
#   nameserver. That delegates *.aws.example.com to Route 53. Nothing changes
#   at Namecheap.
#
# HOW FAILOVER WORKS:
#   Per app, one name (app1.aws.example.com) has a PRIMARY record -> Region A
#   EIP and a SECONDARY record -> Region B EIP. Each is tied to a Route 53 health
#   check that probes HTTP :8080/health. /health returns 200 ONLY on the writable
#   Patroni leader (503 on a read-only standby), so the record served always
#   follows wherever Patroni's leader currently is. Failback is manual (Route 53
#   only serves PRIMARY again once app-a is writable again, i.e. after a
#   `patronictl switchover`) — matching the sticky failover policy.
# ---------------------------------------------------------------------------

variable "enable_route53" {
  description = "Create the Route 53 hosted zone + failover records. Requires dns_zone_name."
  type        = bool
  default     = false
}

variable "dns_zone_name" {
  description = "Subdomain delegated to Route 53, e.g. aws.example.com. One record per app: with the single-app topology that is just app1.<this>."
  type        = string
  default     = ""
}

variable "dns_ttl" {
  description = "Record TTL in seconds. This is the DNS-caching tail of the failover RTO — keep it low."
  type        = number
  default     = 30
}

locals {
  # One entry per app pair (app1..appN): the PRIMARY (Region A) and SECONDARY
  # (Region B) public EIPs. Empty when Route 53 is disabled -> zero resources.
  r53_apps = var.enable_route53 ? {
    for i in range(var.app_count) : "app${i + 1}" => {
      primary_ip   = module.region_a.app_public_ips[i]
      secondary_ip = module.region_b.app_public_ips[i]
    }
  } : {}
}

# Public hosted zone for the delegated subdomain. Route 53 hands back the 4
# nameservers (see the route53_nameservers output) to paste into Cloudflare.
resource "aws_route53_zone" "ha" {
  count    = var.enable_route53 ? 1 : 0
  provider = aws.region_a # Route 53 is global; provider region is irrelevant.
  name     = var.dns_zone_name

  tags = merge(local.common_tags, { Name = var.dns_zone_name })
}

# ----- Health checks: HTTP GET :8080/health per target ----------------------
# Green only on the writable leader. Route 53's health checkers hit the public
# EIP on 8080, so allowed_http_cidrs must include 0.0.0.0/0 (the default) or the
# AWS health-checker ranges, else checks fail and both records look unhealthy.
resource "aws_route53_health_check" "primary" {
  for_each          = local.r53_apps
  provider          = aws.region_a
  ip_address        = each.value.primary_ip
  port              = 8080
  type              = "HTTP"
  resource_path     = "/health"
  request_interval  = 10
  failure_threshold = 3

  tags = merge(local.common_tags, { Name = "${var.project}-${each.key}-primary-a" })
}

resource "aws_route53_health_check" "secondary" {
  for_each          = local.r53_apps
  provider          = aws.region_a
  ip_address        = each.value.secondary_ip
  port              = 8080
  type              = "HTTP"
  resource_path     = "/health"
  request_interval  = 10
  failure_threshold = 3

  tags = merge(local.common_tags, { Name = "${var.project}-${each.key}-secondary-b" })
}

# ----- Failover records: PRIMARY -> Region A, SECONDARY -> Region B ---------
resource "aws_route53_record" "primary" {
  for_each       = local.r53_apps
  provider       = aws.region_a
  zone_id        = aws_route53_zone.ha[0].zone_id
  name           = "${each.key}.${var.dns_zone_name}"
  type           = "A"
  ttl            = var.dns_ttl
  set_identifier = "primary-a"
  records        = [each.value.primary_ip]

  failover_routing_policy {
    type = "PRIMARY"
  }

  health_check_id = aws_route53_health_check.primary[each.key].id
}

resource "aws_route53_record" "secondary" {
  for_each       = local.r53_apps
  provider       = aws.region_a
  zone_id        = aws_route53_zone.ha[0].zone_id
  name           = "${each.key}.${var.dns_zone_name}"
  type           = "A"
  ttl            = var.dns_ttl
  set_identifier = "secondary-b"
  records        = [each.value.secondary_ip]

  failover_routing_policy {
    type = "SECONDARY"
  }

  # Health-checked too: if BOTH regions are down, Route 53 returns nothing
  # rather than handing out a dead B address.
  health_check_id = aws_route53_health_check.secondary[each.key].id
}

# ----- Outputs --------------------------------------------------------------
output "route53_nameservers" {
  description = "Paste these into Cloudflare as 4 NS records named 'aws' on example.com to delegate the subdomain."
  value       = var.enable_route53 ? aws_route53_zone.ha[0].name_servers : null
}

output "route53_app_urls" {
  description = "Failover URLs once DNS has propagated."
  value       = var.enable_route53 ? [for k in keys(local.r53_apps) : "http://${k}.${var.dns_zone_name}:8080"] : null
}
