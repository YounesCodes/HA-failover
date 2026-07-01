variable "project" {
  description = "Name prefix applied to all resources and tags."
  type        = string
  default     = "geerd-ha"
}

variable "extra_tags" {
  description = "Additional tags merged into every resource."
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------------------
# Regions  (A and B must be low-latency, ~10 ms apart; witness independent)
# ---------------------------------------------------------------------------
variable "region_a" {
  description = "Primary region (active)."
  type        = string
  default     = "eu-west-3" # Paris
}

variable "region_b" {
  description = "Standby region (warm)."
  type        = string
  default     = "eu-central-1" # Frankfurt
}

variable "region_witness" {
  description = "Third, independent region for the quorum witness."
  type        = string
  default     = "eu-west-1" # Ireland
}

# ---------------------------------------------------------------------------
# Sizing
# ---------------------------------------------------------------------------
variable "app_count" {
  description = "Full-stack app servers per region (one self-contained app each)."
  type        = number
  default     = 3
}

variable "app_instance_type" {
  description = "Full-stack server type. Runs the app + Postgres + Redis + etcd + Patroni AND a local Dokploy stack, so size for RAM. t3.medium (2/4) is the floor with swap; t3.large (2/8) is comfortable."
  type        = string
  default     = "t3.medium"
}

variable "witness_instance_type" {
  description = "Witness type. etcd vote only — tiny."
  type        = string
  default     = "t3.micro"
}

variable "root_volume_gb" {
  description = "Root EBS size (GB) for every instance."
  type        = number
  default     = 30
}

variable "data_volume_gb" {
  description = "Dedicated data EBS size (GB) per app server — holds PGDATA + Redis persistence."
  type        = number
  default     = 50
}

# ---------------------------------------------------------------------------
# Witness toggle
#   true  -> Option A: Patroni + etcd quorum, automatic failover, RPO ~ 0
#   false -> Option B: plain streaming replication + scripted promotion
# ---------------------------------------------------------------------------
variable "enable_witness" {
  description = "Provision the quorum witness (Option A). Set false for the simpler streaming-replication model (Option B)."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# Access / networking
# ---------------------------------------------------------------------------
variable "public_key" {
  description = "SSH public key (contents of your .pub). A key pair is created from it in each region."
  type        = string
}

variable "allowed_ssh_cidr" {
  description = "CIDR allowed to SSH (your IP/32, or Dokploy egress). Avoid 0.0.0.0/0."
  type        = string
}

variable "allowed_http_cidrs" {
  description = "CIDRs allowed to reach 80/443. With Route 53 (DNS failover, no proxy) clients hit Traefik directly and Route 53 health checkers probe /health from public IPs, so this stays open (0.0.0.0/0)."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "tailscale_auth_key" {
  description = "Tailscale auth key for the mesh. REQUIRED for the automatic app deploy: nodes address each other by Tailscale MagicDNS name, so etcd/Patroni self-assemble at boot. Use an ephemeral, pre-approved, tagged key. Stored in user-data."
  type        = string
  default     = ""
  sensitive   = true
}

# ---------------------------------------------------------------------------
# Auto-deploy of the mock app (so only Route 53 is left after apply)
# ---------------------------------------------------------------------------
variable "mock_app_repo" {
  description = "git URL to clone on each server for auto-deploy (must contain the mock-app compose at mock_app_subdir). Leave empty to skip auto-deploy and deploy by hand."
  type        = string
  default     = ""
}

variable "mock_app_subdir" {
  description = "Path to the compose bundle inside the repo."
  type        = string
  default     = "testing/mock-app"
}

variable "etcd_token" {
  description = "etcd initial-cluster token (shared by all members)."
  type        = string
  default     = "ha-mock-etcd"
}

# Non-overlapping VPC CIDRs (overlap is harmless today since regions connect
# over the Tailscale overlay, not VPC peering — but distinct ranges keep the
# door open to peering later).
variable "vpc_cidr_a" {
  type    = string
  default = "10.10.0.0/16"
}

variable "vpc_cidr_b" {
  type    = string
  default = "10.20.0.0/16"
}

variable "vpc_cidr_witness" {
  type    = string
  default = "10.30.0.0/16"
}
