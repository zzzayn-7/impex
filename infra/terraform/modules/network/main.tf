# Network: one VPC, one public subnet, a fixed public address, and a security group that lets in ONLY the listed ports from the listed addresses.
# Nothing else is reachable from outside: not SSH (the server is managed with Session Manager), not the services' own ports, not PostgreSQL.

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

# The VPC's default security group and network ACL allow nothing in or out of anything left in them by accident.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-default-deny" }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = var.name }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.this.id
  cidr_block              = var.subnet_cidr
  availability_zone       = var.availability_zone
  map_public_ip_on_launch = false # the server gets the Elastic IP below, nothing else is ever given a public address
  tags                    = { Name = "${var.name}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "this" {
  domain = "vpc"
  tags   = { Name = var.name }
}

resource "aws_security_group" "server" {
  name        = "${var.name}-server"
  description = "Impex: the two portals, over HTTPS only"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${var.name}-server" }

  # No rule is written inline: they are separate resources, so changing one never rewrites the others.
}

resource "aws_vpc_security_group_ingress_rule" "portal" {
  for_each = { for pair in setproduct(var.ingress_ports, var.allowed_cidrs) : "${pair[0]}-${pair[1]}" => pair }

  security_group_id = aws_security_group.server.id
  description       = "HTTPS portal on port ${each.value[0]}"
  ip_protocol       = "tcp"
  from_port         = each.value[0]
  to_port           = each.value[0]
  cidr_ipv4         = each.value[1]
}

# Out: HTTPS (package and image downloads, GitHub, the AWS APIs), DNS and SMTP submission (the e-mail the platform sends). Nothing else leaves the server.
resource "aws_vpc_security_group_egress_rule" "https" {
  security_group_id = aws_security_group.server.id
  description       = "HTTPS out"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "http" {
  security_group_id = aws_security_group.server.id
  description       = "HTTP out (operating system package mirrors)"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "dns_udp" {
  security_group_id = aws_security_group.server.id
  description       = "DNS"
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "dns_tcp" {
  security_group_id = aws_security_group.server.id
  description       = "DNS over TCP"
  ip_protocol       = "tcp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "smtp" {
  for_each = toset(["587", "465"])

  security_group_id = aws_security_group.server.id
  description       = "E-mail submission (port ${each.value})"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
  cidr_ipv4         = "0.0.0.0/0"
}
