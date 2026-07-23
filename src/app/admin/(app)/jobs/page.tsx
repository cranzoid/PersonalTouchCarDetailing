import Link from "next/link";
import { desc, eq, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import { StatusBadge } from "@/components/admin";
import { JOB_STATUSES, type JobStatus } from "@/lib/types";
import { requirePageStaff } from "@/lib/auth/page";

export const dynamic = "force-dynamic";

/** Board order mirrors the physical flow through the shop. */
const BOARD_ORDER: JobStatus[] = [
  "checked_in",
  "inspection",
  "awaiting_approval",
  "ready",
  "in_progress",
  "paused",
  "quality_check",
  "correction_required",
  "ready_for_pickup",
];

export default async function JobsPage() {
  await requirePageStaff("work_jobs");
  const active = await db()
    .select({ job: schema.jobs, customer: schema.customers, vehicle: schema.vehicles })
    .from(schema.jobs)
    .innerJoin(schema.customers, eq(schema.jobs.customerId, schema.customers.id))
    .innerJoin(schema.vehicles, eq(schema.jobs.vehicleId, schema.vehicles.id))
    .where(ne(schema.jobs.status, "completed"))
    .orderBy(desc(schema.jobs.createdAt))
    .limit(200);
  const recentDone = await db()
    .select({ job: schema.jobs, customer: schema.customers, vehicle: schema.vehicles })
    .from(schema.jobs)
    .innerJoin(schema.customers, eq(schema.jobs.customerId, schema.customers.id))
    .innerJoin(schema.vehicles, eq(schema.jobs.vehicleId, schema.vehicles.id))
    .where(eq(schema.jobs.status, "completed"))
    .orderBy(desc(schema.jobs.completedAt))
    .limit(20);

  const byStatus = new Map<string, typeof active>();
  for (const row of active) {
    const list = byStatus.get(row.job.status) ?? [];
    list.push(row);
    byStatus.set(row.job.status, list);
  }
  const unknownStatus = active.filter(
    (r) => !(JOB_STATUSES as readonly string[]).includes(r.job.status),
  );

  return (
    <div>
      <h1 className="text-2xl font-bold text-white">Jobs</h1>
      <p className="mt-1 text-sm text-ink-400">
        Vehicles currently in the shop. Check in an arrived appointment to start a job.
      </p>

      <div className="mt-6 space-y-6">
        {BOARD_ORDER.map((status) => {
          const rows = byStatus.get(status) ?? [];
          if (rows.length === 0) return null;
          return <StatusSection key={status} status={status} rows={rows} />;
        })}
        {unknownStatus.length > 0 && (
          <StatusSection status="other" rows={unknownStatus} />
        )}
        {active.length === 0 && (
          <div className="rounded-xl border border-ink-800 px-4 py-10 text-center text-sm text-ink-500">
            No active jobs. Mark an appointment as arrived, then check the vehicle in.
          </div>
        )}
      </div>

      {recentDone.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">
            Recently completed
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {recentDone.map((row) => (
              <JobCard key={row.job.id} row={row} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function StatusSection({
  status,
  rows,
}: {
  status: string;
  rows: {
    job: typeof schema.jobs.$inferSelect;
    customer: typeof schema.customers.$inferSelect;
    vehicle: typeof schema.vehicles.$inferSelect;
  }[];
}) {
  return (
    <section>
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">
          {status.replaceAll("_", " ")}
        </h2>
        <span className="rounded-full bg-ink-800 px-2 py-0.5 text-xs text-ink-300">{rows.length}</span>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => (
          <JobCard key={row.job.id} row={row} />
        ))}
      </div>
    </section>
  );
}

function JobCard({
  row,
}: {
  row: {
    job: typeof schema.jobs.$inferSelect;
    customer: typeof schema.customers.$inferSelect;
    vehicle: typeof schema.vehicles.$inferSelect;
  };
}) {
  const { job, customer, vehicle } = row;
  return (
    <Link
      href={`/admin/jobs/${job.id}`}
      className="block rounded-xl border border-ink-800 p-4 hover:border-ink-600 hover:bg-ink-900/40"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium text-white">
          {[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ")}
        </p>
        <StatusBadge status={job.status} />
      </div>
      <p className="mt-1 text-sm text-ink-300">
        {customer.firstName} {customer.lastName}
      </p>
      <p className="mt-2 text-xs text-ink-500">
        Checked in {job.createdAt.toLocaleDateString("en-CA")}
        {job.startedAt && <> · started {job.startedAt.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })}</>}
      </p>
    </Link>
  );
}
