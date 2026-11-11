output "deploy_document_name" {
  value = aws_ssm_document.deploy.name
}

output "ready" {
  description = "Depend on this to wait until every parameter exists (the first boot reads them)."
  value = sha1(join(",", concat(
    [for p in aws_ssm_parameter.env_plain : p.name],
    [for p in aws_ssm_parameter.env_secret : p.name],
    [for p in aws_ssm_parameter.env_to_fill : p.name],
    [for p in aws_ssm_parameter.deploy : p.name],
    [aws_ssm_parameter.edge_user.name, aws_ssm_parameter.edge_password.name],
  )))
}

output "edge_user" {
  value = var.basic_auth_user
}

output "edge_password_parameter" {
  description = "Where the front-door password is stored."
  value       = aws_ssm_parameter.edge_password.name
}
