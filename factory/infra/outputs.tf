output "instance_profile_name" {
  value = aws_iam_instance_profile.worker.name
}

output "security_group_id" {
  value = aws_security_group.worker.id
}

output "github_token_parameter" {
  description = "Store the worker's GitHub token here, outside Terraform, so it never enters state."
  value       = "/${var.name}/github-token"
}
