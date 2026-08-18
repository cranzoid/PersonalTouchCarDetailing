import { requirePageStaff } from "@/lib/auth/page";
import { getTimesheetWeek, weekLabel, weekStartISO } from "@/lib/payroll";
import { getSettings } from "@/lib/settings";
import { localDateISO } from "@/lib/tz";
import { TimesheetWeekGrid } from "./week-grid";

export const dynamic = "force-dynamic";

export default async function TimesheetsPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  await requirePageStaff("manage_timesheets");
  const settings = await getSettings();
  const params = await searchParams;

  // Any date in the query resolves to the Monday of its week, so a stale or
  // hand-edited link still lands on a real grid rather than an error.
  const today = localDateISO(settings.timezone);
  const requested = /^\d{4}-\d{2}-\d{2}$/.test(params.week ?? "") ? params.week! : today;
  const week = await getTimesheetWeek(weekStartISO(requested));

  return (
    <TimesheetWeekGrid
      week={{ ...week, label: weekLabel(week.weekStart) }}
      today={today}
      thisWeekStart={weekStartISO(today)}
      currency={settings.currency}
    />
  );
}
