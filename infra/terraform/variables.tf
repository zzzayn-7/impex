variable "aws_region" {
  description = "Region to deploy to."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Name of this deployment. It is part of every SSM parameter path (/impex/<environment>/...)."
  type        = string
  default     = "prod"
}

variable "instance_type" {
  description = "EC2 size. t3.small (2 GB) runs the whole stack, with a 4 GB swap file to carry the Next.js builds; use t3.medium (4 GB) if it feels slow or builds get killed."
  type        = string
  default     = "t3.small"
}

variable "root_volume_gb" {
  description = "Size of the operating system disk."
  type        = number
  default     = 30
}

variable "data_volume_gb" {
  description = "Size of the data disk (Docker images, the PostgreSQL volume and the uploaded logos). It is a separate disk, snapshotted daily, and survives replacing the server."
  type        = number
  default     = 40
}

variable "allowed_cidrs" {
  description = "Who may reach the two portals (HTTPS on 443 and 3001). The default is everyone, which is acceptable only because both portals are behind HTTPS and a password; narrow it to your office / VPN addresses, e.g. [\"203.0.113.7/32\"]."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "basic_auth_user" {
  description = "The user name of the front-door password that protects both portals (the password itself is generated and kept in SSM)."
  type        = string
  default     = "impex"
}

variable "termination_protection" {
  description = "Refuse to terminate the server through the API."
  type        = bool
  default     = true
}

variable "repo_url" {
  description = "The GitHub repository the server deploys from."
  type        = string
  default     = "https://github.com/zzzayn-7/impex"
}

variable "repo_branch" {
  description = "The branch the server deploys."
  type        = string
  default     = "main"
}

variable "snapshot_retention_days" {
  description = "How many daily snapshots of the data disk are kept."
  type        = number
  default     = 7
}
