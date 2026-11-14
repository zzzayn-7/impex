variable "name" {
  type = string
}

variable "availability_zone" {
  type = string
}

variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
}

variable "subnet_cidr" {
  type    = string
  default = "10.42.1.0/24"
}

variable "ingress_ports" {
  description = "The TCP ports the portals listen on."
  type        = list(number)
}

variable "allowed_cidrs" {
  description = "Who may reach those ports."
  type        = list(string)

  validation {
    condition     = length(var.allowed_cidrs) > 0 && alltrue([for c in var.allowed_cidrs : can(cidrnetmask(c))])
    error_message = "allowed_cidrs must be a non-empty list of valid IPv4 CIDR blocks, for example [\"203.0.113.7/32\"]."
  }
}

variable "ssh_cidrs" {
  description = "Addresses that may open an SSH session (port 22). Empty (the default) keeps SSH closed: Session Manager is the way in."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.ssh_cidrs : can(cidrnetmask(c)) && c != "0.0.0.0/0"])
    error_message = "ssh_cidrs must be valid IPv4 CIDR blocks, and never 0.0.0.0/0 (SSH is never open to the whole internet)."
  }
}
