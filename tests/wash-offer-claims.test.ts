import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import { SETTINGS_DEFAULTS, type BusinessSettings } from "../src/lib/settings";
import { zonedWeekday } from "../src/lib/tz";
import { createAppointment, OfferChangedError } from "../src/lib/booking/create";
import { getAvailableSlots } from "../src/lib/booking/availability";
import { priceBooking } from "../src/lib/pricing";
import { activeWashOffer } from "../src/lib/wash-offer";
import {
  claimBelongsTo,
  issueClaim,
  lookupClaim,
  redeemClaimAgainstPlate,
  claimsDueReminder,
  recordClaimReminder,
  expireStaleClaims,
} from "../src/lib/wash-offer-claims";

/**
 * The new-customer wash offer end to end, at the two places it can cost the
 * shop real money if it breaks:
 *
 *  - the caps. One wash per person, one per licence plate. Both are kept by
 *    partial unique indexes, so these tests race them rather than trusting the
 *    SELECT that precedes each write.
 *  - the price. A claim must buy exactly the advertised figure, and must buy it
 *    once — a code that survives its own booking is a discount with no bottom.
 */

const settings: BusinessSettings = {
  ...SETTINGS_DEFAULTS,
  washOffer: { ...SETTINGS_DEFAULTS.washOffer, enabled: true },
};
const tz = settings.timezone;
const offer = activeWashOffer(settings)!;

const target = new Date(Date.now() + 10 * 86_400_000);
const y = target.getUTCFullYear();
const m = target.getUTCMonth() + 1;
const d = target.getUTCDate();
const dateISO = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const weekday = zonedWeekday(tz, y, m, d);

const WASH = "svc_wash_offer_test";

async function seed() {
  await db().execute(sql`
    TRUNCATE offer_claims, appointment_services, appointments, jobs, vehicles, customers,
             leads, communications, audit_log, schedule_blocks, staff_schedules, staff_users,
             resources, business_hours, service_addons, service_vehicle_adjustments,
             services, service_categories, addons CASCADE
  `);
  await db().insert(schema.resources).values({ id: newId("res"), name: "Bay 1", type: "bay" });
  await db().insert(schema.businessHours).values({
    id: newId("blk"),
    weekday,
    open: "09:00",
    close: "18:00",
    closed: false,
  });
  await db().insert(schema.serviceCategories).values({
    id: "cat_wash_offer_test",
    name: "Wash Offer Test",
    slug: "wash-offer-test",
  });
  // The live catalogue: $30 for a car, $35 for anything larger.
  await db().insert(schema.services).values({
    id: WASH,
    categoryId: "cat_wash_offer_test",
    name: "Basic Car Wash",
    slug: offer.serviceSlug,
    basePriceCents: 3000,
    baseDurationMin: 60,
    bookingMode: "bookable",
  });
  await db().insert(schema.serviceVehicleAdjustments).values(
    (["suv_small", "suv_large", "pickup", "van"] as const).map((category) => ({
      id: newId("adj"),
      serviceId: WASH,
      vehicleCategory: category,
      priceDeltaCents: 500,
      durationDeltaMin: 0,
    })),
  );
}

type Contact = { firstName: string; phone?: string; email?: string };

function claimFor(contact: Contact, vehicleSize: "car" | "suv" = "car") {
  return issueClaim({
    offer,
    firstName: contact.firstName,
    phone: contact.phone,
    email: contact.email,
    vehicleSize,
    marketingConsent: false,
    termsVersion: "test",
  });
}

/** A real bookable start, because the engine adds setup buffers before open. */
async function slotAt(index: number, category: "sedan" | "suv_small" = "sedan") {
  const pricing = await priceBooking({
    serviceIds: [WASH],
    addonIds: [],
    vehicleCategory: category,
    settings,
  });
  const slots = await getAvailableSlots({
    dateISO,
    workDurationMin: pricing.durationMin,
    settings,
    requiredSkills: pricing.requiredSkills,
  });
  return slots[index].start;
}

async function book(input: {
  code: string;
  contact: { firstName: string; lastName: string; phone?: string; email?: string };
  category: "sedan" | "suv_small" | "commercial";
  startMs: number;
}) {
  const pricing = await priceBooking({
    serviceIds: [WASH],
    addonIds: [],
    vehicleCategory: input.category,
    settings,
    washOffer: offer,
  });
  const created = await createAppointment({
    customer: { ...input.contact, preferredContact: "sms" },
    vehicle: { make: "Honda", model: "Civic", category: input.category },
    pricing,
    dateISO,
    startMs: input.startMs,
    policiesAccepted: true,
    settings,
    washClaim: { offer, code: input.code },
  });
  return { pricing, created };
}

beforeEach(seed);
afterAll(async () => {
  await getPool().end();
});

describe("issuing a claim", () => {
  it("issues a code and puts the claimant in the CRM as a lead", async () => {
    const { claim, created } = await claimFor({ firstName: "Sam", phone: "905-555-0101" });
    expect(created).toBe(true);
    expect(claim.code).toMatch(/^PTW/);
    expect(claim.status).toBe("issued");
    expect(claim.phoneNormalized).toBe("9055550101");

    const [lead] = await db().select().from(schema.leads).where(eq(schema.leads.id, claim.leadId!));
    expect(lead.kind).toBe("offer");
    expect(lead.marketingConsent).toBe(false);
  });

  it("records marketing consent only when it was given", async () => {
    const yes = await issueClaim({
      offer,
      firstName: "Ada",
      phone: "905-555-0110",
      vehicleSize: "car",
      marketingConsent: true,
      termsVersion: "test",
    });
    expect(yes.claim.marketingConsent).toBe(true);
    expect(yes.claim.marketingConsentAt).not.toBeNull();

    const [lead] = await db().select().from(schema.leads).where(eq(schema.leads.id, yes.claim.leadId!));
    expect(lead.marketingConsent).toBe(true);
    expect(lead.marketingConsentSource).toBe("public_offer_claim");
  });

  it("hands back the SAME code rather than erroring on a second claim", async () => {
    // Two reasons this is not an error: people lose the text, and an identical
    // response either way means the form cannot be used to ask whether a number
    // is already on our books.
    const first = await claimFor({ firstName: "Sam", phone: "905-555-0101" });
    const second = await claimFor({ firstName: "Sam", phone: "(905) 555 0101" });
    expect(second.created).toBe(false);
    expect(second.claim.code).toBe(first.claim.code);

    const rows = await db().select().from(schema.offerClaims);
    expect(rows).toHaveLength(1);
  });

  it("caps on the email address too, not only the phone", async () => {
    const first = await claimFor({ firstName: "Sam", phone: "905-555-0101", email: "sam@example.com" });
    const second = await claimFor({ firstName: "Sam", phone: "905-555-0999", email: "SAM@Example.com" });
    expect(second.created).toBe(false);
    expect(second.claim.code).toBe(first.claim.code);
  });

  it("survives two claims racing on the same number", async () => {
    const [a, b] = await Promise.all([
      claimFor({ firstName: "Sam", phone: "905-555-0101" }),
      claimFor({ firstName: "Sam", phone: "905-555-0101" }),
    ]);
    expect(a.claim.code).toBe(b.claim.code);
    expect(await db().select().from(schema.offerClaims)).toHaveLength(1);
  });

  it("lets a released claim be claimed again", async () => {
    const first = await claimFor({ firstName: "Sam", phone: "905-555-0101" });
    await db()
      .update(schema.offerClaims)
      .set({ status: "void" })
      .where(eq(schema.offerClaims.id, first.claim.id));

    const second = await claimFor({ firstName: "Sam", phone: "905-555-0101" });
    expect(second.created).toBe(true);
    expect(second.claim.code).not.toBe(first.claim.code);
  });
});

describe("looking a claim up", () => {
  it("finds a live claim by code, however it was typed", async () => {
    const { claim } = await claimFor({ firstName: "Sam", phone: "905-555-0101" });
    const lookup = await lookupClaim(db(), offer.code, `  ${claim.code.toLowerCase()} `);
    expect(lookup.ok).toBe(true);
  });

  it("refuses an expired code", async () => {
    const { claim } = await claimFor({ firstName: "Sam", phone: "905-555-0101" });
    await db()
      .update(schema.offerClaims)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.offerClaims.id, claim.id));
    const lookup = await lookupClaim(db(), offer.code, claim.code);
    expect(lookup).toMatchObject({ ok: false, reason: "expired" });
  });

  it("refuses a code from a different campaign", async () => {
    const { claim } = await claimFor({ firstName: "Sam", phone: "905-555-0101" });
    expect(await lookupClaim(db(), "OTHERCAMPAIGN", claim.code)).toMatchObject({ ok: false, reason: "unknown" });
  });

  it("binds the code to the number it was issued to", async () => {
    const { claim } = await claimFor({ firstName: "Sam", phone: "905-555-0101" });
    expect(claimBelongsTo(claim, { phone: "(905) 555-0101" })).toBe(true);
    expect(claimBelongsTo(claim, { phone: "905-555-0999" })).toBe(false);
    // A code shared publicly is worth nothing without the number behind it.
    expect(claimBelongsTo(claim, {})).toBe(false);
  });

  it("falls back to email only when the claim has no phone number", async () => {
    const { claim } = await claimFor({ firstName: "Sam", email: "sam@example.com" });
    expect(claimBelongsTo(claim, { email: "SAM@example.com" })).toBe(true);
    expect(claimBelongsTo(claim, { email: "other@example.com" })).toBe(false);
  });
});

describe("spending a claim on a booking", () => {
  it("charges the advertised price for a car", async () => {
    const { claim } = await claimFor({ firstName: "Sam", phone: "905-555-0101" });
    const { pricing, created } = await book({
      code: claim.code,
      contact: { firstName: "Sam", lastName: "Lee", phone: "905-555-0101" },
      category: "sedan",
      startMs: await slotAt(0),
    });

    expect(pricing.subtotalCents).toBe(3000);
    expect(pricing.discountCents).toBe(1401);
    expect(pricing.subtotalCents - pricing.discountCents).toBe(1599);
    expect(pricing.promoCode).toBe(offer.code);
    expect(pricing.promoLabel).toBe(offer.label);

    const [appointment] = await db()
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.id, created.appointmentId));
    // The discount is locked in cents on the appointment, so the invoice it
    // becomes reconciles to the penny.
    expect(appointment.discountCents).toBe(1401);
    expect(appointment.subtotalCents).toBe(3000);
    expect(appointment.promoCode).toBe(offer.code);
  });

  it("charges the advertised price for an SUV", async () => {
    const { claim } = await claimFor({ firstName: "Sam", phone: "905-555-0101" }, "suv");
    const { pricing } = await book({
      code: claim.code,
      contact: { firstName: "Sam", lastName: "Lee", phone: "905-555-0101" },
      category: "suv_small",
      startMs: await slotAt(0),
    });
    expect(pricing.subtotalCents).toBe(3500);
    expect(pricing.subtotalCents - pricing.discountCents).toBe(1799);
  });

  it("charges the size the customer actually books, not the one they guessed", async () => {
    // They picked "car" on the landing page and arrived booking an SUV. The
    // honest answer is the SUV price, not a void offer.
    const { claim } = await claimFor({ firstName: "Sam", phone: "905-555-0101" }, "car");
    const { pricing } = await book({
      code: claim.code,
      contact: { firstName: "Sam", lastName: "Lee", phone: "905-555-0101" },
      category: "suv_small",
      startMs: await slotAt(0),
    });
    expect(pricing.subtotalCents - pricing.discountCents).toBe(1799);
  });

  it("marks the claim booked and links it to the appointment", async () => {
    const { claim } = await claimFor({ firstName: "Sam", phone: "905-555-0101" });
    const { created } = await book({
      code: claim.code,
      contact: { firstName: "Sam", lastName: "Lee", phone: "905-555-0101" },
      category: "sedan",
      startMs: await slotAt(0),
    });
    const [after] = await db().select().from(schema.offerClaims).where(eq(schema.offerClaims.id, claim.id));
    expect(after.status).toBe("booked");
    expect(after.appointmentId).toBe(created.appointmentId);
    expect(after.customerId).toBe(created.customerId);
  });

  it("refuses to spend the same code twice, and writes nothing on the attempt", async () => {
    const { claim } = await claimFor({ firstName: "Sam", phone: "905-555-0101" });
    await book({
      code: claim.code,
      contact: { firstName: "Sam", lastName: "Lee", phone: "905-555-0101" },
      category: "sedan",
      startMs: await slotAt(0),
    });

    await expect(
      book({
        code: claim.code,
        contact: { firstName: "Sam", lastName: "Lee", phone: "905-555-0101" },
        category: "sedan",
        startMs: await slotAt(1),
      }),
    ).rejects.toBeInstanceOf(OfferChangedError);

    // Nothing was booked: the transaction rolled back whole.
    expect(await db().select().from(schema.appointments)).toHaveLength(1);
  });

  it("refuses a returning customer and rolls the whole booking back", async () => {
    // A completed visit makes them a customer, whatever they had done.
    const customerId = newId("cus");
    const vehicleId = newId("veh");
    const appointmentId = newId("apt");
    await db().insert(schema.customers).values({
      id: customerId,
      firstName: "Sam",
      lastName: "Lee",
      phone: "905-555-0101",
      phoneNormalized: "9055550101",
    });
    await db().insert(schema.vehicles).values({
      id: vehicleId,
      customerId,
      make: "Honda",
      model: "Civic",
      category: "sedan",
    });
    await db().insert(schema.appointments).values({
      id: appointmentId,
      customerId,
      vehicleId,
      status: "completed",
      startsAt: new Date(Date.now() - 30 * 86_400_000),
      endsAt: new Date(Date.now() - 30 * 86_400_000 + 3600_000),
      durationMin: 60,
    });

    const { claim } = await claimFor({ firstName: "Sam", phone: "905-555-0101" });
    await expect(
      book({
        code: claim.code,
        contact: { firstName: "Sam", lastName: "Lee", phone: "905-555-0101" },
        category: "sedan",
        startMs: await slotAt(0),
      }),
    ).rejects.toThrow(/first-time customers/i);

    expect(await db().select().from(schema.appointments)).toHaveLength(1);
    const [unchanged] = await db().select().from(schema.offerClaims).where(eq(schema.offerClaims.id, claim.id));
    expect(unchanged.status).toBe("issued");
  });

  it("does not price a commercial vehicle, which the catalogue quotes by hand", async () => {
    const pricing = await priceBooking({
      serviceIds: [WASH],
      addonIds: [],
      vehicleCategory: "commercial",
      settings,
      washOffer: offer,
    });
    expect(pricing.discountCents).toBe(0);
    expect(pricing.promoCode).toBeNull();
  });

  it("lets only one of two simultaneous bookings spend the code", async () => {
    const { claim } = await claimFor({ firstName: "Sam", phone: "905-555-0101" });
    const attempts = await Promise.allSettled([
      book({
        code: claim.code,
        contact: { firstName: "Sam", lastName: "Lee", phone: "905-555-0101" },
        category: "sedan",
        startMs: await slotAt(0),
      }),
      book({
        code: claim.code,
        contact: { firstName: "Sam", lastName: "Lee", phone: "905-555-0101" },
        category: "sedan",
        startMs: await slotAt(2),
      }),
    ]);
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    expect(await db().select().from(schema.appointments)).toHaveLength(1);
  });
});

describe("redeeming against a licence plate", () => {
  async function staffId() {
    const id = newId("usr");
    await db().insert(schema.staffUsers).values({
      id,
      name: "Counter",
      email: `counter-${id}@example.com`,
      passwordHash: "x",
      role: "reception",
    });
    return id;
  }

  it("records the plate and closes the claim", async () => {
    const staff = await staffId();
    const { claim } = await claimFor({ firstName: "Sam", phone: "905-555-0101" });
    const result = await redeemClaimAgainstPlate({ claimId: claim.id, rawPlate: "cabc 123", staffId: staff });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claim.status).toBe("redeemed");
    expect(result.claim.redeemedPlateNormalized).toBe("CABC123");
  });

  it("refuses a plate that already had its promotional wash", async () => {
    const staff = await staffId();
    const first = await claimFor({ firstName: "Sam", phone: "905-555-0101" });
    await redeemClaimAgainstPlate({ claimId: first.claim.id, rawPlate: "CABC123", staffId: staff });

    // A different person, a different code — the same car.
    const second = await claimFor({ firstName: "Alex", phone: "905-555-0202" });
    const result = await redeemClaimAgainstPlate({
      claimId: second.claim.id,
      rawPlate: "cabc-123",
      staffId: staff,
    });
    expect(result).toMatchObject({ ok: false, reason: "plate_used", plate: "CABC123" });
    if (result.ok || result.reason !== "plate_used") return;
    expect(result.by.code).toBe(first.claim.code);
  });

  it("lets only one of two simultaneous redemptions take the plate", async () => {
    const staff = await staffId();
    const a = await claimFor({ firstName: "Sam", phone: "905-555-0101" });
    const b = await claimFor({ firstName: "Alex", phone: "905-555-0202" });
    const results = await Promise.all([
      redeemClaimAgainstPlate({ claimId: a.claim.id, rawPlate: "CDEF456", staffId: staff }),
      redeemClaimAgainstPlate({ claimId: b.claim.id, rawPlate: "CDEF456", staffId: staff }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("refuses to redeem the same claim twice", async () => {
    const staff = await staffId();
    const { claim } = await claimFor({ firstName: "Sam", phone: "905-555-0101" });
    await redeemClaimAgainstPlate({ claimId: claim.id, rawPlate: "CABC123", staffId: staff });
    const again = await redeemClaimAgainstPlate({ claimId: claim.id, rawPlate: "CXYZ789", staffId: staff });
    expect(again).toMatchObject({ ok: false, reason: "already_redeemed" });
  });

  it("keeps a plate spent even after its claim is released", async () => {
    // Releasing a claim frees the PERSON to claim again. It must never free the
    // car, or a released claim becomes a way to wash the same vehicle twice.
    const staff = await staffId();
    const first = await claimFor({ firstName: "Sam", phone: "905-555-0101" });
    await redeemClaimAgainstPlate({ claimId: first.claim.id, rawPlate: "CABC123", staffId: staff });
    await db()
      .update(schema.offerClaims)
      .set({ status: "void" })
      .where(eq(schema.offerClaims.id, first.claim.id));

    const second = await claimFor({ firstName: "Alex", phone: "905-555-0202" });
    const result = await redeemClaimAgainstPlate({
      claimId: second.claim.id,
      rawPlate: "CABC123",
      staffId: staff,
    });
    expect(result).toMatchObject({ ok: false, reason: "plate_used" });
  });
});

describe("expiry and reminders", () => {
  it("marks codes nobody used as expired", async () => {
    const { claim } = await claimFor({ firstName: "Sam", phone: "905-555-0101" });
    await db()
      .update(schema.offerClaims)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.offerClaims.id, claim.id));
    expect(await expireStaleClaims()).toBe(1);
    const [after] = await db().select().from(schema.offerClaims).where(eq(schema.offerClaims.id, claim.id));
    expect(after.status).toBe("expired");
  });

  it("nudges an unbooked claim once per scheduled day, never in a burst", async () => {
    const { claim } = await claimFor({ firstName: "Sam", phone: "905-555-0101" });
    // Backdate it past every reminder in the schedule at once — a cron outage.
    await db()
      .update(schema.offerClaims)
      .set({ createdAt: new Date(Date.now() - 13 * 86_400_000) })
      .where(eq(schema.offerClaims.id, claim.id));

    const schedule = [3, 7, 12];
    for (let sent = 0; sent < schedule.length; sent++) {
      const due = await claimsDueReminder(schedule);
      expect(due).toHaveLength(1);
      await recordClaimReminder(due[0].id);
    }
    // Four reminders were never on offer.
    expect(await claimsDueReminder(schedule)).toHaveLength(0);
  });

  it("stops nudging once the code has been used", async () => {
    const { claim } = await claimFor({ firstName: "Sam", phone: "905-555-0101" });
    await db()
      .update(schema.offerClaims)
      .set({ createdAt: new Date(Date.now() - 5 * 86_400_000), status: "booked" })
      .where(eq(schema.offerClaims.id, claim.id));
    expect(await claimsDueReminder([3, 7, 12])).toHaveLength(0);
  });

  it("does not nudge a claim that is too young", async () => {
    await claimFor({ firstName: "Sam", phone: "905-555-0101" });
    expect(await claimsDueReminder([3, 7, 12])).toHaveLength(0);
  });
});
