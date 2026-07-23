output "resource_group_name" {
  value = azurerm_resource_group.main.name
}

output "web_app_name" {
  value = azurerm_linux_web_app.main.name
}

output "web_app_url" {
  value = "https://${azurerm_linux_web_app.main.default_hostname}"
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
