# Run ONCE, before the main configuration: the encrypted, versioned S3 bucket and the lock table that hold the main configuration's Terraform state
# (the state contains the generated secrets, so it must never sit in a plain file or a public place). See docs/aws-deployment.md ("Remote state").
#
#   cd infra/bootstrap && terraform init && terraform apply
# This configuration's own (tiny, secret-free) state stays local.
terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = { Project = "impex", ManagedBy = "terraform", Purpose = "terraform-state" }
  }
}

data "aws_caller_identity" "current" {}

locals {
  bucket = "impex-terraform-state-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket" "state" {
  bucket = local.bucket

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled" # every earlier state can be restored
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "tls_only" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket     = aws_s3_bucket.state.id
  policy     = data.aws_iam_policy_document.tls_only.json
  depends_on = [aws_s3_bucket_public_access_block.state]
}

resource "aws_dynamodb_table" "lock" {
  name         = "impex-terraform-lock"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  server_side_encryption {
    enabled = true
  }

  point_in_time_recovery {
    enabled = true
  }
}

output "backend_config" {
  description = "Paste this into the main configuration's versions.tf (the backend block), then run: terraform init -migrate-state"
  value       = <<-EOT
    backend "s3" {
      bucket         = "${aws_s3_bucket.state.bucket}"
      key            = "prod/terraform.tfstate"
      region         = "${var.aws_region}"
      encrypt        = true
      dynamodb_table = "${aws_dynamodb_table.lock.name}"
    }
  EOT
}
