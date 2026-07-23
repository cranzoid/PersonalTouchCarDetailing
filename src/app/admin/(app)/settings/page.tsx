import { db, schema } from "@/db";
import { getSettings } from "@/lib/settings";
import { SettingsForm, BusinessHoursForm } from "./settings-form";
import { requirePageStaff } from "@/lib/auth/page";
import { and, asc, eq, gt } from "drizzle-orm";
import { formatInZone } from "@/lib/tz";
import { ScheduleBlockManager } from "./schedule-block-manager";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  await requirePageStaff("manage_settings");
  const settings = await getSettings();
  const hours = await db().select().from(schema.businessHours);
  const [blocks, staff, bays] = await Promise.all([
    db().select().from(schema.scheduleBlocks).where(gt(schema.scheduleBlocks.endsAt, new Date())).orderBy(asc(schema.scheduleBlocks.startsAt)),
    db().select({ id: schema.staffUsers.id, name: schema.staffUsers.name }).from(schema.staffUsers)
      .where(eq(schema.staffUsers.active, true)).orderBy(asc(schema.staffUsers.name)),
    db().select({ id: schema.resources.id, name: schema.resources.name }).from(schema.resources)
      .where(and(eq(schema.resources.active, true), eq(schema.resources.type, "bay"))).orderBy(asc(schema.resources.name)),
  ]);
  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold text-white">Business settings</h1>
      <p className="mt-1 text-sm text-ink-400">
        These values drive the public website, booking rules and tax
        calculations. Changes are audited. Fields marked * still need
        confirmed real values from the owner.
      </p>
      <SettingsForm initial={settings} />
      <BusinessHoursForm
        initialHours={hours.map((h) => ({
          weekday: h.weekday,
          closed: h.closed,
          open: h.open,
          close: h.close,
        }))}
      />
      <ScheduleBlockManager
        staff={staff}
        bays={bays}
        blocks={blocks.map((block) => ({
          id: block.id,
          type: block.resourceId ? "bay" : block.staffUserId ? "staff" : "closure",
          targetName: block.resourceId
            ? bays.find((bay) => bay.id === block.resourceId)?.name ?? "Unknown bay"
            : block.staffUserId
              ? staff.find((person) => person.id === block.staffUserId)?.name ?? "Unknown staff"
              : "Whole business",
          startsLabel: formatInZone(block.startsAt, settings.timezone, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }),
          endsLabel: formatInZone(block.endsAt, settings.timezone, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }),
          reason: block.reason ?? "No reason recorded",
        }))}
      />
    </div>
  );
}
