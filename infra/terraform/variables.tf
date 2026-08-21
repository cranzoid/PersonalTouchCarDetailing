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

variable "github_oidc_subject_prefix" {
  description = "Exact repository prefix from GitHub's Actions OIDC subject customization endpoint."
  type        = string
  default     = "repo:cranzoid@93286005/PersonalTouchCarDetailing@1310343352"

  validation {
    condition     = startswith(var.github_oidc_subject_prefix, "repo:")
    error_message = "github_oidc_subject_prefix must start with repo:."
  }
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
  default     = 8000
}

variable "ga4_measurement_id" {
  description = "Production GA4 web-stream measurement ID. The staging slot intentionally omits it."
  type        = string
  default     = "G-JGYHFZP519"

  validation {
    condition     = var.ga4_measurement_id == "" || can(regex("^G-[A-Z0-9]+$", var.ga4_measurement_id))
    error_message = "ga4_measurement_id must be empty or start with G-."
  }
}
