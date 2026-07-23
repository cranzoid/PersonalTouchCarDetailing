import { asc, desc } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePageStaff } from "@/lib/auth/page";
import { StaffManager } from "./staff-manager";

export const dynamic = "force-dynamic";

export default async function StaffPage() {
  const currentStaff = await requirePageStaff("manage_staff");
  const staff = await db()
    .select({
      id: schema.staffUsers.id,
      name: schema.staffUsers.name,
      email: schema.staffUsers.email,
      role: schema.staffUsers.role,
      active: schema.staffUsers.active,
      skills: schema.staffUsers.skills,
      createdAt: schema.staffUsers.createdAt,
    })
    .from(schema.staffUsers)
    .orderBy(desc(schema.staffUsers.active), asc(schema.staffUsers.name));
  const schedules = await db().select().from(schema.staffSchedules).orderBy(asc(schema.staffSchedules.weekday));

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold text-white">Staff access</h1>
      <p className="mt-1 text-sm text-ink-400">
        Owner-only account management. Role changes, deactivations and password resets are audited.
      </p>
      <StaffManager
        currentStaffId={currentStaff.id}
        initialStaff={staff.map((user) => ({
          ...user,
          createdAt: user.createdAt.toISOString(),
          shifts: schedules.filter((shift) => shift.staffUserId === user.id).map((shift) => ({
            weekday: shift.weekday,
            start: shift.start,
            end: shift.end,
          })),
        }))}
      />
    </div>
  );
}
