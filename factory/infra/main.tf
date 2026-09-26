data "aws_partition" "current" {}
data "aws_caller_identity" "current" {}

data "aws_vpc" "default" {
  default = true
}

locals {
  worker_name   = "${var.name}-worker"
  parameter_arn = "arn:${data.aws_partition.current.partition}:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.name}/*"
}

data "aws_iam_policy_document" "worker_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "worker" {
  name               = local.worker_name
  description        = "Agent Factory ephemeral worker"
  assume_role_policy = data.aws_iam_policy_document.worker_assume.json
}

resource "aws_iam_role_policy_attachment" "worker_ssm" {
  role       = aws_iam_role.worker.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "worker_parameters" {
  statement {
    sid       = "ReadFactorySecrets"
    actions   = ["ssm:GetParameter"]
    resources = [local.parameter_arn]
  }

  statement {
    sid    = "DenyOtherParameters"
    effect = "Deny"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
      "ssm:GetParameterHistory",
    ]
    not_resources = [local.parameter_arn]
  }
}

resource "aws_iam_role_policy" "worker_parameters" {
  name   = "factory-parameters-only"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker_parameters.json
}

resource "aws_iam_instance_profile" "worker" {
  name = local.worker_name
  role = aws_iam_role.worker.name
}

resource "aws_security_group" "worker" {
  name        = local.worker_name
  description = "Agent Factory workers, egress only"
  vpc_id      = data.aws_vpc.default.id

  tags = {
    Name = local.worker_name
  }
}

resource "aws_vpc_security_group_egress_rule" "worker_all" {
  security_group_id = aws_security_group.worker.id
  description       = "GitHub, package mirrors, and SSM endpoints"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_budgets_budget" "monthly" {
  count = var.budget_alert_email == null ? 0 : 1

  name         = "${var.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_alert_email]
  }
}
