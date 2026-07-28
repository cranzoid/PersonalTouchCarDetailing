# Azure production infrastructure

This stack deploys the application to Canada Central using:

- Linux App Service Premium P0v3 with a staging deployment slot, managed
  identities, and VNet integration
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

P0v3 is selected for deployment slots, not because the current workload needs
more CPU or memory. At the time of this change, Microsoft lists Linux P0v3
slightly below S1 in Canada Central while P0v3 provides 4 GB RAM. It still
changes the recurring App Service price substantially from B1. Review the
Terraform plan and the current Azure price estimate before applying it.

## GitHub-hosted application releases

Production releases are built and tested by GitHub-hosted Linux runners,
deployed to the `staging` slot, health checked, and then explicitly swapped.
The Mac is not part of the build or deployment path, and Azure does not run
Oryx or `npm install` against the live production worker.

Terraform creates a user-assigned identity with a main-branch-only GitHub OIDC
federation and the `Website Contributor` role scoped to this web app. Store the
three non-secret Terraform outputs as GitHub Actions repository variables:

- `github_actions_azure_client_id` → `AZURE_CLIENT_ID`
- `github_actions_azure_tenant_id` → `AZURE_TENANT_ID`
- `github_actions_azure_subscription_id` → `AZURE_SUBSCRIPTION_ID`

Run the **Azure release** workflow from the GitHub Actions page with operation
`stage`. It runs migrations against an isolated PostgreSQL service, all tests,
type checking, a production build, and the production dependency audit before
creating the Linux release ZIP. It deploys only to staging and verifies
`/api/health`, `/`, and `/connect`.

After reviewing staging, run the same workflow with operation `swap`. It
rechecks staging, swaps, and then smoke tests the production custom domain.
Running a swap again rolls back to the previous production version.

For the one-time B1-to-P0v3 bootstrap, production does not yet have
`/api/health`. Apply the reviewed infrastructure plan with
`-var='production_health_check_path=/'`, deploy and swap the first staged
artifact, then apply the normal plan once more to set the final
`/api/health` path. Future releases use only the staging workflow above.

The App Service startup command applies committed Drizzle migrations and
idempotently seeds the first owner and service catalogue before starting
Next.js. Staging and production share the production database, so every schema
migration must remain backward-compatible through a slot swap.

Never update App Service settings or manually restart a worker while a ZIP
deployment or slot swap is running. Those management operations recycle the
SCM/application container and can abort the release.
