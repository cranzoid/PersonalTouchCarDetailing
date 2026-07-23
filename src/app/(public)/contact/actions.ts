"use server";

import { z } from "zod";
import { db, schema } from "@/db";
import { newId } from "@/lib/id";
import { getSettings } from "@/lib/settings";
import { sendMessageTemplate } from "@/lib/messaging";
import { consumeRateLimit } from "@/lib/rate-limit";

const contactSchema = z.object({
  name: z.string().trim().min(1).max(150),
  email: z.string().trim().email().max(200).optional().or(z.literal("").transform(() => undefined)),
  phone: z.string().trim().min(7).max(30).optional().or(z.literal("").transform(() => undefined)),
  company: z.string().trim().max(200).optional(),
  message: z.string().trim().min(1).max(4000),
  kind: z.enum(["contact", "fleet"]).default("contact"),
  attribution: z.record(z.string(), z.unknown()).optional(),
});

export type ContactResult = { ok: true } | { ok: false; error: string };

export async function submitContactAction(raw: unknown): Promise<ContactResult> {
  const rate = await consumeRateLimit("contact", { limit: 5, windowMs: 60 * 60_000 });
  if (!rate.allowed) return { ok: false, error: "Too many requests. Please try again later or call us." };
  const parsed = contactSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Please fill in the required fields." };
  const input = parsed.data;
  if (!input.email && !input.phone) {
    return { ok: false, error: "Please provide an email address or phone number." };
  }
  try {
    const leadId = newId("lead");
    await db().insert(schema.leads).values({
      id: leadId,
      name: input.company ? `${input.name} (${input.company})` : input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      kind: input.kind,
      status: "new",
      message: input.message,
      attribution: (input.attribution ?? null) as never,
    });
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
      relatedEntityType: "lead",
      relatedEntityId: leadId,
    });
    return { ok: true };
  } catch (err) {
    console.error("submitContactAction failed", err);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}
