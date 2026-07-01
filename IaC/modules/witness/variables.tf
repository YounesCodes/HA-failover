variable "project" { type = string }
variable "region" { type = string }
variable "instance_type" { type = string }
variable "vpc_cidr" { type = string }
variable "root_volume_gb" { type = number }
variable "public_key" { type = string }
variable "allowed_ssh_cidr" { type = string }
variable "tailscale_auth_key" {
  type      = string
  sensitive = true
}
variable "etcd_initial_cluster" { type = string }
variable "etcd_token" { type = string }
variable "mock_app_repo" { type = string }
variable "mock_app_subdir" { type = string }
