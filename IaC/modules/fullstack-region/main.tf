data "aws_availability_zones" "available" {
  state = "available"
}

# Latest Ubuntu 24.04 LTS (Canonical) in this region, x86_64.
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd*/ubuntu-noble-24.04-amd64-server-*"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# --------------------------------------------------------------------------
# Minimal public network
# --------------------------------------------------------------------------
resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "${var.project}-${var.region_label}" }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.project}-${var.region_label}" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, 1)
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.project}-${var.region_label}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = { Name = "${var.project}-${var.region_label}-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_key_pair" "this" {
  key_name   = "${var.project}-${var.region_label}"
  public_key = var.public_key
}

# --------------------------------------------------------------------------
# Security groups
#   DB / etcd / Patroni traffic rides the Tailscale interface
#   (tailscale0), which is NOT governed by these SGs — so we only open the
#   public-facing ports here.
# --------------------------------------------------------------------------
resource "aws_security_group" "app" {
  name_prefix = "${var.project}-${var.region_label}-app-"
  vpc_id      = aws_vpc.this.id
  description = "Full-stack app server: SSH + HTTP/HTTPS public; data planes ride the mesh"

  ingress {
    description = "SSH (you / Dokploy)"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.allowed_ssh_cidr]
  }
  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.allowed_http_cidrs
  }
  ingress {
    description = "HTTPS (Dokploy Traefik)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.allowed_http_cidrs
  }
  ingress {
    description = "Mock to-do app (Route 53 health check + browser)"
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = var.allowed_http_cidrs
  }
  ingress {
    description = "Dokploy UI (restricted to your IP)"
    from_port   = 3000
    to_port     = 3000
    protocol    = "tcp"
    cidr_blocks = [var.allowed_ssh_cidr]
  }
  ingress {
    description = "Tailscale WireGuard (optional direct path; usually NAT-traversed)"
    from_port   = 41641
    to_port     = 41641
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle { create_before_destroy = true }
}

# --------------------------------------------------------------------------
# Full-stack app servers (one self-contained app each; each also runs an
# etcd member as part of its Dokploy stack)
# --------------------------------------------------------------------------
resource "aws_instance" "app" {
  count                  = var.app_count
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.app.id]
  key_name               = aws_key_pair.this.key_name

  root_block_device {
    volume_size = var.root_volume_gb
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = templatefile("${path.module}/templates/userdata.sh.tftpl", {
    hostname               = "app-${var.region_label}${count.index + 1}"
    region                 = "region-${var.region_label}"
    scope                  = "app${count.index + 1}"
    # Region A is the designated primary: every scope's primary peer is app-aN.
    primary_peer           = "app-a${count.index + 1}"
    tailscale_auth_key     = var.tailscale_auth_key
    install_dokploy        = true
    etcd_initial_cluster   = var.etcd_initial_cluster
    etcd_token             = var.etcd_token
    pg_superuser_password  = var.pg_superuser_password
    pg_repl_password       = var.pg_repl_password
    mock_app_repo          = var.mock_app_repo
    mock_app_subdir        = var.mock_app_subdir
    deploy_via_dokploy     = var.deploy_via_dokploy
    dokploy_admin_email    = var.dokploy_admin_email
    dokploy_admin_password = var.dokploy_admin_password
  })

  tags = {
    Name = "app-${var.region_label}${count.index + 1}"
    Role = var.role
    Tier = "fullstack"
  }
}

# Dedicated data volume per app server: PGDATA.
resource "aws_ebs_volume" "data" {
  count             = var.app_count
  availability_zone = aws_subnet.public.availability_zone
  size              = var.data_volume_gb
  type              = "gp3"
  iops              = 3000
  throughput        = 125
  encrypted         = true
  tags              = { Name = "app-${var.region_label}${count.index + 1}-data" }
}

resource "aws_volume_attachment" "data" {
  count       = var.app_count
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data[count.index].id
  instance_id = aws_instance.app[count.index].id
}

# Stable public address so the Route 53 failover records don't move on restart.
resource "aws_eip" "app" {
  count    = var.app_count
  domain   = "vpc"
  instance = aws_instance.app[count.index].id
  tags     = { Name = "app-${var.region_label}${count.index + 1}-eip" }
}
