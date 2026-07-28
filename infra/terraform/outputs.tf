output "resource_group_name" {
  value = azurerm_resource_group.main.name
}

output "web_app_name" {
  value = azurerm_linux_web_app.main.name
}

output "web_app_url" {
  value = "https://${azurerm_linux_web_app.main.default_hostname}"
}

output "staging_web_app_url" {
  value = "https://${azurerm_linux_web_app.main.name}-staging.azurewebsites.net"
}

output "github_actions_azure_client_id" {
  value = azurerm_user_assigned_identity.github_actions.client_id
}

output "github_actions_azure_tenant_id" {
  value = azurerm_user_assigned_identity.github_actions.tenant_id
}

output "github_actions_azure_subscription_id" {
  value = var.subscription_id
}

output "key_vault_name" {
  value = azurerm_key_vault.main.name
}

output "admin_email" {
  value = var.admin_email
}

output "admin_password_command" {
  value = "az keyvault secret show --vault-name ${azurerm_key_vault.main.name} --name initial-admin-password --query value --output tsv"
}
