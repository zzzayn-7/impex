output "instance_profile_name" {
  value = aws_iam_instance_profile.server.name
}

output "kms_key_id" {
  value = aws_kms_key.secrets.key_id
}

output "policy_ready" {
  description = "Depend on this to wait until the server's permissions exist."
  value       = aws_iam_role_policy.own_parameters.id
}
