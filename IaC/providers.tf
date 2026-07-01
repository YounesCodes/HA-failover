# Three aliased providers — one per region.
# Region A (primary) and Region B (standby) host the full-stack app servers;
# the witness lives in a third, independent region so it fails independently.

provider "aws" {
  alias  = "region_a"
  region = var.region_a

  default_tags {
    tags = local.common_tags
  }
}

provider "aws" {
  alias  = "region_b"
  region = var.region_b

  default_tags {
    tags = local.common_tags
  }
}

provider "aws" {
  alias  = "witness"
  region = var.region_witness

  default_tags {
    tags = local.common_tags
  }
}
