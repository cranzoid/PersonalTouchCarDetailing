import Link from "next/link";
import { requirePageStaff } from "@/lib/auth/page";
import { getSettings } from "@/lib/settings";
import { listCurrentBookingPauses, pauseEdgeLabel } from "@/lib/booking/pauses";
import { PauseManager } from "./pause-manager";

export const dynamic = "force-dynamic";

export default async function PauseBookingsPage() {
  await requirePageStaff("manage_bookings");
  const settings = await getSettings();
  const now = new Date();
  const pauses = await listCurrentBookingPauses(now);
  const tz = settings.timezone;

  return (
    <div className="max-w-3xl">
      <Link href="/admin/appointments" className="text-sm text-ink-400 hover:text-white">← Appointments</Link>
      <h1 className="mt-2 text-2xl font-bold text-white">Pause online bookings</h1>
      <p className="mt-2 text-sm leading-6 text-ink-400">
        While bookings are paused, customers cannot book online for any time inside the pause. Appointments
        already booked are not touched, and staff can still book from New appointment. Nobody is messaged.
      </p>
      <PauseManager
        pauses={pauses.map((pause) => ({
          id: pause.id,
          active: pause.startsAt <= now,
          startsLabel: pauseEdgeLabel(pause.startsAt, tz, false),
          endsLabel: pauseEdgeLabel(pause.endsAt, tz, true),
          reason: pause.reason,
        }))}
      />
    </div>
  );
}
