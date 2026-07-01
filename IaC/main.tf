locals {
  common_tags = merge({
    Project   = var.project
    ManagedBy = "terraform"
    Stack     = "ha-failover"
  }, var.extra_tags)

  # All etcd members, addressed by Tailscale MagicDNS name (deterministic at
  # boot). Every app server runs a member; the witness is the tie-breaker.
  app_nodes = concat(
    [for i in range(var.app_count) : "app-a${i + 1}"],
    [for i in range(var.app_count) : "app-b${i + 1}"],
  )
  etcd_members         = var.enable_witness ? concat(local.app_nodes, ["witness"]) : local.app_nodes
  etcd_initial_cluster = join(",", [for n in local.etcd_members : "${n}=http://${n}:2380"])
}

# Postgres credentials — generated, not stored in tfvars. Same across the fleet
# (simplest for the test; each pair only needs matching creds).
resource "random_password" "pg_super" {
  length  = 20
  special = false
}
resource "random_password" "pg_repl" {
  length  = 20
  special = false
}
resource "random_password" "dokploy_admin" {
  length  = 20
  special = false
}

# ----- Region A: primary, 3 self-contained app servers ---------------------
module "region_a" {
  source = "./modules/fullstack-region"
  providers = {
    aws = aws.region_a
  }

  project                = var.project
  region                 = var.region_a
  region_label           = "a"
  role                   = "primary"
  app_count              = var.app_count
  instance_type          = var.app_instance_type
  vpc_cidr               = var.vpc_cidr_a
  root_volume_gb         = var.root_volume_gb
  data_volume_gb         = var.data_volume_gb
  public_key             = var.public_key
  allowed_ssh_cidr       = var.allowed_ssh_cidr
  allowed_http_cidrs     = var.allowed_http_cidrs
  tailscale_auth_key     = var.tailscale_auth_key
  etcd_initial_cluster   = local.etcd_initial_cluster
  etcd_token             = var.etcd_token
  pg_superuser_password  = random_password.pg_super.result
  pg_repl_password       = random_password.pg_repl.result
  mock_app_repo          = var.mock_app_repo
  mock_app_subdir        = var.mock_app_subdir
  deploy_via_dokploy     = var.deploy_via_dokploy
  dokploy_admin_email    = var.dokploy_admin_email
  dokploy_admin_password = random_password.dokploy_admin.result
}

# ----- Region B: warm standby, 3 self-contained app servers ----------------
module "region_b" {
  source = "./modules/fullstack-region"
  providers = {
    aws = aws.region_b
  }

  project                = var.project
  region                 = var.region_b
  region_label           = "b"
  role                   = "standby"
  app_count              = var.app_count
  instance_type          = var.app_instance_type
  vpc_cidr               = var.vpc_cidr_b
  root_volume_gb         = var.root_volume_gb
  data_volume_gb         = var.data_volume_gb
  public_key             = var.public_key
  allowed_ssh_cidr       = var.allowed_ssh_cidr
  allowed_http_cidrs     = var.allowed_http_cidrs
  tailscale_auth_key     = var.tailscale_auth_key
  etcd_initial_cluster   = local.etcd_initial_cluster
  etcd_token             = var.etcd_token
  pg_superuser_password  = random_password.pg_super.result
  pg_repl_password       = random_password.pg_repl.result
  mock_app_repo          = var.mock_app_repo
  mock_app_subdir        = var.mock_app_subdir
  deploy_via_dokploy     = var.deploy_via_dokploy
  dokploy_admin_email    = var.dokploy_admin_email
  dokploy_admin_password = random_password.dokploy_admin.result
}

# ----- Witness: single etcd vote in a third region (Option A) --------------
module "witness" {
  count  = var.enable_witness ? 1 : 0
  source = "./modules/witness"
  providers = {
    aws = aws.witness
  }

  project              = var.project
  region               = var.region_witness
  instance_type        = var.witness_instance_type
  vpc_cidr             = var.vpc_cidr_witness
  root_volume_gb       = 20
  public_key           = var.public_key
  allowed_ssh_cidr     = var.allowed_ssh_cidr
  tailscale_auth_key   = var.tailscale_auth_key
  etcd_initial_cluster = local.etcd_initial_cluster
  etcd_token           = var.etcd_token
  mock_app_repo        = var.mock_app_repo
  mock_app_subdir      = var.mock_app_subdir
}
