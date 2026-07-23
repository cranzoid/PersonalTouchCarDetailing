import { z } from "zod";

/**
 * Variables actually supplied by the existing call site for each seeded
 * template key. Keep this list aligned with the renderTemplate(...) calls; it
 * deliberately does not invent variables or template records.
 */
export const TEMPLATE_VARIABLES: Readonly<Record<string, readonly string[]>> = {
  lead_ack: ["businessName", "firstName"],
  booking_confirmation: [
    "businessName",
    "firstName",
    "date",
    "time",
    "services",
    "vehicle",
    "total",
  ],
  appointment_reminder: ["businessName", "date", "time"],
  estimate_sent: ["businessName", "firstName", "estimateNumber", "link", "expiry"],
  additional_work_request: ["businessName", "firstName", "description", "price", "link"],
  vehicle_ready: ["businessName", "vehicle"],
  invoice_sent: ["businessName", "firstName", "invoiceNumber", "total", "link"],
  portal_access: ["businessName", "firstName", "link", "expiryDays"],
  receipt: ["businessName", "firstName", "amount", "invoiceNumber", "balanceLine"],
  review_request: ["businessName", "firstName", "reviewUrl"],
  maintenance: ["businessName", "firstName", "vehicle", "bookingUrl"],
};

export const messageTemplateUpdateSchema = z.object({
  templateId: z.string().trim().min(1).max(200),
  channel: z.enum(["email", "sms"]),
  subject: z.string().trim().max(300),
  body: z.string().trim().min(1).max(20_000),
  active: z.boolean(),
});

export type MessageTemplateUpdate = z.infer<typeof messageTemplateUpdateSchema>;

export function extractTemplateVariables(...parts: (string | null | undefined)[]): string[] {
  const variables = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    for (const match of part.matchAll(/\{\{(\w+)\}\}/g)) variables.add(match[1]);
  }
  return [...variables].sort();
}

export function validateTemplateContent(
  key: string,
  input: Pick<MessageTemplateUpdate, "channel" | "subject" | "body">,
): string | null {
  if (input.channel === "email" && !input.subject) {
    return "Email templates need a subject.";
  }
  const supported = TEMPLATE_VARIABLES[key];
  if (!supported) return null;
  const supportedSet = new Set(supported);
  const unsupported = extractTemplateVariables(input.subject, input.body).filter(
    (variable) => !supportedSet.has(variable),
  );
  if (unsupported.length === 0) return null;
  return `Unsupported variable${unsupported.length === 1 ? "" : "s"} for ${key}: ${unsupported
    .map((variable) => `{{${variable}}}`)
    .join(", ")}.`;
}
