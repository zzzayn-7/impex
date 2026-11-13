output "name_servers" {
  description = "Set these four as the custom nameservers at the registrar."
  value       = aws_route53_zone.this.name_servers
}

output "zone_id" {
  value = aws_route53_zone.this.zone_id
}
