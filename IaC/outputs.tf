output "region_a" {
  description = "Region A (primary) app servers."
  value = {
    region      = var.region_a
    names       = module.region_a.app_names
    public_ips  = module.region_a.app_public_ips
    private_ips = module.region_a.app_private_ips
  }
}

output "region_b" {
  description = "Region B (warm standby) app servers."
  value = {
    region      = var.region_b
    names       = module.region_b.app_names
    public_ips  = module.region_b.app_public_ips
    private_ips = module.region_b.app_private_ips
  }
}

output "witness" {
  description = "Witness node (null when disabled)."
  value = var.enable_witness ? {
    region    = var.region_witness
    public_ip = module.witness[0].public_ip
  } : null
}

output "ssh_hints" {
  description = "Quick SSH lines (after the key pair is in your agent)."
  value = concat(
    [for ip in module.region_a.app_public_ips : "ssh ubuntu@${ip}"],
    [for ip in module.region_b.app_public_ips : "ssh ubuntu@${ip}"],
    var.enable_witness ? ["ssh ubuntu@${module.witness[0].public_ip}"] : []
  )
}
