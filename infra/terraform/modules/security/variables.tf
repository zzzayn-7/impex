variable "name" {
  type = string
}

variable "environment" {
  type = string
}

variable "region" {
  type = string
}

variable "ssm_prefix" {
  description = "The SSM path the server may read, for example /impex/prod."
  type        = string
}
