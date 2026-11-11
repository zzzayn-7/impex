# CONFIGURATION LIVES IN SSM PARAMETER STORE (encrypted with the security module's key). Every parameter under  <prefix>/env/  becomes one line of the server's
# .env file at deploy time (the parameter's NAME is the variable name). Four kinds:
#   * plain settings (URLs, ports, flags)               String, managed here
#   * secrets (passwords, keys)                         SecureString, generated here once; rotate them in SSM, never here
#   * settings only YOU can supply (e-mail ...)         created with the value __SET_ME__; you set them in SSM and Terraform never overwrites them.
#                                                       A parameter that still says __SET_ME__ is left out of the .env, so Compose falls back to its default.
#   * the front door's password   <prefix>/edge/*       the user name and the generated password that protect BOTH portals (HTTP basic authentication at the edge,
#                                                       before the portals' own sign-in). It is not written to the .env: the deploy script turns it into a hash.
# After changing a parameter, run the deploy command (an output of the root module). The repository settings live under <prefix>/deploy/.

locals {
  public_url = "https://${var.public_host}"

  plain = {
    PUBLIC_HOST                   = var.public_host
    POSTGRES_USER                 = "impex_admin"
    NEXT_PUBLIC_API_GATEWAY_URL   = local.public_url
    APP_BASE_URL                  = local.public_url
    TENANT_PORTAL_URL             = "${local.public_url}:3001"
    SUPER_ADMIN_PORTAL_URL        = local.public_url
    DEMO_MODE                     = "false"
    SMTP_PORT                     = "587"
    SMTP_STARTTLS                 = "true"
    SMTP_SSL                      = "false"
    SMTP_FROM_NAME                = "Impex"
    FINANCE_SYNC_ENABLED          = "true"
    FINANCE_SYNC_INTERVAL_SECONDS = "15"
  }

  secrets = toset([
    "POSTGRES_PASSWORD",
    "AUTH_SECRET_KEY",
    "AUTH_INTERNAL_API_KEY",
    "ORG_ACTIVATION_API_KEY",
    "MODULE_INTERNAL_API_KEY",
    "RESERVATION_API_KEY",
    "PURGE_API_KEY",
  ])

  # name => whether it is a secret. Set these in SSM (console or `aws ssm put-parameter --overwrite`).
  to_fill = {
    SMTP_HOST                  = false
    SMTP_USERNAME              = false
    SMTP_PASSWORD              = true
    SMTP_FROM_ADDRESS          = false
    SUPPORT_NOTIFICATION_EMAIL = false
  }
}

resource "aws_ssm_parameter" "env_plain" {
  for_each = local.plain

  name  = "${var.ssm_prefix}/env/${each.key}"
  type  = "String"
  value = each.value
}

# Letters and digits only: they go into a .env file and into URLs, so no character may need escaping.
resource "random_password" "secret" {
  for_each = local.secrets

  length  = 48
  special = false
}

resource "aws_ssm_parameter" "env_secret" {
  for_each = local.secrets

  name   = "${var.ssm_prefix}/env/${each.key}"
  type   = "SecureString"
  key_id = var.kms_key_id
  value  = random_password.secret[each.key].result

  lifecycle {
    ignore_changes = [value] # rotate in SSM (and redeploy), not here
  }
}

resource "aws_ssm_parameter" "env_to_fill" {
  for_each = local.to_fill

  name   = "${var.ssm_prefix}/env/${each.key}"
  type   = each.value ? "SecureString" : "String"
  key_id = each.value ? var.kms_key_id : null
  value  = "__SET_ME__"

  lifecycle {
    ignore_changes = [value] # yours: Terraform never overwrites what you set
  }
}

# The front door: one user name and a strong generated password for both portals.
resource "random_password" "edge" {
  length  = 32
  special = false
}

resource "aws_ssm_parameter" "edge_user" {
  name  = "${var.ssm_prefix}/edge/BASIC_AUTH_USER"
  type  = "String"
  value = var.basic_auth_user
}

resource "aws_ssm_parameter" "edge_password" {
  name   = "${var.ssm_prefix}/edge/BASIC_AUTH_PASSWORD"
  type   = "SecureString"
  key_id = var.kms_key_id
  value  = random_password.edge.result

  lifecycle {
    ignore_changes = [value] # change it in SSM, then deploy
  }
}

# Where the server gets the code from. GITHUB_TOKEN is only needed if the repository is private (a fine-grained token with read access to "Contents").
resource "aws_ssm_parameter" "deploy" {
  for_each = {
    REPO_URL     = { type = "String", value = var.repo_url }
    REPO_BRANCH  = { type = "String", value = var.repo_branch }
    GITHUB_TOKEN = { type = "SecureString", value = "__SET_ME__" }
  }

  name   = "${var.ssm_prefix}/deploy/${each.key}"
  type   = each.value.type
  key_id = each.value.type == "SecureString" ? var.kms_key_id : null
  value  = each.value.value

  lifecycle {
    ignore_changes = [value]
  }
}

# One command that redeploys the server: pulls the branch, rebuilds, applies pending database migrations (Compose runs the one-shot migration containers first) and restarts.
resource "aws_ssm_document" "deploy" {
  name            = "${var.name}-deploy"
  document_type   = "Command"
  document_format = "YAML"

  content = <<-YAML
    schemaVersion: "2.2"
    description: "Deploy Impex: pull the branch, read the SSM configuration, docker compose up --build"
    mainSteps:
      - action: aws:runShellScript
        name: deploy
        inputs:
          timeoutSeconds: "3000"
          runCommand:
            - /opt/impex-deploy/deploy.sh
  YAML
}
