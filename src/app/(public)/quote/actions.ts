"use server";

import { randomBytes } from "crypto";
import { z } from "zod";
import { db, schema } from "@/db";
import { newId } from "@/lib/id";
import { getSettings } from "@/lib/settings";
import { sendMessageTemplate } from "@/lib/messaging";
import { inArray } from "drizzle-orm";
import { VEHICLE_CATEGORIES } from "@/lib/types";
import { consumeRateLimit } from "@/lib/rate-limit";
import { putPrivateFile } from "@/lib/storage";

const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);

const quoteSchema = z.object({
  name: z.string().trim().min(1).max(150),
  email: z.string().trim().email().max(200).optional().or(z.literal("").transform(() => undefined)),
  phone: z.string().trim().min(7).max(30).optional().or(z.literal("").transform(() => undefined)),
  serviceIds: z.array(z.string()).max(10),
  vehicleYear: z.coerce.number().int().min(1950).max(2030).optional(),
  vehicleMake: z.string().trim().max(60).optional(),
  vehicleModel: z.string().trim().max(60).optional(),
  vehicleCategory: z.enum(VEHICLE_CATEGORIES).optional(),
  conditionDescription: z.string().trim().min(1).max(4000),
  marketingConsent: z.boolean().default(false),
  attribution: z.record(z.string(), z.unknown()).optional(),
});

export type QuoteResult = { ok: true; reference: string } | { ok: false; error: string };

/**
 * Public quote request: creates a lead + quote request (no account required),
 * stores uploaded photos privately (never public without separate consent),
 * and logs an acknowledgement message.
 */
export async function submitQuoteAction(formData: FormData): Promise<QuoteResult> {
  const rate = await consumeRateLimit("quote", { limit: 5, windowMs: 60 * 60_000 });
  if (!rate.allowed) return { ok: false, error: "Too many requests. Please try again later or call us." };
  let payload: unknown;
  try {
    payload = JSON.parse(String(formData.get("payload") ?? "{}"));
  } catch {
    return { ok: false, error: "Invalid request" };
  }
  const parsed = quoteSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, error: "Please fill in the required fields." };
  }
  const input = parsed.data;
  if (!input.email && !input.phone) {
    return { ok: false, error: "Please provide an email address or phone number." };
  }

  // Validate requested services exist (ignore unknown ids rather than fail hard).
  let validServiceIds: string[] = [];
  if (input.serviceIds.length > 0) {
    const found = await db()
      .select({ id: schema.services.id })
      .from(schema.services)
      .where(inArray(schema.services.id, input.serviceIds));
    validServiceIds = found.map((s) => s.id);
  }

  const photos = formData
    .getAll("photos")
    .filter((f): f is File => f instanceof File && f.size > 0);
  if (photos.length > MAX_PHOTOS) {
    return { ok: false, error: `Please attach at most ${MAX_PHOTOS} photos.` };
  }
  for (const photo of photos) {
    if (photo.size > MAX_PHOTO_BYTES) return { ok: false, error: "Each photo must be under 10 MB." };
    if (!ALLOWED_TYPES.has(photo.type)) return { ok: false, error: "Photos must be JPEG, PNG, WebP or HEIC." };
  }

  try {
    const leadId = newId("lead");
    const quoteRequestId = newId("qr");

    await db().insert(schema.leads).values({
      id: leadId,
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      kind: "quote",
      status: "new",
      message: input.conditionDescription,
      attribution: (input.attribution ?? null) as never,
      marketingConsent: input.marketingConsent,
      marketingConsentAt: input.marketingConsent ? new Date() : null,
      marketingConsentSource: input.marketingConsent ? "public_quote_form" : null,
    });

    await db().insert(schema.quoteRequests).values({
      id: quoteRequestId,
      leadId,
      vehicleInfo: {
        year: input.vehicleYear,
        make: input.vehicleMake,
        model: input.vehicleModel,
        category: input.vehicleCategory,
      },
      requestedServiceIds: validServiceIds,
      conditionDescription: input.conditionDescription,
    });

    // Store photos through the private storage abstraction (local in dev,
    // S3-compatible object storage in production).
    if (photos.length > 0) {
      for (const photo of photos) {
        const ext = photo.type === "image/png" ? "png" : photo.type === "image/webp" ? "webp" : photo.type === "image/heic" ? "heic" : "jpg";
        const key = `quote_requests/${quoteRequestId}/${randomBytes(8).toString("hex")}.${ext}`;
        await putPrivateFile(key, Buffer.from(await photo.arrayBuffer()), photo.type);
        await db().insert(schema.files).values({
          id: newId("file"),
          entityType: "quote_request",
          entityId: quoteRequestId,
          kind: "quote",
          storageKey: key,
          contentType: photo.type,
          sizeBytes: photo.size,
          uploadedByType: "customer",
        });
      }
    }

    const settings = await getSettings();
    await sendMessageTemplate({
      templateKey: "lead_ack",
      recipient: input,
      leadId,
      kind: "lead_ack",
      variables: {
        businessName: settings.businessName,
        firstName: input.name.split(" ")[0],
      },
      relatedEntityType: "quote_request",
      relatedEntityId: quoteRequestId,
    });

    return { ok: true, reference: quoteRequestId };
  } catch (err) {
    console.error("submitQuoteAction failed", err);
    return { ok: false, error: "Something went wrong. Please try again or call us." };
  }
}
