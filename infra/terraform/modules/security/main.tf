# Security: the encryption key for the secrets, and the server's identity. The server's role can do exactly three things:
#   1. be managed with Session Manager (the only way in: there is no SSH),
#   2. read its OWN SSM parameters (/impex/<env>/*) and decrypt them with this module's key, only through SSM,
#   3. nothing else: no S3, no EC2, no IAM, no other parameters.

data "aws_caller_identity" "current" {}

# ---------------------------------------------------------------------------------------------------------------------------------------------------------
# The key that encrypts every SecureString parameter (the database password, the signing key, the service keys, the portals' password).
# A customer-managed key, rotated every year, used only through SSM: the account's administrators manage it, the server can only decrypt.
# ---------------------------------------------------------------------------------------------------------------------------------------------------------
data "aws_iam_policy_document" "kms" {
  statement {
    sid       = "AccountAdministersTheKey"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }
}

resource "aws_kms_key" "secrets" {
  description             = "Impex ${var.environment}: encrypts the SSM SecureString parameters"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.kms.json
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/${var.name}-secrets"
  target_key_id = aws_kms_key.secrets.key_id
}

# ---------------------------------------------------------------------------------------------------------------------------------------------------------
# The server's role
# ---------------------------------------------------------------------------------------------------------------------------------------------------------
data "aws_iam_policy_document" "assume_ec2" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "server" {
  name                 = "${var.name}-server"
  assume_role_policy   = data.aws_iam_policy_document.assume_ec2.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.server.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "own_parameters" {
  statement {
    sid       = "ReadOwnParameters"
    actions   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
    resources = ["arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${var.ssm_prefix}/*"]
  }

  statement {
    sid       = "DecryptThemOnlyThroughSsm"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.secrets.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "own_parameters" {
  name   = "read-own-parameters"
  role   = aws_iam_role.server.id
  policy = data.aws_iam_policy_document.own_parameters.json
}

resource "aws_iam_instance_profile" "server" {
  name = "${var.name}-server"
  role = aws_iam_role.server.name
}
