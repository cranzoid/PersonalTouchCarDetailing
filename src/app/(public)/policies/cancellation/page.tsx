import { Container } from "@/components/ui";
import { getSettings } from "@/lib/settings";

export const metadata = { title: "Cancellation Policy" };
export const dynamic = "force-dynamic";

/**
 * Policy drafted per owner delegation (2026-07-19): 48-hour notice window,
 * deposit forfeited on late cancellation / no-show. The window itself is
 * configurable in Admin → Settings.
 */
export default async function CancellationPage() {
  const settings = await getSettings();
  return (
    <Container className="max-w-4xl py-20 sm:py-28">
      <article className="rounded-[2rem] bg-[#F4F6FA] p-7 text-[#1C2026] shadow-[0_25px_80px_rgba(0,0,0,0.18)] sm:p-12">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent-600">Appointment changes</p>
      <h1 className="mt-4 font-display text-4xl text-[#0B2A4A] sm:text-5xl">Cancellation Policy</h1>
      <div className="mt-10 space-y-6 text-sm leading-7 text-slate-700 sm:text-base">
        <p>
          We reserve dedicated time, staff and bay space for your appointment. If your plans
          change, please let us know at least{" "}
          <strong className="text-[#0B2A4A]">{settings.cancellationNoticeHours} hours</strong> before
          your appointment so we can offer the time to another customer.
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            Cancellations or reschedules with {settings.cancellationNoticeHours}+ hours notice:
            no charge; any deposit is refunded or transferred to your new time.
          </li>
          <li>
            Cancellations with less than {settings.cancellationNoticeHours} hours notice, and
            no-shows, forfeit the deposit where one was collected.
          </li>
          <li>
            If we need to reschedule due to weather-dependent work or unforeseen circumstances,
            we&apos;ll contact you as early as possible and your deposit always carries over.
          </li>
        </ul>
        <p>To cancel or reschedule, reply to your confirmation message or call us.</p>
      </div>
      </article>
    </Container>
  );
}
