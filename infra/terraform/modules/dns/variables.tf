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
