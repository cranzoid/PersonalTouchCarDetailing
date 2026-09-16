import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { StatusBadge } from "@/components/admin";
import { requirePageStaff } from "@/lib/auth/page";
import { isFirstTimeDetailCustomer } from "@/lib/promotions";
import { getSettings } from "@/lib/settings";
import { formatClaimCode } from "@/lib/wash-offer";
import { LeadStatusSelect } from "../status-select";
import { LeadOperations } from "./lead-operations";

export const dynamic = "force-dynamic";

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageStaff("manage_customers");
  const { id } = await params;
  const lead = (await db().select().from(schema.leads).where(eq(schema.leads.id, id)).limit(1))[0];
  if (!lead) notFound();

  const staff = await db()
    .select({
      id: schema.staffUsers.id,
      name: schema.staffUsers.name,
      role: schema.staffUsers.role,
      active: schema.staffUsers.active,
    })
    .from(schema.staffUsers)
    .orderBy(desc(schema.staffUsers.active), asc(schema.staffUsers.name));
  const assigned = lead.assignedStaffId ? staff.find((user) => user.id === lead.assignedStaffId) : undefined;
  // Resolved here rather than exposed as a public endpoint: "is this address
  // one of your customers?" is only ever answered to signed-in staff.
  const offerEligible = lead.attribution?.promo
    ? await isFirstTimeDetailCustomer(
        db(),
        { email: lead.email, phone: lead.phone },
        (await getSettings()).promotion.eligibleServiceIds,
      )
    : false;
  const communications = await db()
    .select()
    .from(schema.communications)
    .where(eq(schema.communications.leadId, lead.id))
    .orderBy(desc(schema.communications.createdAt));
  const audits = await db()
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.entityType, "lead"), eq(schema.auditLog.entityId, lead.id)))
    .orderBy(desc(schema.auditLog.createdAt));
  const [washClaim] = await db()
    .select()
    .from(schema.offerClaims)
    .where(eq(schema.offerClaims.leadId, lead.id))
    .orderBy(desc(schema.offerClaims.createdAt))
    .limit(1);
  const quotes = await db()
    .select({
      id: schema.quoteRequests.id,
      status: schema.quoteRequests.status,
      estimateId: schema.quoteRequests.estimateId,
      createdAt: schema.quoteRequests.createdAt,
    })
    .from(schema.quoteRequests)
    .where(eq(schema.quoteRequests.leadId, lead.id))
    .orderBy(desc(schema.quoteRequests.createdAt));

  const nameWithoutCompany = lead.name.replace(/\s+\([^)]*\)\s*$/, "").trim();
  const nameParts = nameWithoutCompany.split(/\s+/).filter(Boolean);
  const companyMatch = lead.name.match(/\(([^)]*)\)\s*$/);
  const history = [
    {
      id: `lead-${lead.id}`,
      at: lead.createdAt,
      title: "Lead created",
      detail: `${lead.kind.replaceAll("_", " ")} inquiry`,
      href: null as string | null,
    },
    ...quotes.map((quote) => ({
      id: `quote-${quote.id}`,
      at: quote.createdAt,
      title: "Quote request created",
      detail: `Status: ${quote.status.replaceAll("_", " ")}`,
      href: `/admin/leads/quotes/${quote.id}`,
    })),
    ...communications.map((item) => ({
      id: `communication-${item.id}`,
      at: item.createdAt,
      title: `${item.channel.toUpperCase()} · ${item.kind.replaceAll("_", " ")}`,
      detail: item.subject || item.body.slice(0, 180),
      href: null,
    })),
    ...audits.map((entry) => ({
      id: `audit-${entry.id}`,
      at: entry.createdAt,
      title: entry.action.replaceAll("_", " ").replaceAll(".", " · "),
      detail: entry.reason || null,
      href: null,
    })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  return (
    <div className="max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono text-xs text-ink-500">{lead.id}</p>
          <h1 className="text-2xl font-bold text-white">{lead.name}</h1>
          <p className="mt-1 text-sm capitalize text-ink-400">
            {lead.kind.replaceAll("_", " ")} lead · assigned to {assigned?.name ?? "nobody"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge status={lead.status} />
          <LeadStatusSelect leadId={lead.id} status={lead.status} linkedToCustomer={Boolean(lead.convertedCustomerId)} />
        </div>
      </div>

      <div className="mt-7 grid gap-5 md:grid-cols-2">
        <section className="rounded-xl border border-ink-800 p-5">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Contact</h2>
          <div className="mt-3 space-y-2 text-sm text-ink-300">
            {lead.email ? <a className="block hover:text-accent-300" href={`mailto:${lead.email}`}>{lead.email}</a> : <p>No email</p>}
            {lead.phone ? <a className="block hover:text-accent-300" href={`tel:${lead.phone}`}>{lead.phone}</a> : <p>No phone</p>}
            <p className={lead.marketingConsent ? "text-emerald-300" : "text-ink-500"}>
              {lead.marketingConsent ? `Marketing consent · ${lead.marketingConsentSource ?? "recorded"}` : "No marketing consent"}
            </p>
          </div>
          {lead.message && <p className="mt-4 whitespace-pre-wrap border-t border-ink-800 pt-4 text-sm text-ink-300">{lead.message}</p>}
        </section>

        <section className="rounded-xl border border-ink-800 p-5">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Conversion</h2>
          {lead.convertedCustomerId ? (
            <div className="mt-3 text-sm">
              <p className="text-emerald-300">Converted to a customer.</p>
              <Link className="mt-2 inline-block text-accent-300 hover:underline" href={`/admin/customers/${lead.convertedCustomerId}`}>
                View customer →
              </Link>
            </div>
          ) : (
            <p className="mt-3 text-sm text-ink-400">Use the conversion form below to create a linked customer record.</p>
          )}
          {quotes.length > 0 && (
            <div className="mt-4 border-t border-ink-800 pt-3 text-sm">
              <p className="text-ink-500">Quote requests</p>
              {quotes.map((quote) => (
                <Link key={quote.id} href={`/admin/leads/quotes/${quote.id}`} className="mt-1 block text-accent-300 hover:underline">
                  {quote.id} · {quote.status.replaceAll("_", " ")}
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>

      <LeadOperations
        lead={{
          id: lead.id,
          email: lead.email,
          phone: lead.phone,
          notes: lead.notes,
          assignedStaffId: lead.assignedStaffId,
          convertedCustomerId: lead.convertedCustomerId,
          marketingConsent: lead.marketingConsent,
        }}
        staff={staff}
        conversionDefaults={{
          firstName: nameParts[0] ?? lead.name,
          lastName: nameParts.slice(1).join(" "),
          customerType: lead.kind === "fleet" ? "business" : "individual",
          companyName: companyMatch?.[1] ?? "",
          preferredContact: lead.email ? "email" : "phone",
        }}
      />

      {washClaim && (
        <section className="mt-8 rounded-xl border border-ink-800 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">First-wash code</h2>
            <span className="rounded-full border border-slate-200 bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-700">
              {WASH_CLAIM_LABELS[washClaimStatus(washClaim)] ?? washClaimStatus(washClaim)}
            </span>
          </div>
          <p className="mt-2 font-mono text-base font-bold text-white">{formatClaimCode(washClaim.code)}</p>
          <p className="mt-1 text-sm text-ink-300">
            {washClaim.redeemedPlateNormalized
              ? `Washed — plate ${washClaim.redeemedPlateNormalized}.`
              : washClaim.status === "booked"
                ? "Booked, not yet washed."
                : washClaimStatus(washClaim) === "expired"
                  ? "Expired without being used."
                  : washClaim.status === "void"
                    ? "Released."
                    : `Not booked yet — valid until ${washClaim.expiresAt.toISOString().slice(0, 10)}.`}{" "}
            Nudges sent: {washClaim.smsNudgesSent} text{washClaim.smsNudgesSent === 1 ? "" : "s"},{" "}
            {washClaim.emailNudgesSent} email{washClaim.emailNudgesSent === 1 ? "" : "s"}.
          </p>
          <div className="mt-3 flex flex-wrap gap-3 text-sm">
            {washClaim.appointmentId && (
              <Link href={`/admin/appointments/${washClaim.appointmentId}`} className="text-accent-300 hover:underline">
                View appointment →
              </Link>
            )}
            {!washClaim.redeemedPlateNormalized && washClaim.status !== "void" && (
              <Link href="/admin/marketing/offer-claims/redeem" className="text-accent-300 hover:underline">
                Redeem at the counter →
              </Link>
            )}
            {washClaimStatus(washClaim) === "issued" && (
              <Link href="/admin/marketing/wash-nudges" className="text-accent-300 hover:underline">
                Send a nudge →
              </Link>
            )}
          </div>
        </section>
      )}

      {lead.attribution?.promo && (
        <section
          className={`mt-8 rounded-xl border p-5 ${
            offerEligible
              ? "border-emerald-400/30 bg-emerald-950/20"
              : "border-amber-400/30 bg-amber-950/20"
          }`}
        >
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Ad offer</h2>
          <p className={`mt-2 text-sm ${offerEligible ? "text-emerald-200" : "text-amber-200"}`}>
            Arrived on <strong>{lead.attribution.promo.code}</strong> —{" "}
            {lead.attribution.promo.label}, {lead.attribution.promo.percentOffBp / 100}% off.{" "}
            {offerEligible
              ? "Eligible — apply it when you build the estimate."
              : "Not eligible: this customer has had a detail with us before, or already holds a discounted booking."}
          </p>
        </section>
      )}

      <section className="mt-8 rounded-xl border border-ink-800 p-5">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">Attribution</h2>
        {lead.attribution && Object.keys(lead.attribution).length > 0 ? (
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            {Object.entries(lead.attribution).map(([key, value]) => (
              <div key={key} className="rounded-lg bg-ink-900/40 p-3">
                <dt className="text-xs uppercase tracking-wider text-ink-500">{key}</dt>
                <dd className="mt-1 break-words text-ink-200">{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd>
              </div>
            ))}
          </dl>
        ) : <p className="mt-3 text-sm text-ink-500">No attribution data captured.</p>}
      </section>

      <section className="mt-8 rounded-xl border border-ink-800 p-5">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-400">History</h2>
        <div className="mt-4 space-y-3">
          {history.map((item) => (
            <div key={item.id} className="border-l border-ink-700 pl-4 text-sm">
              <div className="flex flex-wrap justify-between gap-2">
                {item.href ? <Link href={item.href} className="font-medium text-accent-300 hover:underline">{item.title}</Link> : <p className="font-medium capitalize text-ink-200">{item.title}</p>}
                <time className="text-xs text-ink-600">{item.at.toISOString().replace("T", " ").slice(0, 16)} UTC</time>
              </div>
              {item.detail && <p className="mt-1 text-ink-500">{item.detail}</p>}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

const WASH_CLAIM_LABELS: Record<string, string> = {
  issued: "Code not used",
  booked: "Booked",
  redeemed: "Washed",
  expired: "Expired",
  void: "Released",
};

/** The claim's status as staff should read it: an out-of-date code is expired. */
function washClaimStatus(claim: { status: string; expiresAt: Date }): string {
  return claim.status === "issued" && claim.expiresAt.getTime() <= Date.now() ? "expired" : claim.status;
}
