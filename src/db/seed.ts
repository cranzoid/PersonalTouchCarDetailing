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
 * ALL PRICES AND DURATIONS ARE PLACEHOLDERS pending owner confirmation —
 * they are configurable in Admin → Settings → Services and exist so the
 * booking flow works end-to-end in development. See WORKFLOW.md
 * "Business questions requiring confirmation".
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
};

const CATALOG: { category: string; slug: string; description: string; services: SvcSeed[] }[] = [
  {
    category: "Vehicle Detailing",
    slug: "vehicle-detailing",
    description:
      "Interior and exterior detailing packages that restore, refresh and protect your vehicle.",
    services: [
      { name: "Interior Detailing", slug: "interior-detailing", short: "Deep clean of seats, carpets, panels, vents and glass.", priceCents: 18900, durationMin: 180, mode: "bookable", featured: true },
      { name: "Exterior Detailing", slug: "exterior-detailing", short: "Hand wash, decontamination, wheels, and protective finish.", priceCents: 14900, durationMin: 120, mode: "bookable" },
      { name: "Full Detailing", slug: "full-detailing", short: "Complete interior and exterior detail — our most popular package.", priceCents: 29900, durationMin: 300, mode: "bookable", featured: true },
      { name: "Express Detailing", slug: "express-detailing", short: "Maintenance wash and interior refresh in about an hour.", priceCents: 8900, durationMin: 60, mode: "bookable" },
      { name: "Engine Bay Detailing", slug: "engine-bay-detailing", short: "Safe degrease and dressing of the engine compartment.", priceCents: 7900, durationMin: 45, mode: "bookable" },
      { name: "Odour Removal", slug: "odour-removal", short: "Source removal and ozone treatment for persistent odours.", priceCents: null, durationMin: 120, mode: "quote_required" },
      { name: "Pet-Hair Removal", slug: "pet-hair-removal", short: "Specialized removal of embedded pet hair.", priceCents: null, durationMin: 90, mode: "quote_required" },
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
      { name: "Wax & Sealant", slug: "wax-sealant", short: "Premium carnauba wax or synthetic sealant application.", priceCents: 9900, durationMin: 90, mode: "bookable" },
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
      { name: "Rideshare Packages", slug: "rideshare-packages", short: "Fast interior turnarounds for rideshare drivers.", priceCents: 9900, durationMin: 75, mode: "bookable" },
      { name: "Recurring Commercial Detailing", slug: "recurring-commercial", short: "Scheduled commercial detailing with consolidated billing.", priceCents: null, durationMin: 240, mode: "contact_only" },
    ],
  },
];

/** Placeholder vehicle-size adjustments applied to bookable detailing services. */
const VEHICLE_ADJUSTMENTS: { category: string; priceDeltaCents: number; durationDeltaMin: number }[] = [
  { category: "suv_small", priceDeltaCents: 2000, durationDeltaMin: 30 },
  { category: "suv_large", priceDeltaCents: 4000, durationDeltaMin: 60 },
  { category: "pickup", priceDeltaCents: 4000, durationDeltaMin: 60 },
  { category: "van", priceDeltaCents: 5000, durationDeltaMin: 60 },
  { category: "commercial", priceDeltaCents: 6000, durationDeltaMin: 60 },
];

const ADDONS = [
  { name: "Headlight Restoration", description: "Restore clarity to oxidized headlights.", priceCents: 7900, durationMin: 45 },
  { name: "Interior Protectant", description: "UV protectant for dash, trim and leather.", priceCents: 3900, durationMin: 15 },
  { name: "Odour Treatment (Light)", description: "Deodorizing treatment for mild odours.", priceCents: 6900, durationMin: 45 },
  { name: "Trim Restoration", description: "Restore faded exterior plastic trim.", priceCents: 4900, durationMin: 30 },
  { name: "Glass Rain Repellent", description: "Hydrophobic coating for windshield and glass.", priceCents: 2900, durationMin: 15 },
  { name: "Salt & Stain Extraction", description: "Winter salt and carpet stain extraction.", priceCents: 5900, durationMin: 45 },
];

const MESSAGE_TEMPLATES = [
  { key: "lead_ack", channel: "email", subject: "We received your request — {{businessName}}", body: "Hi {{firstName}},\n\nThanks for reaching out to {{businessName}}. We've received your request and will get back to you within one business day.\n\n— {{businessName}}" },
  { key: "booking_confirmation", channel: "email", subject: "Booking confirmed — {{businessName}}", body: "Hi {{firstName}},\n\nYour appointment on {{date}} at {{time}} is confirmed.\n\nService: {{services}}\nVehicle: {{vehicle}}\nEstimated total: {{total}}\n\nIf you need to reschedule, reply to this email or call us.\n\n— {{businessName}}" },
  { key: "appointment_reminder", channel: "sms", subject: null, body: "Reminder from {{businessName}}: your appointment is {{date}} at {{time}}. Reply to reschedule." },
  { key: "estimate_sent", channel: "email", subject: "Your estimate from {{businessName}}", body: "Hi {{firstName}},\n\nYour estimate #{{estimateNumber}} is ready. View and approve it here: {{link}}\n\nThis estimate expires on {{expiry}}.\n\n— {{businessName}}" },
  { key: "vehicle_ready", channel: "sms", subject: null, body: "{{businessName}}: your {{vehicle}} is ready for pickup!" },
];

async function main() {
  const url = process.env.TEST === "1" ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool, { schema });

  // --- staff (dev owner account) -----------------------------------------
  const existingStaff = await db.select().from(schema.staffUsers);
  if (existingStaff.length === 0) {
    const password = process.env.SEED_ADMIN_PASSWORD ?? "detailing-dev-2026";
    await db.insert(schema.staffUsers).values({
      id: newId("usr"),
      name: "Dev Owner",
      email: "owner@ptcd.local",
      passwordHash: await bcrypt.hash(password, 12),
      role: "owner",
    });
    console.log(`Seeded staff: owner@ptcd.local / ${password} (DEV ONLY — change before production)`);
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

  // --- business hours (PLACEHOLDER — needs owner confirmation) -----------
  const existingHours = await db.select().from(schema.businessHours);
  if (existingHours.length === 0) {
    const rows = [
      { weekday: 0, closed: true, open: null as string | null, close: null as string | null },
      { weekday: 1, closed: false, open: "08:00", close: "18:00" },
      { weekday: 2, closed: false, open: "08:00", close: "18:00" },
      { weekday: 3, closed: false, open: "08:00", close: "18:00" },
      { weekday: 4, closed: false, open: "08:00", close: "18:00" },
      { weekday: 5, closed: false, open: "08:00", close: "18:00" },
      { weekday: 6, closed: false, open: "09:00", close: "17:00" },
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
          for (const adj of VEHICLE_ADJUSTMENTS) {
            await db.insert(schema.serviceVehicleAdjustments).values({
              id: newId("adj"),
              serviceId,
              vehicleCategory: adj.category,
              priceDeltaCents: adj.priceDeltaCents,
              durationDeltaMin: adj.durationDeltaMin,
            });
          }
          for (const addonId of addonIds) {
            await db.insert(schema.serviceAddons).values({ id: newId("add"), serviceId, addonId });
          }
        }
      }
    }
    console.log("Seeded service catalog (placeholder prices — confirm with owner).");
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
