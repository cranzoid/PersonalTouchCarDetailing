import Link from "next/link";
import { desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { requirePageStaff } from "@/lib/auth/page";
import { roleHas } from "@/lib/auth/permissions";
import { compareLabels } from "@/lib/option-search";
import { getSettings } from "@/lib/settings";
import { formatInZone } from "@/lib/tz";
import { formatClaimCode } from "@/lib/wash-offer";
import { card, heading, subtle } from "../../ui";
import { CounterRedeem } from "./counter-redeem";

export const dynamic = "force-dynamic";

/**
 * The counter screen for a first-wash code — above all for the customer who
 * walks in holding one instead of booking. Reception can use it: it records a
 * plate and links a customer, and never moves money.
 */
export default async function RedeemWashCodePage() {
  const staff = await requirePageStaff("manage_bookings");
  const settings = await getSettings();
  const canSeeClaims = roleHas(staff.role, "manage_marketing");

  const [customers, vehicles, recent] = await Promise.all([
    db()
      .select({
        id: schema.customers.id,
        firstName: schema.customers.firstName,
        lastName: schema.customers.lastName,
        companyName: schema.customers.companyName,
        customerType: schema.customers.customerType,
        email: schema.customers.email,
        phone: schema.customers.phone,
        phoneNormalized: schema.customers.phoneNormalized,
      })
      .from(schema.customers)
      .where(isNull(schema.customers.anonymizedAt)),
    db()
      .select({ customerId: schema.vehicles.customerId, licencePlate: schema.vehicles.licencePlate })
      .from(schema.vehicles)
      .where(isNotNull(schema.vehicles.licencePlate)),
    db()
      .select({
        id: schema.offerClaims.id,
        code: schema.offerClaims.code,
        firstName: schema.offerClaims.firstName,
        lastName: schema.offerClaims.lastName,
        plate: schema.offerClaims.redeemedPlateNormalized,
        redeemedAt: schema.offerClaims.redeemedAt,
        appointmentId: schema.offerClaims.appointmentId,
        customerId: schema.offerClaims.customerId,
        staffName: schema.staffUsers.name,
      })
      .from(schema.offerClaims)
      .leftJoin(schema.staffUsers, eq(schema.staffUsers.id, schema.offerClaims.redeemedByStaffId))
      .where(isNotNull(schema.offerClaims.redeemedAt))
      .orderBy(desc(schema.offerClaims.redeemedAt))
      .limit(10),
  ]);

  const platesByCustomer = new Map<string, string[]>();
  for (const vehicle of vehicles) {
    if (!vehicle.licencePlate) continue;
    platesByCustomer.set(vehicle.customerId, [
      ...(platesByCustomer.get(vehicle.customerId) ?? []),
      vehicle.licencePlate,
    ]);
  }

  // Same labels and search terms as the invoice builder's picker, plus plates,
  // so a customer created by hand a minute ago is found by the plate on the car.
  const customerOptions = customers
    .map((c) => {
      const plates = platesByCustomer.get(c.id) ?? [];
      return {
        value: c.id,
        label:
          c.customerType === "business" && c.companyName
            ? `${c.companyName} — ${c.firstName} ${c.lastName}`
            : `${c.firstName} ${c.lastName}`,
        hint: [c.phone ?? c.email ?? "No contact method", ...plates].join(" · "),
        searchText: [c.companyName, c.email, c.phone, c.phoneNormalized, ...plates].filter(Boolean).join(" "),
      };
    })
    .sort((a, b) => compareLabels(a.label, b.label));

  return (
    <div className="max-w-[64rem]">
      <header>
        {canSeeClaims && (
          <Link href="/admin/marketing/offer-claims" className="text-xs font-semibold text-[#8A681F] hover:underline">
            ← Offer claims
          </Link>
        )}
        <h1 className="mt-1 text-2xl font-bold text-[#0B2A4A]">Redeem a wash code</h1>
        <p className={`mt-1 max-w-3xl ${subtle}`}>
          For a customer who brings a first-wash code to the counter — booked or not. Enter the code,
          record the licence plate and link the customer. Once redeemed, that plate can never get the
          offer again, and the lead is marked <strong>Completed</strong>. Charge the offer price on the
          invoice as usual.
        </p>
      </header>

      <CounterRedeem
        customers={customerOptions}
        canCreateCustomer={roleHas(staff.role, "manage_customers")}
        canInvoice={roleHas(staff.role, "manage_invoices")}
      />

      <section className={`mt-6 ${card}`}>
        <h2 className={heading}>Recently redeemed</h2>
        {recent.length === 0 ? (
          <p className={`mt-3 ${subtle}`}>No codes have been redeemed yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-[#8494A5]">
                <tr>
                  <th className="py-2 pr-3 font-semibold">Code</th>
                  <th className="py-2 pr-3 font-semibold">Customer</th>
                  <th className="py-2 pr-3 font-semibold">Plate</th>
                  <th className="py-2 pr-3 font-semibold">How</th>
                  <th className="py-2 font-semibold">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EBF0F5]">
                {recent.map((row) => (
                  <tr key={row.id}>
                    <td className="py-2.5 pr-3 font-mono text-xs font-bold text-[#0B2A4A]">{formatClaimCode(row.code)}</td>
                    <td className="py-2.5 pr-3">
                      {row.customerId ? (
                        <Link href={`/admin/customers/${row.customerId}`} className="font-semibold text-[#0B2A4A] hover:underline">
                          {[row.firstName, row.lastName].filter(Boolean).join(" ")}
                        </Link>
                      ) : (
                        <span className="text-[#0B2A4A]">{[row.firstName, row.lastName].filter(Boolean).join(" ")}</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-xs text-[#0B2A4A]">{row.plate}</td>
                    <td className="py-2.5 pr-3 text-xs text-[#5A6B7D]">
                      {row.appointmentId ? (
                        <Link href={`/admin/appointments/${row.appointmentId}`} className="hover:underline">
                          Booked
                        </Link>
                      ) : (
                        "Walk-in"
                      )}
                    </td>
                    <td className="py-2.5 text-xs text-[#5A6B7D]">
                      {row.redeemedAt &&
                        formatInZone(row.redeemedAt, settings.timezone, {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      {row.staffName && ` · ${row.staffName}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
