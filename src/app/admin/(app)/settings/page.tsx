import { getSettings } from "@/lib/settings";
import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const settings = await getSettings();
  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-white">Business settings</h1>
      <p className="mt-1 text-sm text-ink-400">
        These values drive the public website, booking rules and tax
        calculations. Changes are audited. Fields marked * still need
        confirmed real values from the owner.
      </p>
      <SettingsForm initial={settings} />
    </div>
  );
}
