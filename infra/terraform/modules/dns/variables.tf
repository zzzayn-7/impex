variable "domain_name" {
  description = "The domain, for example example.com."
  type        = string
}

variable "environment" {
  type = string
}

variable "public_ip" {
  description = "The server's fixed address."
  type        = string
}

variable "extra_records" {
  description = "Further records of the zone, for example the DNS records an e-mail service (Resend, SES ...) asks for. name is relative to the domain (\"send\" means send.<domain>)."
  type = list(object({
    name  = string
    type  = string
    ttl   = optional(number, 300)
    value = string
  }))
  default = []
}
