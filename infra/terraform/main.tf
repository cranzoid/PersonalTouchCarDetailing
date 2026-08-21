data "azurerm_client_config" "current" {}

resource "random_string" "suffix" {
  length  = 6
  upper   = false
  special = false
}

resource "random_password" "postgres" {
  length  = 32
  special = false
}

resource "random_password" "session_secret" {
  length  = 64
  special = false
}

resource "random_password" "cron_secret" {
  length  = 64
  special = false
}

resource "random_password" "admin" {
  length           = 24
  special          = true
  override_special = "!#%*+-.:=?@_"
}

# AES-256 key wrapping the provider API credentials the owner enters in
# Admin -> Integrations. random_id gives exactly 32 raw bytes; the application
# accepts the standard-base64 form. Rotating this makes stored credentials
# unreadable, so the app falls back to environment variables and the owner
# re-enters them.
resource "random_id" "settings_encryption_key" {
  byte_length = 32
}

locals {
  app_name       = "app-ptcd-prod-${random_string.suffix.result}"
  postgres_name  = "psql-ptcd-prod-${random_string.suffix.result}"
  storage_name   = "stptcdprod${random_string.suffix.result}"
  key_vault_name = "kv-ptcd-${random_string.suffix.result}"
  tags = {
    application = "personal-touch-car-detailing"
    environment = "production"
    managed_by  = "terraform"
  }
}

resource "azurerm_resource_group" "main" {
  name     = var.resource_group_name
  location = var.location
  tags     = local.tags
}

resource "azurerm_virtual_network" "main" {
  name                = "vnet-ptcd-prod"
  address_space       = ["10.42.0.0/24"]
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_subnet" "app" {
  name                 = "snet-app-service"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.42.0.0/26"]
  service_endpoints    = ["Microsoft.Storage"]

  delegation {
    name = "app-service"
    service_delegation {
      name    = "Microsoft.Web/serverFarms"
      actions = ["Microsoft.Network/virtualNetworks/subnets/action"]
    }
  }
}

resource "azurerm_subnet" "postgres" {
  name                 = "snet-postgresql"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.42.0.64/28"]

  delegation {
    name = "postgres-flexible-server"
    service_delegation {
      name = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = [
        "Microsoft.Network/virtualNetworks/subnets/join/action",
      ]
    }
  }
}

resource "azurerm_private_dns_zone" "postgres" {
  name                = "ptcd.postgres.database.azure.com"
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  name                  = "link-ptcd-prod"
  private_dns_zone_name = azurerm_private_dns_zone.postgres.name
  virtual_network_id    = azurerm_virtual_network.main.id
  resource_group_name   = azurerm_resource_group.main.name
  registration_enabled  = false
  tags                  = local.tags
}

resource "azurerm_postgresql_flexible_server" "main" {
  name                          = local.postgres_name
  resource_group_name           = azurerm_resource_group.main.name
  location                      = azurerm_resource_group.main.location
  version                       = "16"
  delegated_subnet_id           = azurerm_subnet.postgres.id
  private_dns_zone_id           = azurerm_private_dns_zone.postgres.id
  public_network_access_enabled = false
  administrator_login           = "ptcdadmin"
  administrator_password        = random_password.postgres.result
  zone                          = "1"
  sku_name                      = "B_Standard_B1ms"
  storage_mb                    = 32768
  # 35 days of point-in-time restore. Geo-redundant backup can only be set at
  # server creation time, and Burstable servers cannot take customer on-demand
  # backups — so PITR is the recovery path. Releases record their restore
  # timestamp in the workflow summary (see .github/workflows/azure-release.yml).
  backup_retention_days        = 35
  geo_redundant_backup_enabled = false
  auto_grow_enabled            = true
  tags                         = local.tags

  depends_on = [azurerm_private_dns_zone_virtual_network_link.postgres]
}

resource "azurerm_postgresql_flexible_server_database" "app" {
  name      = "ptcd"
  server_id = azurerm_postgresql_flexible_server.main.id
  collation = "en_US.utf8"
  charset   = "UTF8"
}

resource "azurerm_storage_account" "files" {
  name                            = local.storage_name
  resource_group_name             = azurerm_resource_group.main.name
  location                        = azurerm_resource_group.main.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  account_kind                    = "StorageV2"
  access_tier                     = "Hot"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = true
  tags                            = local.tags
}

resource "azurerm_storage_container" "private_files" {
  name                  = "private-files"
  storage_account_id    = azurerm_storage_account.files.id
  container_access_type = "private"
}

resource "azurerm_key_vault" "main" {
  name                       = local.key_vault_name
  resource_group_name        = azurerm_resource_group.main.name
  location                   = azurerm_resource_group.main.location
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  soft_delete_retention_days = 7
  purge_protection_enabled   = true
  tags                       = local.tags
}

resource "azurerm_key_vault_access_policy" "terraform" {
  key_vault_id = azurerm_key_vault.main.id
  tenant_id    = data.azurerm_client_config.current.tenant_id
  object_id    = data.azurerm_client_config.current.object_id
  secret_permissions = [
    "Get",
    "List",
    "Set",
    "Delete",
    "Recover",
    "Purge",
  ]
}

resource "azurerm_key_vault_secret" "database_url" {
  name         = "database-url"
  value        = "postgresql://ptcdadmin:${random_password.postgres.result}@${azurerm_postgresql_flexible_server.main.fqdn}:5432/${azurerm_postgresql_flexible_server_database.app.name}?sslmode=require"
  key_vault_id = azurerm_key_vault.main.id
  depends_on   = [azurerm_key_vault_access_policy.terraform]
}

resource "azurerm_key_vault_secret" "session_secret" {
  name         = "session-secret"
  value        = random_password.session_secret.result
  key_vault_id = azurerm_key_vault.main.id
  depends_on   = [azurerm_key_vault_access_policy.terraform]
}

resource "azurerm_key_vault_secret" "cron_secret" {
  name         = "cron-secret"
  value        = random_password.cron_secret.result
  key_vault_id = azurerm_key_vault.main.id
  depends_on   = [azurerm_key_vault_access_policy.terraform]
}

resource "azurerm_key_vault_secret" "admin_password" {
  name         = "initial-admin-password"
  value        = random_password.admin.result
  key_vault_id = azurerm_key_vault.main.id
  depends_on   = [azurerm_key_vault_access_policy.terraform]
}

resource "azurerm_key_vault_secret" "settings_encryption_key" {
  name         = "settings-encryption-key"
  value        = random_id.settings_encryption_key.b64_std
  key_vault_id = azurerm_key_vault.main.id
  depends_on   = [azurerm_key_vault_access_policy.terraform]
}

resource "azurerm_log_analytics_workspace" "main" {
  name                = "log-ptcd-prod-${random_string.suffix.result}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  daily_quota_gb      = 0.1
  tags                = local.tags
}

resource "azurerm_application_insights" "main" {
  name                = "appi-ptcd-prod-${random_string.suffix.result}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  workspace_id        = azurerm_log_analytics_workspace.main.id
  application_type    = "web"
  tags                = local.tags
}

resource "azurerm_service_plan" "main" {
  name                = "plan-ptcd-prod"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  os_type             = "Linux"
  sku_name            = var.app_service_sku_name
  tags                = local.tags
}

locals {
  web_app_common_settings = {
    NODE_ENV                                   = "production"
    DATABASE_URL                               = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault_secret.database_url.id})"
    SESSION_SECRET                             = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault_secret.session_secret.id})"
    CRON_SECRET                                = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault_secret.cron_secret.id})"
    SETTINGS_ENCRYPTION_KEY                    = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault_secret.settings_encryption_key.id})"
    SEED_ADMIN_NAME                            = var.admin_name
    SEED_ADMIN_EMAIL                           = var.admin_email
    SEED_ADMIN_PASSWORD                        = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault_secret.admin_password.id})"
    AZURE_STORAGE_ACCOUNT_NAME                 = azurerm_storage_account.files.name
    AZURE_STORAGE_CONTAINER_NAME               = azurerm_storage_container.private_files.name
    APPLICATIONINSIGHTS_CONNECTION_STRING      = azurerm_application_insights.main.connection_string
    PUBLIC_SITE_URL                            = "https://www.personaltouchcardetailing.ca"
    GA4_MEASUREMENT_ID                         = var.ga4_measurement_id
    ApplicationInsightsAgent_EXTENSION_VERSION = "~3"
    SCM_DO_BUILD_DURING_DEPLOYMENT             = "false"
    ENABLE_ORYX_BUILD                          = "false"
    WEBSITE_NODE_DEFAULT_VERSION               = "~22"
    WEBSITE_SWAP_WARMUP_PING_PATH              = "/api/health"
    WEBSITE_SWAP_WARMUP_PING_STATUSES          = "200"
    WEBSITES_CONTAINER_START_TIME_LIMIT        = "600"
    WEBSITE_START_SCM_ON_SITE_CREATION         = "1"
  }
}

resource "azurerm_linux_web_app" "main" {
  name                      = local.app_name
  resource_group_name       = azurerm_resource_group.main.name
  location                  = azurerm_service_plan.main.location
  service_plan_id           = azurerm_service_plan.main.id
  https_only                = true
  virtual_network_subnet_id = azurerm_subnet.app.id
  tags = merge(local.tags, {
    "hidden-link: /app-insights-resource-id" = replace(
      azurerm_application_insights.main.id,
      "Microsoft.Insights",
      "microsoft.insights",
    )
  })

  identity {
    type = "SystemAssigned"
  }

  site_config {
    always_on                         = true
    app_command_line                  = "sh startup.sh"
    ftps_state                        = "Disabled"
    health_check_eviction_time_in_min = 10
    health_check_path                 = var.production_health_check_path
    http2_enabled                     = true
    minimum_tls_version               = "1.2"
    use_32_bit_worker                 = false
    vnet_route_all_enabled            = true

    application_stack {
      node_version = "22-lts"
    }
  }

  app_settings = merge(local.web_app_common_settings, {
    APP_BASE_URL  = "https://www.personaltouchcardetailing.ca"
    SEO_INDEXABLE = "true"
  })

  sticky_settings {
    app_setting_names = ["APP_BASE_URL", "SEO_INDEXABLE"]
  }
}

resource "azurerm_linux_web_app_slot" "staging" {
  name                                           = "staging"
  app_service_id                                 = azurerm_linux_web_app.main.id
  https_only                                     = true
  ftp_publish_basic_authentication_enabled       = false
  webdeploy_publish_basic_authentication_enabled = false
  virtual_network_subnet_id                      = azurerm_subnet.app.id
  tags                                           = merge(local.tags, { environment = "staging" })

  identity {
    type = "SystemAssigned"
  }

  site_config {
    always_on                         = true
    app_command_line                  = "sh startup.sh"
    ftps_state                        = "Disabled"
    health_check_eviction_time_in_min = 10
    health_check_path                 = "/api/health"
    http2_enabled                     = true
    minimum_tls_version               = "1.2"
    use_32_bit_worker                 = false
    vnet_route_all_enabled            = true

    application_stack {
      node_version = "22-lts"
    }
  }

  app_settings = merge(local.web_app_common_settings, {
    APP_BASE_URL  = "https://${local.app_name}-staging.azurewebsites.net"
    SEO_INDEXABLE = "false"
  })
}

resource "azurerm_key_vault_access_policy" "web_app" {
  key_vault_id = azurerm_key_vault.main.id
  tenant_id    = azurerm_linux_web_app.main.identity[0].tenant_id
  object_id    = azurerm_linux_web_app.main.identity[0].principal_id

  secret_permissions = ["Get", "List"]
}

resource "azurerm_key_vault_access_policy" "staging_web_app" {
  key_vault_id = azurerm_key_vault.main.id
  tenant_id    = azurerm_linux_web_app_slot.staging.identity[0].tenant_id
  object_id    = azurerm_linux_web_app_slot.staging.identity[0].principal_id

  secret_permissions = ["Get", "List"]
}

resource "azurerm_role_assignment" "web_blob_data" {
  scope                = azurerm_storage_account.files.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_linux_web_app.main.identity[0].principal_id
}

resource "azurerm_role_assignment" "staging_web_blob_data" {
  scope                            = azurerm_storage_account.files.id
  role_definition_name             = "Storage Blob Data Contributor"
  principal_id                     = azurerm_linux_web_app_slot.staging.identity[0].principal_id
  skip_service_principal_aad_check = true
}

resource "azurerm_user_assigned_identity" "github_actions" {
  name                = "id-ptcd-github-actions"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  tags                = local.tags
}

resource "azurerm_federated_identity_credential" "github_actions_main" {
  name                      = "github-main"
  user_assigned_identity_id = azurerm_user_assigned_identity.github_actions.id
  audience                  = ["api://AzureADTokenExchange"]
  issuer                    = "https://token.actions.githubusercontent.com"
  subject                   = "${var.github_oidc_subject_prefix}:ref:refs/heads/main"
}

resource "azurerm_role_assignment" "github_actions_web_app" {
  scope = join("", [
    "/subscriptions/${var.subscription_id}",
    "/resourceGroups/${var.resource_group_name}",
    "/providers/Microsoft.Web/sites/${local.app_name}",
  ])
  role_definition_name             = "Website Contributor"
  principal_id                     = azurerm_user_assigned_identity.github_actions.principal_id
  skip_service_principal_aad_check = true
}

resource "azurerm_logic_app_workflow" "scheduler" {
  name                = "logic-ptcd-hourly"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  tags                = local.tags

  workflow_parameters = {
    "$connections" = jsonencode({
      defaultValue = {}
      type         = "Object"
    })
  }
}

resource "azurerm_logic_app_trigger_recurrence" "hourly" {
  name         = "hourly"
  logic_app_id = azurerm_logic_app_workflow.scheduler.id
  frequency    = "Hour"
  interval     = 1
}

resource "azurerm_logic_app_action_http" "cron" {
  name         = "run-application-cron"
  logic_app_id = azurerm_logic_app_workflow.scheduler.id
  method       = "POST"
  uri          = "https://www.personaltouchcardetailing.ca/api/cron/tick"
  headers = {
    Authorization = "Bearer ${random_password.cron_secret.result}"
  }

  depends_on = [azurerm_logic_app_trigger_recurrence.hourly]
}

resource "azurerm_consumption_budget_resource_group" "monthly" {
  name              = "budget-ptcd-prod"
  resource_group_id = azurerm_resource_group.main.id
  amount            = var.monthly_budget_inr
  time_grain        = "Monthly"

  time_period {
    start_date = "2026-07-01T00:00:00Z"
    end_date   = "2036-07-01T00:00:00Z"
  }

  notification {
    enabled        = true
    threshold      = 80
    operator       = "GreaterThan"
    threshold_type = "Forecasted"
    contact_emails = [var.admin_email]
  }

  notification {
    enabled        = true
    threshold      = 100
    operator       = "GreaterThan"
    threshold_type = "Actual"
    contact_emails = [var.admin_email]
  }
}
