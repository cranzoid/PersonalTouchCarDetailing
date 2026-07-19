import { notFound } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { QuoteStatusSelect } from "../../status-select";

export const dynamic = "force-dynamic";

export default async function QuoteRequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const rows = await db().select().from(schema.quoteRequests).where(eq(schema.quoteRequests.id, id)).limit(1);
  const quote = rows[0];
  if (!quote) notFound();

  const lead = quote.leadId
    ? (await db().select().from(schema.leads).where(eq(schema.leads.id, quote.leadId)).limit(1))[0]
    : undefined;
  const requestedServices =
    quote.requestedServiceIds.length > 0
      ? await db()
          .select({ id: schema.services.id, name: schema.services.name })
          .from(schema.services)
          .where(inArray(schema.services.id, quote.requestedServiceIds))
      : [];
  const photos = await db()
    .select()
    .from(schema.files)
    .where(and(eq(schema.files.entityType, "quote_request"), eq(schema.files.entityId, id)));

  const v = quote.vehicleInfo;

  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-ink-500">{quote.id}</p>
          <h1 className="text-2xl font-bold text-white">Quote request — {lead?.name ?? "Unknown"}</h1>
        </div>
        <QuoteStatusSelect quoteRequestId={quote.id} status={quote.status} />
      </div>

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <section className="rounded-xl border border-ink-800 p-5 text-sm">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Contact</h2>
          {lead ? (
            <div className="mt-2 space-y-1 text-ink-300">
              <p className="font-medium text-white">{lead.name}</p>
              {lead.email && <p>{lead.email}</p>}
              {lead.phone && <p>{lead.phone}</p>}
              {lead.notes && <p className="text-xs text-accent-300">{lead.notes}</p>}
            </div>
          ) : (
            <p className="mt-2 text-ink-500">No lead record</p>
          )}
        </section>
        <section className="rounded-xl border border-ink-800 p-5 text-sm">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Vehicle</h2>
          <p className="mt-2 text-ink-300">
            {[v?.year, v?.make, v?.model].filter(Boolean).join(" ") || "Not specified"}
            {v?.category ? ` · ${v.category}` : ""}
          </p>
        </section>
      </div>

      <section className="mt-6 rounded-xl border border-ink-800 p-5 text-sm">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Requested services</h2>
        {requestedServices.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {requestedServices.map((s) => (
              <span key={s.id} className="rounded-full bg-ink-800 px-3 py-1 text-ink-200">{s.name}</span>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-ink-500">None selected</p>
        )}
      </section>

      <section className="mt-6 rounded-xl border border-ink-800 p-5 text-sm">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Condition description</h2>
        <p className="mt-2 whitespace-pre-wrap text-ink-300">{quote.conditionDescription ?? "—"}</p>
      </section>

      {photos.length > 0 && (
        <section className="mt-6 rounded-xl border border-ink-800 p-5">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">
            Photos ({photos.length}) — private, staff-only
          </h2>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {photos.map((p) => (
              // eslint-disable-next-line @next/next/no-img-element
              <a key={p.id} href={`/api/files/${p.id}`} target="_blank">
                <img
                  src={`/api/files/${p.id}`}
                  alt="Customer-submitted vehicle photo"
                  className="aspect-[4/3] w-full rounded-lg border border-ink-800 object-cover"
                />
              </a>
            ))}
          </div>
        </section>
      )}

      <p className="mt-8 text-xs text-ink-500">
        Estimate builder ships in Phase 2 — until then, reply to the customer directly and track
        the request status here.
      </p>
    </div>
  );
}
