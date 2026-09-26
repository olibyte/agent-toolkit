variable "region" {
  description = "Region for workers and their secrets."
  type        = string
}

variable "profile" {
  description = "AWS CLI profile to deploy with. Null uses the default credential chain."
  type        = string
  default     = null
}

variable "name" {
  description = "Resource name prefix. The factory CLI derives <name>-worker and /<name>/ from its --name flag, so keep them equal."
  type        = string
  default     = "agent-factory"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,40}$", var.name))
    error_message = "name must be lowercase letters, digits, and hyphens."
  }
}

variable "budget_alert_email" {
  description = "Email for account-wide monthly cost alerts. Null skips the budget."
  type        = string
  default     = null
}

variable "monthly_budget_usd" {
  description = "Monthly cost budget in USD. Alerts fire at 80% actual and 100% forecast."
  type        = number
  default     = 20
}
