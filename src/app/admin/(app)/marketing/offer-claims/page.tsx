import Link from "next/link";
import { desc, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePageStaff } from "@/lib/auth/page";
import { formatPhone } from "@/lib/phone";
import { getSettings } from "@/lib/settings";
import { formatInZone } from "@/lib/tz";
import { activeWashOffer, formatClaimCode } from "@/lib/wash-offer";
import { card, heading, subtle } from "../ui";
import { ClaimRowActions } from "./claim-actions";

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<string, { label: string; tone: string }> = {
  issued: { label: "Code issued", tone: "bg-[#EEF2F7] text-[#42536A]" },
  booked: { label: "Booked", tone: "bg-[#E7F2EA] text-emerald-800" },
  redeemed: { label: "Washed", tone: "bg-[#0B2A4A] text-white admin-on-dark" },
  expired: { label: "Expired", tone: "bg-[#F7EFE2] text-[#8A681F]" },
  void: { label: "Released", tone: "bg-[#F6E9E9] text-red-800" },
};

export default async function OfferClaimsPage() {
  await requirePageStaff("manage_marketing");
  const settings = await getSettings();
  const offer = activeWashOffer(settings);

  const claims = await db()
    .select()
    .from(schema.offerClaims)
    .orderBy(desc(schema.offerClaims.createdAt))
    .limit(500);

  const counts = await db()
    .select({ status: schema.offerClaims.status, total: sql<number>`count(*)::int` })
    .from(schema.offerClaims)
    .groupBy(schema.offerClaims.status);
  const countFor = (status: string) => counts.find((row) => row.status === status)?.total ?? 0;

  const date = (value: Date) =>
    formatInZone(value, settings.timezone, { year: "numeric", month: "short", day: "numeric" });

  return (
    <div className="max-w-[78rem]">
      <header>
        <Link href="/admin/marketing" className="text-xs font-semibold text-[#8A681F] hover:underline">
          ← All campaigns
        </Link>
        <h1 className="mt-1 text-2xl font-bold text-[#0B2A4A]">Offer claims</h1>
        <p className={`mt-1 max-w-3xl ${subtle}`}>
          Everyone who has claimed the new-customer wash. A code becomes <strong>Booked</strong> when
          it is spent on an appointment, and <strong>Washed</strong> once the licence plate is
          recorded at the counter — which is what stops the same vehicle coming back for a second
          promotional wash.
        </p>
      </header>

      {!offer && (
        <p className={`mt-4 rounded-xl border border-[#E3D8BF] bg-[#FBF6EC] p-4 text-sm text-[#8A681F]`}>
          The wash offer is currently switched off, so the landing page is not accepting new claims.
          Codes already issued are still listed below and can still be honoured.{" "}
          <Link href="/admin/settings" className="font-semibold underline">
            Settings
          </Link>
        </p>
      )}

      <div className="mt-6 grid gap-3 sm:grid-cols-4">
        {(
          [
            ["Codes issued", countFor("issued")],
            ["Booked", countFor("booked")],
            ["Washed", countFor("redeemed")],
            ["Expired unused", countFor("expired")],
          ] as const
        ).map(([title, value]) => (
          <div key={title} className={card}>
            <p className={subtle}>{title}</p>
            <p className="mt-1 text-2xl font-bold text-[#0B2A4A]">{value}</p>
          </div>
        ))}
      </div>

      <div className={`mt-6 overflow-x-auto ${card}`}>
        <h2 className={heading}>Claims</h2>
        {claims.length === 0 ? (
          <p className={`mt-3 ${subtle}`}>No codes have been claimed yet.</p>
        ) : (
          <table className="mt-4 w-full min-w-[56rem] text-left text-sm">
            <thead>
              <tr className="border-b border-[#E4EAF0] text-xs uppercase tracking-wider text-[#5A6B7D]">
                <th className="py-2.5 pr-4">Code</th>
                <th className="py-2.5 pr-4">Customer</th>
                <th className="py-2.5 pr-4">Status</th>
                <th className="py-2.5 pr-4">Claimed</th>
                <th className="py-2.5 pr-4">Expires</th>
                <th className="py-2.5 pr-4">Plate</th>
                <th className="py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#EEF2F6]">
              {claims.map((claim) => {
                const stale = claim.status === "issued" && claim.expiresAt.getTime() <= Date.now();
                const status = STATUS_LABELS[stale ? "expired" : claim.status] ?? {
                  label: claim.status,
                  tone: "bg-[#EEF2F7] text-[#42536A]",
                };
                return (
                  <tr key={claim.id} className="align-top">
                    <td className="py-3 pr-4 font-mono text-xs font-bold text-[#0B2A4A]">
                      {formatClaimCode(claim.code)}
                      {claim.marketingConsent && (
                        <span className="mt-1 block font-sans text-[0.65rem] font-semibold text-emerald-700">
                          Marketing consent ✓
                        </span>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      <span className="font-semibold text-[#0B2A4A]">
                        {[claim.firstName, claim.lastName].filter(Boolean).join(" ")}
                      </span>
                      <span className="mt-0.5 block text-xs text-[#5A6B7D]">
                        {claim.phone ? formatPhone(claim.phone) : claim.email}
                      </span>
                      <span className="mt-0.5 block text-xs text-[#8592A0]">
                        Said: {claim.vehicleSize === "suv" ? "SUV / truck" : "Car"}
                      </span>
                    </td>
                    <td className="py-3 pr-4">
                      <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-semibold ${status.tone}`}>
                        {status.label}
                      </span>
                      {claim.appointmentId && (
                        <Link
                          href={`/admin/appointments/${claim.appointmentId}`}
                          className="mt-1 block text-xs font-semibold text-[#8A681F] hover:underline"
                        >
                          View appointment
                        </Link>
                      )}
                      {claim.voidReason && (
                        <span className="mt-1 block text-xs text-[#8592A0]">{claim.voidReason}</span>
                      )}
                    </td>
                    <td className="py-3 pr-4 text-xs text-[#5A6B7D]">{date(claim.createdAt)}</td>
                    <td className="py-3 pr-4 text-xs text-[#5A6B7D]">{date(claim.expiresAt)}</td>
                    <td className="py-3 pr-4 font-mono text-xs text-[#0B2A4A]">
                      {claim.redeemedPlateNormalized ?? "—"}
                    </td>
                    <td className="py-3">
                      <ClaimRowActions
                        claimId={claim.id}
                        code={formatClaimCode(claim.code)}
                        canResend={claim.status === "issued" && !stale}
                        canRelease={claim.status !== "void" && claim.status !== "redeemed"}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
