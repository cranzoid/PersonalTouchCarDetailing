import Link from "next/link";
import { requirePageStaff } from "@/lib/auth/page";
import { canStoreCredentials, getIntegrationStatus } from "@/lib/integrations";
import { IntegrationsForm } from "./integrations-form";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  await requirePageStaff("manage_integrations");
  const status = await getIntegrationStatus();
  const smsReady = ["twilioAccountSid", "twilioAuthToken", "twilioFromNumber"].every(
    (key) => status.find((s) => s.key === key)?.configured,
  );
  const emailReady = ["resendApiKey", "emailFrom"].every(
    (key) => status.find((s) => s.key === key)?.configured,
  );

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold text-white">Integrations</h1>
      <p className="mt-1 text-sm text-ink-400">
        Credentials for the services that deliver customer messages. Values are encrypted before
        storage and are never shown again in full — only the owner can view this page, and every
        change is audited.
      </p>

      {(!smsReady || !emailReady) && (
        <p className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          {!smsReady && !emailReady
            ? "Neither SMS nor email is configured, so no booking confirmations or reminders are reaching customers."
            : !emailReady
              ? "Email is not configured, so email confirmations and invoices are not reaching customers."
              : "SMS is not configured, so text reminders and staff alerts cannot be sent."}
        </p>
      )}

      <IntegrationsForm status={status} canStore={canStoreCredentials()} />

      <p className="mt-8 text-xs text-ink-500">
        Choosing who receives staff alerts is separate — set that under{" "}
        <Link href="/admin/settings" className="underline hover:text-white">
          Business settings
        </Link>
        .
      </p>
    </div>
  );
}
