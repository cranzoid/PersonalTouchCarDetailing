import { Container } from "@/components/ui";
import { getSettings } from "@/lib/settings";

export const metadata = { title: "Cancellation Policy" };
export const dynamic = "force-dynamic";

/** PLACEHOLDER terms pending owner confirmation (notice window is configurable). */
export default async function CancellationPage() {
  const settings = await getSettings();
  return (
    <Container className="max-w-3xl py-16">
      <h1 className="text-3xl font-bold text-white">Cancellation Policy</h1>
      <p className="mt-2 text-sm text-ink-500">Draft — pending owner review.</p>
      <div className="mt-8 space-y-6 text-ink-300">
        <p>
          We reserve dedicated time, staff and bay space for your appointment. If your plans
          change, please let us know at least{" "}
          <strong className="text-white">{settings.cancellationNoticeHours} hours</strong> before
          your appointment so we can offer the time to another customer.
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            Cancellations or reschedules with {settings.cancellationNoticeHours}+ hours notice:
            no charge; any deposit is refunded or transferred to your new time.
          </li>
          <li>
            Late cancellations or no-shows may forfeit the deposit where one was collected.
          </li>
          <li>
            If we need to reschedule due to weather-dependent work or unforeseen circumstances,
            we&apos;ll contact you as early as possible and your deposit always carries over.
          </li>
        </ul>
        <p>To cancel or reschedule, reply to your confirmation message or call us.</p>
      </div>
    </Container>
  );
}
