import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import bcrypt from "bcryptjs";
import * as schema from "./schema";
import { newId } from "../lib/id";
import { loadEnv } from "../lib/load-env";

loadEnv();

/**
 * Idempotent seed: safe to re-run; skips anything that already exists.
 *
 * Detailing-package prices come from the owner's current printed flyer
 * (pictures/WhatsApp Image 2026-07-13 at 21.13.19.jpeg). Flyer prices are
 * ranges by vehicle class (Sedan vs SUV/Truck/Van); we seed the sedan lower
 * bound as the base price and the SUV/Truck/Van lower bound as a vehicle
 * adjustment. DURATIONS are still estimates, and the non-flyer categories
 * (paint correction, protection, tint, styling) remain quote-only. Everything
 * is configurable in Admin → Services.
 */

type SvcSeed = {
  name: string;
  slug: string;
  short: string;
  priceCents: number | null;
  durationMin: number;
  mode: string;
  featured?: boolean;
  photosRequired?: boolean;
  depositType?: string;
  depositValue?: number;
  /** Flyer's SUV / Truck / Van price minus sedan price (+ extra time). */
  largeVehicleDeltaCents?: number;
  largeVehicleDeltaMin?: number;
};

const CATALOG: { category: string; slug: string; description: string; services: SvcSeed[] }[] = [
  {
    category: "Detailing Packages",
    slug: "vehicle-detailing",
    description:
      "Our signature detailing packages — from a basic hand wash to a complete inside-and-out detail with engine bay.",
    services: [
      // Flyer "Car Detailing Package #1"
      { name: "Complete Detail + Engine", slug: "complete-detail-engine", short: "Engine fine detail, rim clean and tire shine, deep-cleaned seats and carpet, full interior clean and buff, hand wash and dry.", priceCents: 17500, durationMin: 300, mode: "bookable", featured: true, largeVehicleDeltaCents: 2500, largeVehicleDeltaMin: 60 },
      // Flyer "Car Detailing Package #2 — The Works Package"
      { name: "The Works Package", slug: "the-works", short: "Rim clean and tire shine, deep-cleaned seats, carpet and mats, full interior clean and buff, hand wash and dry.", priceCents: 15000, durationMin: 240, mode: "bookable", featured: true, largeVehicleDeltaCents: 5000, largeVehicleDeltaMin: 60 },
      // Flyer "Car Detailing Package #3 — Interior Detail"
      { name: "Interior Detail", slug: "interior-detail", short: "Vacuum carpets and seats, clean mats and interior windows, deep-clean seats and carpets, clean and buff all interior surfaces.", priceCents: 12500, durationMin: 180, mode: "bookable", largeVehicleDeltaCents: 2500, largeVehicleDeltaMin: 45 },
      // Flyer "Car Detailing Package #6 — Basic Car Wash + Basic Interior Clean"
      { name: "Wash & Interior Refresh", slug: "wash-interior-refresh", short: "Exterior hand wash and dry plus a basic interior clean — our maintenance combo.", priceCents: 7000, durationMin: 90, mode: "bookable", largeVehicleDeltaCents: 2000, largeVehicleDeltaMin: 30 },
      // Flyer "Car Detailing Package #5 — Basic Interior Clean"
      { name: "Basic Interior Clean", slug: "basic-interior-clean", short: "Vacuum carpet and trunk, wipe down dash, doors and cup holders, clean interior windows.", priceCents: 5000, durationMin: 60, mode: "bookable", largeVehicleDeltaCents: 2000, largeVehicleDeltaMin: 30 },
      // Flyer "Car Detailing Package #4 — Basic Car Wash"
      { name: "Basic Car Wash", slug: "basic-car-wash", short: "Exterior hand wash, dry and clean mats.", priceCents: 2500, durationMin: 30, mode: "bookable", largeVehicleDeltaCents: 500, largeVehicleDeltaMin: 15 },
      // Flyer: "RV Detailing Available — Ask Us For Details"
      { name: "RV Detailing", slug: "rv-detailing", short: "RV and motorhome detailing — contact us for a custom quote.", priceCents: null, durationMin: 480, mode: "contact_only" },
    ],
  },
  {
    category: "Paint Correction & Enhancement",
    slug: "paint-correction",
    description:
      "Machine polishing to remove swirls, scratches and oxidation and restore true gloss.",
    services: [
      { name: "Paint Enhancement", slug: "paint-enhancement", short: "Single-step gloss enhancement polish.", priceCents: null, durationMin: 240, mode: "inspection_required", photosRequired: true },
      { name: "One-Stage Correction", slug: "one-stage-correction", short: "Removes the majority of light swirls and defects.", priceCents: null, durationMin: 360, mode: "inspection_required", photosRequired: true },
      { name: "Multi-Stage Correction", slug: "multi-stage-correction", short: "Maximum defect removal for show-quality finish.", priceCents: null, durationMin: 600, mode: "inspection_required", photosRequired: true },
      { name: "Scratch & Swirl Reduction", slug: "scratch-swirl-reduction", short: "Targeted correction of localized scratches and swirls.", priceCents: null, durationMin: 120, mode: "quote_required", photosRequired: true },
    ],
  },
  {
    category: "Paint Protection",
    slug: "paint-protection",
    description: "Long-term protection: ceramic coatings, paint protection film, wax and sealants.",
    services: [
      { name: "Ceramic Coating", slug: "ceramic-coating", short: "Professional-grade ceramic coating with multi-year durability.", priceCents: null, durationMin: 480, mode: "inspection_required", featured: true, photosRequired: true },
      { name: "Paint Protection Film", slug: "paint-protection-film", short: "Self-healing film for high-impact areas or full panels.", priceCents: null, durationMin: 480, mode: "inspection_required", photosRequired: true },
      { name: "Wax & Sealant", slug: "wax-sealant", short: "Premium carnauba wax or synthetic sealant application.", priceCents: null, durationMin: 90, mode: "quote_required" },
    ],
  },
  {
    category: "Window Tinting",
    slug: "window-tinting",
    description: "Professional window film installation, removal and replacement.",
    services: [
      { name: "Vehicle Tinting", slug: "vehicle-tinting", short: "Premium films in a range of shades, installed cleanly.", priceCents: null, durationMin: 180, mode: "quote_required" },
      { name: "Tint Removal", slug: "tint-removal", short: "Clean removal of old or damaged film, adhesive included.", priceCents: null, durationMin: 120, mode: "quote_required" },
      { name: "Tint Replacement", slug: "tint-replacement", short: "Removal of old film and installation of new film.", priceCents: null, durationMin: 240, mode: "quote_required" },
    ],
  },
  {
    category: "Vehicle Styling",
    slug: "vehicle-styling",
    description: "Vinyl wraps, chrome delete, accents and lighting to personalize your vehicle.",
    services: [
      { name: "Vinyl Wraps", slug: "vinyl-wraps", short: "Full and partial colour-change wraps.", priceCents: null, durationMin: 960, mode: "contact_only" },
      { name: "Chrome Delete", slug: "chrome-delete", short: "Gloss or satin black-out of chrome trim.", priceCents: null, durationMin: 240, mode: "quote_required" },
      { name: "Accent Wrapping", slug: "accent-wrapping", short: "Roof, mirrors, spoilers and interior trim accents.", priceCents: null, durationMin: 180, mode: "quote_required" },
      { name: "Lighting & Accessories", slug: "lighting-accessories", short: "Lighting upgrades and accessory installation.", priceCents: null, durationMin: 120, mode: "contact_only" },
    ],
  },
  {
    category: "Fleet & Commercial",
    slug: "fleet-commercial",
    description: "Programs for fleets, dealerships and rideshare vehicles — on your schedule.",
    services: [
      { name: "Fleet Cleaning", slug: "fleet-cleaning", short: "Recurring cleaning programs for company fleets.", priceCents: null, durationMin: 120, mode: "contact_only" },
      { name: "Dealership Services", slug: "dealership-services", short: "Lot washes, delivery preps and reconditioning.", priceCents: null, durationMin: 120, mode: "contact_only" },
      { name: "Rideshare Packages", slug: "rideshare-packages", short: "Fast interior turnarounds for rideshare drivers.", priceCents: null, durationMin: 75, mode: "quote_required" },
      { name: "Recurring Commercial Detailing", slug: "recurring-commercial", short: "Scheduled commercial detailing with consolidated billing.", priceCents: null, durationMin: 240, mode: "contact_only" },
    ],
  },
];

/**
 * The flyer prices in two classes: Sedan vs SUV / Truck / Van. These vehicle
 * categories get each service's large-vehicle delta.
 */
const LARGE_VEHICLE_CATEGORIES = ["suv_small", "suv_large", "pickup", "van", "commercial"];

/** Flyer extras ("$X Extra" box) — confirmed prices. */
const ADDONS = [
  { name: "Dog Hair Clean", description: "Removal of embedded pet hair (for interior clean-up packages).", priceCents: 5000, durationMin: 45 },
  { name: "Wax / Buff", description: "Machine wax and buff for added gloss and protection.", priceCents: 12000, durationMin: 60 },
  { name: "Salt Stain Removal", description: "Winter salt stain extraction from carpets and mats.", priceCents: 5000, durationMin: 45 },
];

const MESSAGE_TEMPLATES = [
  { key: "lead_ack", channel: "email", subject: "We received your request — {{businessName}}", body: "Hi {{firstName}},\n\nThanks for reaching out to {{businessName}}. We've received your request and will get back to you within one business day.\n\n— {{businessName}}" },
  { key: "booking_confirmation", channel: "email", subject: "Booking confirmed — {{businessName}}", body: "Hi {{firstName}},\n\nYour appointment on {{date}} at {{time}} is confirmed.\n\nService: {{services}}\nVehicle: {{vehicle}}\nEstimated total: {{total}}\n\nIf you need to reschedule, reply to this email or call us.\n\n— {{businessName}}" },
  { key: "appointment_reminder", channel: "sms", subject: null, body: "Reminder from {{businessName}}: your appointment is {{date}} at {{time}}. Reply to reschedule." },
  { key: "estimate_sent", channel: "email", subject: "Your estimate from {{businessName}}", body: "Hi {{firstName}},\n\nYour estimate #{{estimateNumber}} is ready. View and approve it here: {{link}}\n\nThis estimate expires on {{expiry}}.\n\n— {{businessName}}" },
  { key: "additional_work_request", channel: "email", subject: "Approval needed for your vehicle — {{businessName}}", body: "Hi {{firstName}},\n\nWhile working on your vehicle we found something that needs your approval:\n\n{{description}}\nPrice: {{price}} plus tax\n\nApprove or decline here: {{link}}\n\nWork continues on the originally approved services in the meantime.\n\n— {{businessName}}" },
  { key: "vehicle_ready", channel: "sms", subject: null, body: "{{businessName}}: your {{vehicle}} is ready for pickup!" },
  { key: "invoice_sent", channel: "email", subject: "Your invoice from {{businessName}}", body: "Hi {{firstName}},\n\nYour invoice INV-{{invoiceNumber}} for {{total}} is ready. View and pay it here: {{link}}\n\n— {{businessName}}" },
  { key: "portal_access", channel: "email", subject: "Your customer portal — {{businessName}}", body: "Hi {{firstName}},\n\nYour secure {{businessName}} customer portal is ready. View your vehicles, appointments, estimates, service history and invoices here:\n\n{{link}}\n\nThis personal link expires in {{expiryDays}} days. Please do not share it.\n\n— {{businessName}}" },
  { key: "receipt", channel: "email", subject: "Payment received — {{businessName}}", body: "Hi {{firstName}},\n\nWe received your payment of {{amount}} for invoice INV-{{invoiceNumber}}.\n{{balanceLine}}\nThank you for choosing {{businessName}}!\n\n— {{businessName}}" },
  { key: "review_request", channel: "email", subject: "How did we do? — {{businessName}}", body: "Hi {{firstName}},\n\nThanks for choosing {{businessName}}! If you have a minute, we'd really appreciate a review — it helps other drivers find us:\n\n{{reviewUrl}}\n\n— {{businessName}}" },
  { key: "maintenance", channel: "email", subject: "Time for your next detail? — {{businessName}}", body: "Hi {{firstName}},\n\nIt's been a little while since we detailed your {{vehicle}} — vehicles look and feel best with regular care. Ready to book your next visit?\n\n{{bookingUrl}}\n\n— {{businessName}}" },
];

async function main() {
  const url = process.env.TEST === "1" ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool, { schema });

  // --- staff (dev owner account) -----------------------------------------
  const existingStaff = await db.select().from(schema.staffUsers);
  if (existingStaff.length === 0) {
    const production = process.env.NODE_ENV === "production";
    const password = process.env.SEED_ADMIN_PASSWORD ?? (production ? undefined : "detailing-dev-2026");
    const email = process.env.SEED_ADMIN_EMAIL ?? (production ? undefined : "owner@ptcd.local");
    if (!password || password.length < 12 || !email) {
      throw new Error(
        "First production seed requires SEED_ADMIN_EMAIL and a SEED_ADMIN_PASSWORD of at least 12 characters",
      );
    }
    await db.insert(schema.staffUsers).values({
      id: newId("usr"),
      name: process.env.SEED_ADMIN_NAME ?? (production ? "Owner" : "Dev Owner"),
      email,
      passwordHash: await bcrypt.hash(password, 12),
      role: "owner",
    });
    console.log(`Seeded owner account: ${email}`);
  }

  // --- counters ----------------------------------------------------------
  await db.insert(schema.invoiceCounters).values({ id: "default", nextNumber: 1000 }).onConflictDoNothing();
  await db.insert(schema.estimateCounters).values({ id: "default", nextNumber: 1000 }).onConflictDoNothing();

  // --- resources (bays) --------------------------------------------------
  const existingResources = await db.select().from(schema.resources);
  if (existingResources.length === 0) {
    await db.insert(schema.resources).values([
      { id: newId("res"), name: "Bay 1", type: "bay" },
      { id: newId("res"), name: "Bay 2", type: "bay" },
    ]);
  }

  // --- business hours (owner-confirmed: Mon–Sat 9–7, Sun closed; editable
  // in Admin → Settings) --------------------------------------------------
  const existingHours = await db.select().from(schema.businessHours);
  if (existingHours.length === 0) {
    const rows = [
      { weekday: 0, closed: true, open: null as string | null, close: null as string | null },
      { weekday: 1, closed: false, open: "09:00", close: "19:00" },
      { weekday: 2, closed: false, open: "09:00", close: "19:00" },
      { weekday: 3, closed: false, open: "09:00", close: "19:00" },
      { weekday: 4, closed: false, open: "09:00", close: "19:00" },
      { weekday: 5, closed: false, open: "09:00", close: "19:00" },
      { weekday: 6, closed: false, open: "09:00", close: "19:00" },
    ];
    await db.insert(schema.businessHours).values(rows.map((r) => ({ id: newId("blk"), ...r })));
  }

  // --- addons ------------------------------------------------------------
  const existingAddons = await db.select().from(schema.addons);
  const addonIds: string[] = [];
  if (existingAddons.length === 0) {
    for (const [i, a] of ADDONS.entries()) {
      const addonId = newId("add");
      addonIds.push(addonId);
      await db.insert(schema.addons).values({ id: addonId, sort: i, ...a });
    }
  } else {
    addonIds.push(...existingAddons.map((a) => a.id));
  }

  // --- catalog -----------------------------------------------------------
  const existingCategories = await db.select().from(schema.serviceCategories);
  if (existingCategories.length === 0) {
    for (const [ci, cat] of CATALOG.entries()) {
      const categoryId = newId("cat");
      await db.insert(schema.serviceCategories).values({
        id: categoryId,
        name: cat.category,
        slug: cat.slug,
        description: cat.description,
        sort: ci,
      });
      for (const [si, svc] of cat.services.entries()) {
        const serviceId = newId("svc");
        await db.insert(schema.services).values({
          id: serviceId,
          categoryId,
          name: svc.name,
          slug: svc.slug,
          shortDescription: svc.short,
          basePriceCents: svc.priceCents,
          baseDurationMin: svc.durationMin,
          bookingMode: svc.mode,
          featured: svc.featured ?? false,
          photosRequiredForQuote: svc.photosRequired ?? false,
          depositType: svc.depositType ?? "none",
          depositValue: svc.depositValue ?? 0,
          sort: si,
        });
        // Vehicle-size adjustments + addon links for directly bookable services
        if (svc.mode === "bookable") {
          if (svc.largeVehicleDeltaCents) {
            for (const category of LARGE_VEHICLE_CATEGORIES) {
              await db.insert(schema.serviceVehicleAdjustments).values({
                id: newId("adj"),
                serviceId,
                vehicleCategory: category,
                priceDeltaCents: svc.largeVehicleDeltaCents,
                durationDeltaMin: svc.largeVehicleDeltaMin ?? 0,
              });
            }
          }
          for (const addonId of addonIds) {
            await db.insert(schema.serviceAddons).values({ id: newId("add"), serviceId, addonId });
          }
        }
      }
    }
    console.log("Seeded service catalog (package prices from owner flyer; durations estimated).");
  }

  // --- message templates -------------------------------------------------
  for (const t of MESSAGE_TEMPLATES) {
    await db
      .insert(schema.messageTemplates)
      .values({ id: newId("tpl"), key: t.key, channel: t.channel, subject: t.subject, body: t.body })
      .onConflictDoNothing();
  }

  await pool.end();
  console.log("Seed complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
