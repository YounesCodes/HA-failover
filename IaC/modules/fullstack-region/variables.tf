variable "project" { type = string }
variable "region" { type = string }
variable "region_label" {
  description = "Short region tag used in names: a, b, ..."
  type        = string
}
variable "role" {
  description = "primary | standby"
  type        = string
}
variable "app_count" { type = number }
variable "instance_type" { type = string }
variable "vpc_cidr" { type = string }
variable "root_volume_gb" { type = number }
variable "data_volume_gb" { type = number }
variable "public_key" { type = string }
variable "allowed_ssh_cidr" { type = string }
variable "allowed_http_cidrs" { type = list(string) }
variable "tailscale_auth_key" {
  type      = string
  sensitive = true
}
variable "etcd_initial_cluster" { type = string }
variable "etcd_token" { type = string }
variable "pg_superuser_password" {
  type      = string
  sensitive = true
}
variable "pg_repl_password" {
  type      = string
  sensitive = true
}
variable "mock_app_repo" { type = string }
variable "mock_app_subdir" { type = string }
variable "deploy_via_dokploy" { type = bool }
variable "dokploy_admin_email" { type = string }
variable "dokploy_admin_password" {
  type      = string
  sensitive = true
}
