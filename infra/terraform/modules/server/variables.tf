variable "name" {
  type = string
}

variable "region" {
  type = string
}

variable "availability_zone" {
  type = string
}

variable "ssm_prefix" {
  type = string
}

variable "instance_type" {
  type = string
}

variable "root_volume_gb" {
  type = number
}

variable "data_volume_gb" {
  type = number
}

variable "snapshot_retention_days" {
  type = number
}

variable "termination_protection" {
  description = "Refuse to terminate the server through the API (it has to be switched off first, on purpose)."
  type        = bool
}

variable "subnet_id" {
  type = string
}

variable "security_group_id" {
  type = string
}

variable "instance_profile_name" {
  type = string
}

variable "eip_allocation_id" {
  type = string
}
