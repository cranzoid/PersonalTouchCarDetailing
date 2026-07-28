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

variable "app_service_sku_name" {
  description = "Linux App Service plan SKU. P0v3 provides deployment slots and is currently cheaper than S1 in Canada Central."
  type        = string
  default     = "P0v3"

  validation {
    condition = contains([
      "S1", "S2", "S3",
      "P0v3", "P1v3", "P2v3", "P3v3",
    ], var.app_service_sku_name)
    error_message = "app_service_sku_name must support deployment slots (Standard or Premium v3)."
  }
}

variable "production_health_check_path" {
  description = "Production App Service health path. Use / only for the one-time slot bootstrap before /api/health has been deployed."
  type        = string
  default     = "/api/health"

  validation {
    condition     = startswith(var.production_health_check_path, "/")
    error_message = "production_health_check_path must start with a slash."
  }
}

variable "github_repository" {
  description = "GitHub repository allowed to obtain an Azure OIDC token from the main branch."
  type        = string
  default     = "cranzoid/PersonalTouchCarDetailing"
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
