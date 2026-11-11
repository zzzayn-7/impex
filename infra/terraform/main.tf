# Impex on AWS. Four modules, each one job:
#   network   VPC, subnet, the fixed public address, the firewall (only the two HTTPS portal ports are open; no SSH)
#   security  the KMS key for the secrets, and the server's identity (Session Manager + its own parameters, nothing else)
#   config    SSM Parameter Store: the .env, the generated secrets, the front-door password, the deploy command
#   server    the EC2 instance, the data disk (databases + logos) and its daily snapshots
# The server runs the same Docker Compose stack as local development, plus the "edge" (docker-compose.aws.yml): HTTPS and a password in front of both portals.

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name       = "impex-${var.environment}"
  ssm_prefix = "/impex/${var.environment}"
  az         = data.aws_availability_zones.available.names[0]
  # The edge listens on 443 (Super Admin portal), 3001 (Organization portal) and 8025 (Mailpit, the mailbox of the platform's e-mails), all over HTTPS.
  portal_ports = [443, 3001, 8025]
}

module "network" {
  source = "./modules/network"

  name              = local.name
  availability_zone = local.az
  ingress_ports     = local.portal_ports
  allowed_cidrs     = var.allowed_cidrs
}

module "security" {
  source = "./modules/security"

  name        = local.name
  environment = var.environment
  region      = var.aws_region
  ssm_prefix  = local.ssm_prefix
}

module "config" {
  source = "./modules/config"

  name            = local.name
  ssm_prefix      = local.ssm_prefix
  kms_key_id      = module.security.kms_key_id
  public_host     = module.network.public_ip
  repo_url        = var.repo_url
  repo_branch     = var.repo_branch
  basic_auth_user = var.basic_auth_user
}

module "server" {
  source = "./modules/server"

  name                    = local.name
  region                  = var.aws_region
  availability_zone       = local.az
  ssm_prefix              = local.ssm_prefix
  instance_type           = var.instance_type
  root_volume_gb          = var.root_volume_gb
  data_volume_gb          = var.data_volume_gb
  snapshot_retention_days = var.snapshot_retention_days
  termination_protection  = var.termination_protection
  subnet_id               = module.network.subnet_id
  security_group_id       = module.network.security_group_id
  instance_profile_name   = module.security.instance_profile_name
  eip_allocation_id       = module.network.eip_allocation_id

  # The first boot reads the parameters and needs the route to the internet, so both must exist before the server does.
  depends_on = [module.config, module.network, module.security]
}
