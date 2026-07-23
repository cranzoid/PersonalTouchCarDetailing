variable "subscription_id" {
  description = "Azure subscription in which to deploy."
  type        = string
}

variable "location" {
  description = "Azure region for the application and data."
  type        = string
  default     = "canadacentral"
}

variable "resource_group_name" {
  description = "Production resource group name."
  type        = string
  default     = "rg-ptcd-prod"
}

variable "admin_name" {
  description = "Name for the first application owner."
  type        = string
  default     = "Owner"
}

variable "admin_email" {
  description = "Email address for the first application owner and Azure budget alerts."
  type        = string
}

variable "monthly_budget_inr" {
  description = "Monthly resource-group budget in the subscription billing currency (INR)."
  type        = number
  default     = 4000
}
