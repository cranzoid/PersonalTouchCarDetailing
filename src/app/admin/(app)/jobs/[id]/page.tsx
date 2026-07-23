import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { StatusBadge } from "@/components/admin";
import { formatCents } from "@/lib/money";
import { formatInZone } from "@/lib/tz";
import { getSettings } from "@/lib/settings";
import { isQcComplete } from "@/lib/jobs";
import { JobTransitionButtons } from "./job-transition-buttons";
import { AdditionalWorkPanel } from "./additional-work";
import { QcChecklistForm } from "./qc-checklist";
import { PhotoUpload } from "./photo-upload";
import { NotesForm } from "./notes-form";
import { CreateInvoiceButton } from "./create-invoice-button";
import { requirePageStaff } from "@/lib/auth/page";
import { PhotoConsentButton } from "./photo-consent-button";

export const dynamic = "force-dynamic";

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageStaff("work_jobs");
  const { id } = await params;
  const settings = await getSettings();

  const [job] = await db().select().from(schema.jobs).where(eq(schema.jobs.id, id)).limit(1);
  if (!job) notFound();

  const [customer] = await db().select().from(schema.customers).where(eq(schema.customers.id, job.customerId)).limit(1);
  const [vehicle] = await db().select().from(schema.vehicles).where(eq(schema.vehicles.id, job.vehicleId)).limit(1);
  const appointment = job.appointmentId
    ? (await db().select().from(schema.appointments).where(eq(schema.appointments.id, job.appointmentId)).limit(1))[0]
    : null;
  const appointmentLines = appointment
    ? await db()
        .select()
        .from(schema.appointmentServices)
        .where(eq(schema.appointmentServices.appointmentId, appointment.id))
        .orderBy(asc(schema.appointmentServices.sort))
    : [];
  const resource = job.resourceId
    ? (await db().select().from(schema.resources).where(eq(schema.resources.id, job.resourceId)).limit(1))[0]
    : null;

  const [inspection] = await db()
    .select()
    .from(schema.inspections)
    .where(eq(schema.inspections.jobId, id))
    .limit(1);
  const findings = inspection
    ? await db()
        .select()
        .from(schema.inspectionFindings)
        .where(eq(schema.inspectionFindings.inspectionId, inspection.id))
    : [];

  const workRequests = await db()
    .select()
    .from(schema.additionalWorkRequests)
    .where(eq(schema.additionalWorkRequests.jobId, id))
    .orderBy(desc(schema.additionalWorkRequests.createdAt));

  const [qc] = await db().select().from(schema.qcChecklists).where(eq(schema.qcChecklists.jobId, id)).limit(1);

  const photoParents: [string, string][] = [["job", id]];
  if (inspection) photoParents.push(["inspection", inspection.id]);
  const photos = await db()
    .select()
    .from(schema.files)
    .where(
      inArray(
        schema.files.entityId,
        photoParents.map(([, entityId]) => entityId),
      ),
    )
    .orderBy(desc(schema.files.createdAt));
  const jobPhotos = photos.filter(
    (f) =>
      (f.entityType === "job" && f.entityId === id) ||
      (inspection && f.entityType === "inspection" && f.entityId === inspection.id),
  );

  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-ink-500">{job.id}</p>
          <h1 className="text-2xl font-bold text-white">
            {[vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(" ") || "Job"}
          </h1>
          <p className="mt-1 text-sm text-ink-400">
            {customer && (
              <Link href={`/admin/customers/${customer.id}`} className="text-accent-300 hover:underline">
                {customer.firstName} {customer.lastName}
              </Link>
            )}
            {resource ? ` · ${resource.name}` : ""}
            {job.mileageIn !== null ? ` · ${job.mileageIn.toLocaleString("en-CA")} km in` : ""}
          </p>
        </div>
        <StatusBadge status={job.status} />
      </div>

      <JobTransitionButtons jobId={job.id} status={job.status} qcComplete={!!qc && isQcComplete(qc.items)} />

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <section className="rounded-xl border border-ink-800 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">Timeline</h2>
          <dl className="mt-2 space-y-1 text-sm">
            <TimeRow label="Checked in" at={job.createdAt} tz={settings.timezone} />
            {inspection?.completedAt && <TimeRow label="Inspected" at={inspection.completedAt} tz={settings.timezone} />}
            {job.startedAt && <TimeRow label="Work started" at={job.startedAt} tz={settings.timezone} />}
            {qc?.completedAt && <TimeRow label="QC passed" at={qc.completedAt} tz={settings.timezone} />}
            {job.completedAt && <TimeRow label="Completed" at={job.completedAt} tz={settings.timezone} />}
          </dl>
        </section>
        <section className="rounded-xl border border-ink-800 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">Booked services</h2>
          {appointment ? (
            <div className="mt-2 text-sm">
              {appointmentLines.map((l) => (
                <div key={l.id} className="flex justify-between gap-3 py-1">
                  <span className="text-ink-200">{l.description}</span>
                  <span className="text-ink-400">{formatCents(l.priceCents)}</span>
                </div>
              ))}
              <div className="mt-2 flex justify-between border-t border-ink-800 pt-2">
                <span className="text-ink-400">Booked total (incl. tax)</span>
                <span className="font-medium text-ink-200">{formatCents(appointment.totalCents)}</span>
              </div>
              <Link href={`/admin/appointments/${appointment.id}`} className="mt-2 inline-block text-accent-300 hover:underline">
                View appointment →
              </Link>
            </div>
          ) : (
            <p className="mt-2 text-sm text-ink-500">No linked appointment.</p>
          )}
        </section>
      </div>

      <section className="mt-6 rounded-xl border border-ink-800 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">Inspection</h2>
          {!inspection && ["checked_in", "inspection"].includes(job.status) && (
            <Link
              href={`/admin/jobs/${job.id}/inspection`}
              className="rounded-lg bg-accent-400 px-3 py-1.5 text-sm font-medium text-ink-950 hover:bg-accent-300"
            >
              Start inspection
            </Link>
          )}
        </div>
        {inspection ? (
          <div className="mt-3 space-y-3 text-sm">
            <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
              {inspection.mileage !== null && (
                <InfoRow label="Mileage" value={`${inspection.mileage.toLocaleString("en-CA")} km`} />
              )}
              {inspection.customerConcerns && <InfoRow label="Customer concerns" value={inspection.customerConcerns} />}
              {inspection.personalBelongings && <InfoRow label="Belongings" value={inspection.personalBelongings} />}
              {inspection.additionalWorkIdentified && (
                <InfoRow label="Additional work identified" value={inspection.additionalWorkIdentified} />
              )}
            </dl>
            {findings.length > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-ink-500">Findings</p>
                <ul className="mt-1 space-y-1">
                  {findings.map((f) => (
                    <li key={f.id} className="text-ink-300">
                      <span className="capitalize text-ink-200">{f.area.replaceAll("_", " ")}</span> —{" "}
                      {f.type.replaceAll("_", " ")} ({f.severity})
                      {f.description ? `: ${f.description}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <p className="mt-2 text-sm text-ink-500">
            {["checked_in", "inspection"].includes(job.status)
              ? "Not recorded yet — walk the vehicle with the customer before work starts."
              : "No inspection was recorded for this job."}
          </p>
        )}
      </section>

      {(job.invoiceId || ["ready_for_pickup", "completed"].includes(job.status)) && (
        <section className="mt-6 rounded-xl border border-ink-800 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">Invoice</h2>
          {job.invoiceId ? (
            <Link href={`/admin/invoices/${job.invoiceId}`} className="mt-2 inline-block text-accent-300 hover:underline">
              View invoice →
            </Link>
          ) : (
            <div className="mt-3">
              <p className="mb-3 text-sm text-ink-500">
                Builds an invoice from the booked services plus any approved additional work.
              </p>
              <CreateInvoiceButton jobId={job.id} />
            </div>
          )}
        </section>
      )}

      <AdditionalWorkPanel
        jobId={job.id}
        jobStatus={job.status}
        requests={workRequests.map((r) => ({
          id: r.id,
          description: r.description,
          priceCents: r.priceCents,
          extraMinutes: r.extraMinutes,
          status: r.status,
          decidedVia: r.decidedVia,
          overrideReason: r.overrideReason,
        }))}
      />

      <QcChecklistForm
        jobId={job.id}
        items={qc?.items ?? {}}
        notes={qc?.notes ?? ""}
        completedAt={qc?.completedAt?.toISOString() ?? null}
      />

      <section className="mt-6 rounded-xl border border-ink-800 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-400">Photos</h2>
        {jobPhotos.length > 0 ? (
          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
            {jobPhotos.map((f) => (
              <div key={f.id}>
                <a href={`/api/files/${f.id}`} target="_blank" rel="noopener noreferrer" className="group relative block">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/files/${f.id}`}
                    alt={`${f.kind.replaceAll("_", " ")} photo for this job`}
                    className="aspect-square w-full rounded-lg border border-ink-800 object-cover"
                  />
                  <span className="absolute bottom-1 left-1 rounded bg-ink-950/80 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-300">
                    {f.kind}
                  </span>
                </a>
                <PhotoConsentButton fileId={f.id} consented={Boolean(f.publicConsentAt)} />
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-ink-500">No photos yet.</p>
        )}
        <PhotoUpload jobId={job.id} />
      </section>

      <NotesForm jobId={job.id} internalNotes={job.internalNotes ?? ""} />
    </div>
  );
}

function TimeRow({ label, at, tz }: { label: string; at: Date; tz: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-ink-500">{label}</dt>
      <dd className="text-ink-300">
        {formatInZone(at, tz, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
      </dd>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-ink-500">{label}</dt>
      <dd className="whitespace-pre-wrap text-ink-300">{value}</dd>
    </div>
  );
}
