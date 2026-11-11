terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # The state holds the generated secrets, so it lives in the encrypted, versioned S3 bucket created by infra/bootstrap (see docs/aws-deployment.md).
  backend "s3" {
    bucket         = "impex-terraform-state-838547581793"
    key            = "prod/terraform.tfstate"
    region         = "ap-southeast-2"
    encrypt        = true
    dynamodb_table = "impex-terraform-lock"
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "impex"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
