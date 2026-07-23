"use server";

import { eq, inArray, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { AuthError, requireStaff } from "@/lib/auth/session";
import { newId } from "@/lib/id";
import { sendMessageTemplate } from "@/lib/messaging";
import { createCustomerPortalToken } from "@/lib/portal";
import { getSettings } from "@/lib/settings";
import { VEHICLE_CATEGORIES } from "@/lib/types";
import { getAppBaseUrl } from "@/lib/urls";

export type CustomerActionResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

const optionalEmail = z.string().trim().email().max(200).optional().or(z.literal("").transform(() => undefined));
const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal("").transform(() => undefined));

export async function createFleetCustomerAction(
  raw: unknown,
): Promise<CustomerActionResult<{ customerId: string }>> {
  try {
    const staff = await requireStaff("manage_customers");
    const parsed = z.object({
      companyName: z.string().trim().min(1).max(160),
      firstName: z.string().trim().min(1).max(100),
      lastName: z.string().trim().max(100).default(""),
      email: optionalEmail,
      phone: optionalText(30),
      preferredContact: z.enum(["email", "sms", "phone"]).default("email"),
    }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Please check the company and contact details" };
    const input = parsed.data;
    if (!input.email && !input.phone) return { ok: false, error: "Add an email address or phone number" };
    if (input.preferredContact === "email" && !input.email) return { ok: false, error: "Preferred email requires an email address" };
    if (input.preferredContact !== "email" && !input.phone) return { ok: false, error: "Preferred phone contact requires a phone number" };

    const customerId = newId("cus");
    await db().transaction(async (tx) => {
      await tx.insert(schema.customers).values({
        id: customerId,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone,
        preferredContact: input.preferredContact,
        customerType: "business",
        companyName: input.companyName,
        tags: ["fleet"],
      });
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "fleet_customer.created",
        entityType: "customer",
        entityId: customerId,
        after: { companyName: input.companyName, preferredContact: input.preferredContact },
      });
    });
    revalidatePath("/admin/customers");
    revalidatePath("/admin/fleet");
    return { ok: true, customerId };
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: error.message };
    console.error("createFleetCustomerAction failed", error);
    return { ok: false, error: "Something went wrong" };
  }
}

export async function addCustomerVehicleAction(
  raw: unknown,
): Promise<CustomerActionResult<{ vehicleId: string }>> {
  try {
    const staff = await requireStaff("manage_customers");
    const parsed = z.object({
      customerId: z.string().min(1),
      year: z.number().int().min(1900).max(new Date().getFullYear() + 2).optional(),
      make: z.string().trim().min(1).max(60),
      model: z.string().trim().min(1).max(60),
      trim: optionalText(60),
      category: z.enum(VEHICLE_CATEGORIES),
      colour: optionalText(60),
      licencePlate: optionalText(30),
    }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Please check the vehicle details" };
    const input = parsed.data;
    const vehicleId = newId("veh");

    const result = await db().transaction(async (tx): Promise<CustomerActionResult<{ vehicleId: string }>> => {
      const [customer] = await tx.select({ id: schema.customers.id }).from(schema.customers)
        .where(eq(schema.customers.id, input.customerId)).for("update");
      if (!customer) return { ok: false, error: "Customer not found" };
      await tx.insert(schema.vehicles).values({
        id: vehicleId,
        customerId: input.customerId,
        year: input.year,
        make: input.make,
        model: input.model,
        trim: input.trim,
        category: input.category,
        colour: input.colour,
        licencePlate: input.licencePlate,
      });
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "customer.vehicle_added",
        entityType: "vehicle",
        entityId: vehicleId,
        after: { customerId: input.customerId, year: input.year, make: input.make, model: input.model },
      });
      return { ok: true, vehicleId };
    });
    if (result.ok) {
      revalidatePath(`/admin/customers/${input.customerId}`);
      revalidatePath(`/admin/fleet/${input.customerId}`);
    }
    return result;
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: error.message };
    console.error("addCustomerVehicleAction failed", error);
    return { ok: false, error: "Something went wrong" };
  }
}

export async function issueCustomerPortalLinkAction(
  raw: unknown,
): Promise<CustomerActionResult<{ link: string; delivery: "email" | "sms" | "copy_only" }>> {
  try {
    const staff = await requireStaff("manage_customers");
    const parsed = z.object({ customerId: z.string().min(1), expiryDays: z.number().int().min(1).max(365).default(90) }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid portal request" };
    const { customerId, expiryDays } = parsed.data;
    const settings = await getSettings();

    const result = await db().transaction(async (tx) => {
      const [customer] = await tx.select().from(schema.customers).where(eq(schema.customers.id, customerId)).for("update");
      if (!customer || customer.anonymizedAt) return null;
      const token = await createCustomerPortalToken(tx, {
        customerId,
        expiresAt: new Date(Date.now() + expiryDays * 86_400_000),
      });
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "customer.portal_link_issued",
        entityType: "customer",
        entityId: customerId,
        after: { expiresInDays: expiryDays },
      });
      return { customer, token };
    });
    if (!result) return { ok: false, error: "Customer not found" };

    const base = getAppBaseUrl();
    const link = `${base}/portal/${result.token}`;
    const message = await sendMessageTemplate({
      templateKey: "portal_access",
      recipient: result.customer,
      customerId,
      kind: "manual",
      variables: {
        businessName: settings.businessName,
        firstName: result.customer.firstName,
        expiryDays: String(expiryDays),
        link,
      },
      relatedEntityType: "customer",
      relatedEntityId: customerId,
    });
    const delivery = message.sent ? (message.channel ?? "copy_only") : "copy_only";
    revalidatePath(`/admin/customers/${customerId}`);
    revalidatePath(`/admin/fleet/${customerId}`);
    return { ok: true, link, delivery };
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: error.message };
    console.error("issueCustomerPortalLinkAction failed", error);
    return { ok: false, error: "Something went wrong" };
  }
}

export async function updateCustomerAction(raw: unknown): Promise<CustomerActionResult> {
  try {
    const staff = await requireStaff("manage_customers");
    const parsed = z.object({
      customerId: z.string().min(1),
      firstName: z.string().trim().min(1).max(100),
      lastName: z.string().trim().max(100),
      email: optionalEmail,
      phone: optionalText(30),
      preferredContact: z.enum(["email", "sms", "phone"]),
      customerType: z.enum(["individual", "business"]),
      companyName: optionalText(160),
      tags: z.array(z.string().trim().min(1).max(40)).max(20),
      notes: optionalText(4000),
      marketingConsent: z.boolean(),
    }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Please check the customer details" };
    const input = parsed.data;
    if (!input.email && !input.phone) return { ok: false, error: "Add an email address or phone number" };
    if (input.preferredContact === "email" && !input.email) return { ok: false, error: "Preferred email requires an email address" };
    if (input.preferredContact !== "email" && !input.phone) return { ok: false, error: "Preferred phone contact requires a phone number" };
    if (input.customerType === "business" && !input.companyName) return { ok: false, error: "Business customers need a company name" };

    const result = await db().transaction(async (tx): Promise<CustomerActionResult> => {
      const [customer] = await tx.select().from(schema.customers)
        .where(eq(schema.customers.id, input.customerId)).for("update");
      if (!customer || customer.anonymizedAt) return { ok: false, error: "Customer not found" };
      const after = {
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email ?? null,
        phone: input.phone ?? null,
        preferredContact: input.preferredContact,
        customerType: input.customerType,
        companyName: input.customerType === "business" ? input.companyName ?? null : null,
        tags: [...new Set(input.tags.map((tag) => tag.toLowerCase()))],
        notes: input.notes ?? null,
        marketingConsent: input.marketingConsent,
      };
      await tx.update(schema.customers).set({
        ...after,
        marketingConsentAt: input.marketingConsent
          ? customer.marketingConsentAt ?? new Date()
          : null,
        marketingConsentSource: input.marketingConsent
          ? customer.marketingConsentSource ?? "staff_update"
          : null,
        updatedAt: new Date(),
      }).where(eq(schema.customers.id, customer.id));
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "customer.updated",
        entityType: "customer",
        entityId: customer.id,
        before: {
          firstName: customer.firstName,
          lastName: customer.lastName,
          email: customer.email,
          phone: customer.phone,
          preferredContact: customer.preferredContact,
          customerType: customer.customerType,
          companyName: customer.companyName,
          tags: customer.tags,
          notes: customer.notes,
          marketingConsent: customer.marketingConsent,
        },
        after,
      });
      return { ok: true };
    });
    if (result.ok) {
      revalidatePath(`/admin/customers/${input.customerId}`);
      revalidatePath("/admin/customers");
      revalidatePath(`/admin/fleet/${input.customerId}`);
    }
    return result;
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: error.message };
    console.error("updateCustomerAction failed", error);
    return { ok: false, error: "Something went wrong" };
  }
}

export async function anonymizeCustomerAction(raw: unknown): Promise<CustomerActionResult> {
  try {
    const staff = await requireStaff("anonymize_customers");
    const parsed = z.object({
      customerId: z.string().min(1),
      confirmation: z.literal("ANONYMIZE"),
      reason: z.string().trim().min(5).max(1000),
    }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Type ANONYMIZE and provide a reason" };
    const { customerId, reason } = parsed.data;

    const result = await db().transaction(async (tx): Promise<CustomerActionResult> => {
      const [customer] = await tx.select().from(schema.customers)
        .where(eq(schema.customers.id, customerId)).for("update");
      if (!customer) return { ok: false, error: "Customer not found" };
      if (customer.anonymizedAt) return { ok: true };

      const relatedLeads = await tx.select({ id: schema.leads.id }).from(schema.leads)
        .where(or(eq(schema.leads.convertedCustomerId, customerId), eq(schema.leads.id, customer.sourceLeadId ?? "")));
      const leadIds = relatedLeads.map((lead) => lead.id);
      await tx.update(schema.customers).set({
        firstName: "Anonymized",
        lastName: "Customer",
        email: null,
        phone: null,
        preferredContact: "email",
        companyName: null,
        tags: [],
        notes: null,
        marketingConsent: false,
        marketingConsentAt: null,
        marketingConsentSource: null,
        referredByCustomerId: null,
        anonymizedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(schema.customers.id, customerId));
      await tx.update(schema.vehicles).set({
        licencePlate: null,
        colour: null,
        conditionNotes: null,
        updatedAt: new Date(),
      }).where(eq(schema.vehicles.customerId, customerId));
      if (leadIds.length > 0) {
        await tx.update(schema.leads).set({
          name: "Anonymized Customer",
          email: null,
          phone: null,
          message: null,
          attribution: null,
          notes: null,
          marketingConsent: false,
          marketingConsentAt: null,
          marketingConsentSource: null,
          anonymizedAt: new Date(),
          updatedAt: new Date(),
        }).where(inArray(schema.leads.id, leadIds));
      }
      await tx.update(schema.communications).set({ subject: null, body: "[Anonymized]" })
        .where(leadIds.length > 0
          ? or(eq(schema.communications.customerId, customerId), inArray(schema.communications.leadId, leadIds))
          : eq(schema.communications.customerId, customerId));
      await tx.update(schema.accessTokens).set({ revokedAt: new Date() })
        .where(eq(schema.accessTokens.customerId, customerId));
      await tx.update(schema.files).set({ publicConsentAt: null, publicConsentRecordedBy: null })
        .where(eq(schema.files.uploadedById, customerId));
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "customer.anonymized",
        entityType: "customer",
        entityId: customerId,
        before: { hadEmail: Boolean(customer.email), hadPhone: Boolean(customer.phone), relatedLeads: leadIds.length },
        after: { anonymized: true },
        reason,
      });
      return { ok: true };
    });
    if (result.ok) {
      revalidatePath(`/admin/customers/${customerId}`);
      revalidatePath("/admin/customers");
      revalidatePath("/admin/fleet");
      revalidatePath("/gallery");
    }
    return result;
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: error.message };
    console.error("anonymizeCustomerAction failed", error);
    return { ok: false, error: "Something went wrong" };
  }
}
