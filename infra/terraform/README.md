# Azure production infrastructure

This stack deploys the application to Canada Central using:

- Linux App Service B1 with managed identity and VNet integration
- PostgreSQL Flexible Server B1ms on a private delegated subnet
- private Azure Blob Storage for customer and job photos
- Key Vault for generated application and database secrets
- Application Insights and a capped Log Analytics workspace
- an hourly Consumption Logic App for `/api/cron/tick`
- a monthly resource-group budget with 80% forecast and 100% actual alerts

## Initialize

Production state uses a dedicated blob key in the existing protected Terraform
state account:

```bash
terraform -chdir=infra/terraform init \
  -backend-config=backend.hcl.example
```

Create an ignored `infra/terraform/terraform.tfvars` from the example and set
the subscription ID and initial owner email, then:

```bash
terraform -chdir=infra/terraform plan -out=production.tfplan
terraform -chdir=infra/terraform apply production.tfplan
```

Terraform generates the database, session, cron, and first-owner passwords.
They remain in the encrypted remote state and Azure Key Vault. Retrieve the
initial owner password using the `admin_password_command` Terraform output.

Application code is deployed separately after `terraform apply`; the App
Service startup command applies committed Drizzle migrations and idempotently
seeds the first owner and service catalogue before starting Next.js.
