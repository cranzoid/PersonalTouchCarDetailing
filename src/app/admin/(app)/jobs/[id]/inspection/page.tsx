import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { InspectionForm } from "./inspection-form";
import { requirePageStaff } from "@/lib/auth/page";

export const dynamic = "force-dynamic";

export default async function InspectionPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageStaff("work_jobs");
  const { id } = await params;
  const [job] = await db().select().from(schema.jobs).where(eq(schema.jobs.id, id)).limit(1);
  if (!job) notFound();

  // One inspection per job; a recorded one lives on the job detail page.
  const [existing] = await db()
    .select({ id: schema.inspections.id })
    .from(schema.inspections)
    .where(eq(schema.inspections.jobId, id))
    .limit(1);
  if (existing || !["checked_in", "inspection"].includes(job.status)) {
    redirect(`/admin/jobs/${id}`);
  }

  const [vehicle] = await db().select().from(schema.vehicles).where(eq(schema.vehicles.id, job.vehicleId)).limit(1);
  const [customer] = await db().select().from(schema.customers).where(eq(schema.customers.id, job.customerId)).limit(1);

  return (
    <div className="mx-auto max-w-xl">
      <Link href={`/admin/jobs/${id}`} className="text-sm text-ink-400 hover:text-accent-300">
        ← Back to job
      </Link>
      <h1 className="mt-2 text-2xl font-bold text-white">Vehicle check-in inspection</h1>
      <p className="mt-1 text-sm text-ink-400">
        {[vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(" ")} —{" "}
        {customer?.firstName} {customer?.lastName}. Walk the vehicle with the customer and record
        its condition before any work starts.
      </p>
      <InspectionForm jobId={id} />
    </div>
  );
}
