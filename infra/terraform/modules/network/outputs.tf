output "subnet_id" {
  value = aws_subnet.public.id
}

output "security_group_id" {
  value = aws_security_group.server.id
}

output "eip_allocation_id" {
  value = aws_eip.this.id
}

output "public_ip" {
  value = aws_eip.this.public_ip
}

output "route_ready" {
  description = "Depend on this to wait until the subnet has its route to the internet."
  value       = aws_route_table_association.public.id
}
