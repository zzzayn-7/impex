variable "name" {
  type = string
}

variable "ssm_prefix" {
  description = "For example /impex/prod."
  type        = string
}

variable "kms_key_id" {
  description = "The key that encrypts the SecureString parameters."
  type        = string
}

variable "public_host" {
  description = "The address the portals are reached at (the server's Elastic IP, or a domain name once there is one)."
  type        = string
}

variable "repo_url" {
  type = string
}

variable "repo_branch" {
  type = string
}

variable "basic_auth_user" {
  description = "The user name of the front-door password."
  type        = string
  default     = "impex"
}
