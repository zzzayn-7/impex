output "public_ip" {
  description = "The server's fixed public address."
  value       = module.network.public_ip
}

output "super_admin_url" {
  description = "Super Admin portal (HTTPS, behind the front-door password)."
  value       = "https://admin.${var.domain_name}"
}

output "organization_portal_url" {
  description = "Organization portal (HTTPS, behind the front-door password)."
  value       = "https://app.${var.domain_name}"
}

output "mailbox_url" {
  description = "Mailpit: the e-mails the platform sent (HTTPS, behind the front-door password)."
  value       = "https://mail.${var.domain_name}"
}

output "front_door_user" {
  description = "The user name of the password in front of both portals."
  value       = module.config.edge_user
}

output "front_door_password" {
  description = "Where the front-door password is. Read it with the get_front_door_password command."
  value       = module.config.edge_password_parameter
}

output "get_front_door_password" {
  value = "aws ssm get-parameter --region ${var.aws_region} --name ${module.config.edge_password_parameter} --with-decryption --query Parameter.Value --output text"
}

output "instance_id" {
  value = module.server.instance_id
}

output "ssm_parameters_path" {
  description = "All the configuration: <path>/env/* (the .env file), <path>/edge/* (the front door) and <path>/deploy/*."
  value       = local.ssm_prefix
}

output "open_a_shell" {
  description = "A shell on the server (Session Manager: no SSH, port 22 is closed). Needs the Session Manager plugin for the AWS CLI."
  value       = "aws ssm start-session --target ${module.server.instance_id} --region ${var.aws_region}"
}

output "deploy_command" {
  description = "Redeploy after pushing to GitHub or after changing a parameter."
  value       = "aws ssm send-command --region ${var.aws_region} --document-name ${module.config.deploy_document_name} --instance-ids ${module.server.instance_id} --comment deploy"
}

output "set_a_parameter" {
  description = "Example: set an SSM parameter (then run the deploy command)."
  value       = "aws ssm put-parameter --region ${var.aws_region} --name ${local.ssm_prefix}/env/SMTP_HOST --type String --value smtp.example.com --overwrite"
}

output "dns_name_servers" {
  description = "Set these four as the CUSTOM nameservers for the domain at the registrar (Namecheap: Domain List > Manage > Nameservers > Custom DNS)."
  value       = module.dns.name_servers
}

output "domain_hosts" {
  description = "The names Terraform points at the server."
  value       = [for p in ["", "www.", "app.", "admin.", "mail."] : "${p}${var.domain_name}"]
}
