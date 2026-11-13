# DNS for the domain, hosted in Amazon Route 53. The domain is REGISTERED elsewhere (Namecheap): after the first apply you set the registrar's nameservers to the four
# this zone hands out (output name_servers) and Route 53 answers for the domain from then on. Every name points at the server's fixed address.
#   <domain>, www.<domain>   -> the server (the front page)
#   app.<domain>             -> the Organization portal
#   admin.<domain>           -> the Super Admin portal
#   mail.<domain>            -> reserved for the mailbox (Mailpit) page

resource "aws_route53_zone" "this" {
  name    = var.domain_name
  comment = "Impex ${var.environment}"

  lifecycle {
    prevent_destroy = true # deleting the zone would change its nameservers: the domain would stop resolving until the registrar is updated again
  }
}

resource "aws_route53_record" "host" {
  for_each = toset(["", "www.", "app.", "admin.", "mail."])

  zone_id = aws_route53_zone.this.zone_id
  name    = "${each.value}${var.domain_name}"
  type    = "A"
  ttl     = 300
  records = [var.public_ip]
}

# Only Let's Encrypt (the certificate authority the server uses) may issue certificates for the domain.
resource "aws_route53_record" "caa" {
  zone_id = aws_route53_zone.this.zone_id
  name    = var.domain_name
  type    = "CAA"
  ttl     = 3600
  records = ["0 issue \"letsencrypt.org\"", "0 issuewild \";\""]
}
