"use server";

import { randomBytes } from "crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { newId } from "@/lib/id";
import { requireStaff, AuthError } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { getSettings } from "@/lib/settings";
import { sendMessageTemplate } from "@/lib/messaging";
import {
  canTransitionJob,
  createAdditionalWorkAccessToken,
  isJobStatus,
  isQcComplete,
} from "@/lib/jobs";
import { JOB_STATUSES } from "@/lib/types";
import { putPrivateFile } from "@/lib/storage";
import { getAppBaseUrl } from "@/lib/urls";

export type ActionResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

function photoExt(type: string): string {
  return type === "image/png" ? "png" : type === "image/webp" ? "webp" : type === "image/heic" ? "heic" : "jpg";
}

async function storeJobPhotos(input: {
  photos: File[];
  entityType: "job" | "inspection";
  entityId: string;
  /** Storage keys always live under the owning job's folder. */
  jobId: string;
  kind: string;
  staffId: string;
}): Promise<void> {
  if (input.photos.length === 0) return;
  for (const photo of input.photos) {
    const key = `jobs/${input.jobId}/${randomBytes(8).toString("hex")}.${photoExt(photo.type)}`;
    await putPrivateFile(key, Buffer.from(await photo.arrayBuffer()), photo.type);
    await db().insert(schema.files).values({
      id: newId("file"),
      entityType: input.entityType,
      entityId: input.entityId,
      kind: input.kind,
      storageKey: key,
      contentType: photo.type,
      sizeBytes: photo.size,
      uploadedByType: "staff",
      uploadedById: input.staffId,
    });
  }
}

function extractPhotos(formData: FormData): { photos: File[]; error?: string } {
  const photos = formData
    .getAll("photos")
    .filter((f): f is File => f instanceof File && f.size > 0);
  for (const photo of photos) {
    if (!PHOTO_TYPES.has(photo.type)) return { photos: [], error: "Photos must be JPEG, PNG, WebP or HEIC" };
    if (photo.size > MAX_PHOTO_BYTES) return { photos: [], error: "Each photo must be under 10 MB" };
  }
  if (photos.length > 20) return { photos: [], error: "At most 20 photos per upload" };
  return { photos };
}

/* ------------------------------------------------------------------ */
/* Check-in: arrived appointment → job                                 */
/* ------------------------------------------------------------------ */

export async function checkInAppointmentAction(
  raw: unknown,
): Promise<ActionResult<{ jobId: string }>> {
  try {
    const staff = await requireStaff("work_jobs");
    const parsed = z.object({ appointmentId: z.string().min(1) }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid request" };
    const { appointmentId } = parsed.data;

    const result = await db().transaction(async (tx): Promise<ActionResult<{ jobId: string }>> => {
      const rows = await tx
        .select()
        .from(schema.appointments)
        .where(eq(schema.appointments.id, appointmentId))
        .for("update");
      const appt = rows[0];
      if (!appt) return { ok: false, error: "Appointment not found" };
      if (appt.jobId) return { ok: false, error: "This appointment is already checked in" };
      if (appt.status !== "arrived") {
        return { ok: false, error: "Mark the appointment as arrived before checking in" };
      }

      const jobId = newId("job");
      await tx.insert(schema.jobs).values({
        id: jobId,
        appointmentId: appt.id,
        customerId: appt.customerId,
        vehicleId: appt.vehicleId,
        status: "checked_in",
        assignedStaffId: appt.assignedStaffId ?? staff.id,
        resourceId: appt.resourceId,
      });
      await tx
        .update(schema.appointments)
        .set({ jobId, status: "converted", updatedAt: new Date() })
        .where(eq(schema.appointments.id, appt.id));

      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "job.checked_in",
        entityType: "job",
        entityId: jobId,
        after: { appointmentId: appt.id, customerId: appt.customerId, vehicleId: appt.vehicleId },
      });
      return { ok: true, jobId };
    });

    if (result.ok) {
      revalidatePath("/admin/appointments");
      revalidatePath(`/admin/appointments/${appointmentId}`);
      revalidatePath("/admin/jobs");
    }
    return result;
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("checkInAppointmentAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/* ------------------------------------------------------------------ */
/* Status transitions                                                  */
/* ------------------------------------------------------------------ */

export async function transitionJobAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("work_jobs");
    const parsed = z
      .object({ jobId: z.string().min(1), to: z.enum(JOB_STATUSES) })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid request" };
    const { jobId, to } = parsed.data;
    const settings = await getSettings();

    const result = await db().transaction(async (tx): Promise<ActionResult<{ notifyReady?: boolean }>> => {
      const rows = await tx.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).for("update");
      const job = rows[0];
      if (!job) return { ok: false, error: "Job not found" };
      if (!isJobStatus(job.status)) return { ok: false, error: "Job has an unknown status" };
      if (!canTransitionJob(job.status, to)) {
        return { ok: false, error: `Cannot move a ${job.status.replaceAll("_", " ")} job to ${to.replaceAll("_", " ")}` };
      }

      // Pickup is gated on the QC checklist — every item must be ticked.
      if (to === "ready_for_pickup") {
        const qc = (
          await tx.select().from(schema.qcChecklists).where(eq(schema.qcChecklists.jobId, jobId)).limit(1)
        )[0];
        if (!qc || !isQcComplete(qc.items)) {
          return { ok: false, error: "Complete every QC checklist item before marking ready for pickup" };
        }
      }

      await tx
        .update(schema.jobs)
        .set({
          status: to,
          updatedAt: new Date(),
          ...(to === "in_progress" && !job.startedAt ? { startedAt: new Date() } : {}),
          ...(to === "completed" ? { completedAt: new Date() } : {}),
        })
        .where(eq(schema.jobs.id, jobId));

      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: `job.${to}`,
        entityType: "job",
        entityId: jobId,
        before: { status: job.status },
        after: { status: to },
      });
      return { ok: true, notifyReady: to === "ready_for_pickup" };
    });
    if (!result.ok) return result;

    // Courtesy "vehicle ready" message outside the transaction (dev transport logs it).
    if (result.notifyReady) {
      const [row] = await db()
        .select({ job: schema.jobs, customer: schema.customers, vehicle: schema.vehicles })
        .from(schema.jobs)
        .innerJoin(schema.customers, eq(schema.jobs.customerId, schema.customers.id))
        .innerJoin(schema.vehicles, eq(schema.jobs.vehicleId, schema.vehicles.id))
        .where(eq(schema.jobs.id, jobId))
        .limit(1);
      if (row) {
        await sendMessageTemplate({
          templateKey: "vehicle_ready",
          recipient: row.customer,
          customerId: row.customer.id,
          kind: "ready",
          variables: {
            businessName: settings.businessName,
            vehicle: [row.vehicle.year, row.vehicle.make, row.vehicle.model].filter(Boolean).join(" "),
          },
          relatedEntityType: "job",
          relatedEntityId: jobId,
        });
      }
    }

    revalidatePath("/admin/jobs");
    revalidatePath(`/admin/jobs/${jobId}`);
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("transitionJobAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/* ------------------------------------------------------------------ */
/* Inspection                                                          */
/* ------------------------------------------------------------------ */

const findingSchema = z.object({
  area: z.string().trim().min(1).max(80),
  type: z.enum(["scratch", "dent", "chip", "stain", "pet_hair", "odour", "dirt", "other"]),
  severity: z.enum(["minor", "moderate", "severe"]),
  description: z.string().trim().max(500).optional(),
});

const inspectionSchema = z.object({
  jobId: z.string().min(1),
  mileage: z.number().int().min(0).max(2_000_000).optional(),
  customerConcerns: z.string().trim().max(2000).optional(),
  personalBelongings: z.string().trim().max(2000).optional(),
  additionalWorkIdentified: z.string().trim().max(2000).optional(),
  findings: z.array(findingSchema).max(50).default([]),
});

export async function completeInspectionAction(formData: FormData): Promise<ActionResult> {
  try {
    const staff = await requireStaff("work_jobs");
    let payload: unknown;
    try {
      payload = JSON.parse(String(formData.get("payload") ?? "{}"));
    } catch {
      return { ok: false, error: "Invalid request" };
    }
    const parsed = inspectionSchema.safeParse(payload);
    if (!parsed.success) return { ok: false, error: "Please check the inspection fields" };
    const input = parsed.data;
    const { photos, error: photoError } = extractPhotos(formData);
    if (photoError) return { ok: false, error: photoError };

    const result = await db().transaction(async (tx): Promise<ActionResult<{ inspectionId: string }>> => {
      const rows = await tx.select().from(schema.jobs).where(eq(schema.jobs.id, input.jobId)).for("update");
      const job = rows[0];
      if (!job) return { ok: false, error: "Job not found" };
      if (!["checked_in", "inspection"].includes(job.status)) {
        return { ok: false, error: "This job is past the inspection stage" };
      }
      const existing = await tx
        .select({ id: schema.inspections.id })
        .from(schema.inspections)
        .where(eq(schema.inspections.jobId, input.jobId))
        .limit(1);
      if (existing[0]) return { ok: false, error: "An inspection was already recorded for this job" };

      const inspectionId = newId("insp");
      await tx.insert(schema.inspections).values({
        id: inspectionId,
        jobId: input.jobId,
        mileage: input.mileage ?? null,
        customerConcerns: input.customerConcerns || null,
        personalBelongings: input.personalBelongings || null,
        additionalWorkIdentified: input.additionalWorkIdentified || null,
        completedByStaffId: staff.id,
        completedAt: new Date(),
      });
      if (input.findings.length > 0) {
        await tx.insert(schema.inspectionFindings).values(
          input.findings.map((f) => ({
            id: newId("find"),
            inspectionId,
            area: f.area,
            type: f.type,
            severity: f.severity,
            description: f.description || null,
          })),
        );
      }
      await tx
        .update(schema.jobs)
        .set({
          status: "inspection",
          ...(input.mileage !== undefined ? { mileageIn: input.mileage } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.jobs.id, input.jobId));

      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "job.inspection_completed",
        entityType: "job",
        entityId: input.jobId,
        after: { inspectionId, findings: input.findings.length, mileage: input.mileage ?? null },
      });
      return { ok: true, inspectionId };
    });
    if (!result.ok) return result;

    // Photos are written outside the transaction (disk IO); rows reference the
    // committed inspection.
    await storeJobPhotos({
      photos,
      entityType: "inspection",
      entityId: result.inspectionId,
      jobId: input.jobId,
      kind: "checkin",
      staffId: staff.id,
    });

    revalidatePath(`/admin/jobs/${input.jobId}`);
    revalidatePath("/admin/jobs");
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("completeInspectionAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/* ------------------------------------------------------------------ */
/* Job photos                                                          */
/* ------------------------------------------------------------------ */

export async function uploadJobPhotosAction(formData: FormData): Promise<ActionResult> {
  try {
    const staff = await requireStaff("work_jobs");
    const parsed = z
      .object({
        jobId: z.string().min(1),
        kind: z.enum(["before", "progress", "after", "damage", "other"]),
      })
      .safeParse({ jobId: formData.get("jobId"), kind: formData.get("kind") });
    if (!parsed.success) return { ok: false, error: "Invalid request" };
    const { photos, error: photoError } = extractPhotos(formData);
    if (photoError) return { ok: false, error: photoError };
    if (photos.length === 0) return { ok: false, error: "Choose at least one photo" };

    const job = (
      await db().select({ id: schema.jobs.id }).from(schema.jobs).where(eq(schema.jobs.id, parsed.data.jobId)).limit(1)
    )[0];
    if (!job) return { ok: false, error: "Job not found" };

    await storeJobPhotos({
      photos,
      entityType: "job",
      entityId: parsed.data.jobId,
      jobId: parsed.data.jobId,
      kind: parsed.data.kind,
      staffId: staff.id,
    });

    revalidatePath(`/admin/jobs/${parsed.data.jobId}`);
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("uploadJobPhotosAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/* ------------------------------------------------------------------ */
/* Additional work requests                                            */
/* ------------------------------------------------------------------ */

export async function createAdditionalWorkAction(
  raw: unknown,
): Promise<ActionResult<{ requestId: string }>> {
  try {
    const staff = await requireStaff("work_jobs");
    const parsed = z
      .object({
        jobId: z.string().min(1),
        description: z.string().trim().min(1).max(1000),
        priceCents: z.number().int().min(0).max(10_000_000),
        extraMinutes: z.number().int().min(0).max(24 * 60).default(0),
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Please check the additional work fields" };
    const input = parsed.data;

    const result = await db().transaction(async (tx): Promise<ActionResult<{ requestId: string }>> => {
      const job = (
        await tx.select().from(schema.jobs).where(eq(schema.jobs.id, input.jobId)).limit(1)
      )[0];
      if (!job) return { ok: false, error: "Job not found" };
      if (["completed", "ready_for_pickup"].includes(job.status)) {
        return { ok: false, error: "This job is too far along for additional work" };
      }
      const requestId = newId("awr");
      await tx.insert(schema.additionalWorkRequests).values({
        id: requestId,
        jobId: input.jobId,
        description: input.description,
        priceCents: input.priceCents,
        extraMinutes: input.extraMinutes,
        createdByStaffId: staff.id,
      });
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "additional_work.created",
        entityType: "additional_work_request",
        entityId: requestId,
        after: { jobId: input.jobId, priceCents: input.priceCents, extraMinutes: input.extraMinutes },
      });
      return { ok: true, requestId };
    });

    if (result.ok) revalidatePath(`/admin/jobs/${input.jobId}`);
    return result;
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("createAdditionalWorkAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

export async function sendAdditionalWorkApprovalAction(
  raw: unknown,
): Promise<ActionResult<{ link: string; delivery: "email" | "sms" | null }>> {
  try {
    const staff = await requireStaff("work_jobs");
    const parsed = z.object({ requestId: z.string().min(1) }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid request" };
    const { requestId } = parsed.data;
    const settings = await getSettings();

    const result = await db().transaction(async (tx): Promise<
      ActionResult<{ token: string; jobId: string; customerId: string; description: string; priceCents: number }>
    > => {
      const rows = await tx
        .select()
        .from(schema.additionalWorkRequests)
        .where(eq(schema.additionalWorkRequests.id, requestId))
        .for("update");
      const request = rows[0];
      if (!request) return { ok: false, error: "Request not found" };
      if (request.status !== "pending") {
        return { ok: false, error: "Only pending requests can be sent for approval" };
      }
      const job = (
        await tx.select().from(schema.jobs).where(eq(schema.jobs.id, request.jobId)).limit(1)
      )[0];
      if (!job) return { ok: false, error: "Job not found" };

      // Mid-job approvals move fast — a short-lived link is plenty.
      const token = await createAdditionalWorkAccessToken(tx, {
        requestId,
        customerId: job.customerId,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      });
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "additional_work.sent",
        entityType: "additional_work_request",
        entityId: requestId,
        after: { jobId: job.id },
      });
      return {
        ok: true,
        token,
        jobId: job.id,
        customerId: job.customerId,
        description: request.description,
        priceCents: request.priceCents,
      };
    });
    if (!result.ok) return result;

    const base = getAppBaseUrl();
    const link = `${base}/portal/work/${result.token}`;

    const customer = (
      await db().select().from(schema.customers).where(eq(schema.customers.id, result.customerId)).limit(1)
    )[0];
    const message = customer
      ? await sendMessageTemplate({
          templateKey: "additional_work_request",
          recipient: customer,
          customerId: customer.id,
          kind: "approval_request",
          variables: {
            businessName: settings.businessName,
            firstName: customer.firstName,
            description: result.description,
            price: (result.priceCents / 100).toLocaleString("en-CA", { style: "currency", currency: "CAD" }),
            link,
          },
          relatedEntityType: "additional_work_request",
          relatedEntityId: requestId,
        })
      : null;

    revalidatePath(`/admin/jobs/${result.jobId}`);
    return { ok: true, link, delivery: message?.sent ? (message.channel ?? null) : null };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("sendAdditionalWorkApprovalAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

export async function overrideAdditionalWorkAction(raw: unknown): Promise<ActionResult> {
  try {
    // Overriding a customer decision is a pricing call — managers, not techs.
    const staff = await requireStaff("manage_estimates");
    const parsed = z
      .object({
        requestId: z.string().min(1),
        decision: z.enum(["approve", "decline"]),
        reason: z.string().trim().min(1).max(1000),
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, error: "A reason is required for a staff override" };
    const input = parsed.data;

    const result = await db().transaction(async (tx): Promise<ActionResult<{ jobId: string }>> => {
      const rows = await tx
        .select()
        .from(schema.additionalWorkRequests)
        .where(eq(schema.additionalWorkRequests.id, input.requestId))
        .for("update");
      const request = rows[0];
      if (!request) return { ok: false, error: "Request not found" };
      if (request.status !== "pending") return { ok: false, error: "This request was already decided" };

      const newStatus = input.decision === "approve" ? "override_approved" : "declined";
      await tx
        .update(schema.additionalWorkRequests)
        .set({
          status: newStatus,
          decidedAt: new Date(),
          decidedVia: "staff_override",
          overrideStaffId: staff.id,
          overrideReason: input.reason,
          updatedAt: new Date(),
        })
        .where(eq(schema.additionalWorkRequests.id, input.requestId));

      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: `additional_work.${newStatus}`,
        entityType: "additional_work_request",
        entityId: input.requestId,
        before: { status: request.status },
        after: { status: newStatus, decidedVia: "staff_override" },
        reason: input.reason,
      });
      return { ok: true, jobId: request.jobId };
    });

    if (result.ok) revalidatePath(`/admin/jobs/${result.jobId}`);
    return result.ok ? { ok: true } : result;
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("overrideAdditionalWorkAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/* ------------------------------------------------------------------ */
/* QC checklist                                                        */
/* ------------------------------------------------------------------ */

export async function saveQcChecklistAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("work_jobs");
    const parsed = z
      .object({
        jobId: z.string().min(1),
        items: z.record(z.string(), z.boolean()),
        notes: z.string().trim().max(2000).optional(),
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid request" };
    const input = parsed.data;

    await db().transaction(async (tx) => {
      const job = (
        await tx.select({ id: schema.jobs.id }).from(schema.jobs).where(eq(schema.jobs.id, input.jobId)).limit(1)
      )[0];
      if (!job) throw new Error("Job not found");

      const complete = isQcComplete(input.items);
      const existing = (
        await tx.select().from(schema.qcChecklists).where(eq(schema.qcChecklists.jobId, input.jobId)).limit(1)
      )[0];
      if (existing) {
        await tx
          .update(schema.qcChecklists)
          .set({
            items: input.items,
            notes: input.notes || null,
            completedByStaffId: complete ? staff.id : null,
            completedAt: complete ? existing.completedAt ?? new Date() : null,
            updatedAt: new Date(),
          })
          .where(eq(schema.qcChecklists.id, existing.id));
      } else {
        await tx.insert(schema.qcChecklists).values({
          id: newId("qc"),
          jobId: input.jobId,
          items: input.items,
          notes: input.notes || null,
          completedByStaffId: complete ? staff.id : null,
          completedAt: complete ? new Date() : null,
        });
      }
      if (complete && !existing?.completedAt) {
        await audit(tx, {
          actorType: "staff",
          actorId: staff.id,
          action: "job.qc_completed",
          entityType: "job",
          entityId: input.jobId,
          after: { items: input.items },
        });
      }
    });

    revalidatePath(`/admin/jobs/${input.jobId}`);
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("saveQcChecklistAction failed", err);
    return { ok: false, error: err instanceof Error && err.message === "Job not found" ? err.message : "Something went wrong" };
  }
}

/* ------------------------------------------------------------------ */
/* Notes                                                               */
/* ------------------------------------------------------------------ */

export async function updateJobNotesAction(raw: unknown): Promise<ActionResult> {
  try {
    await requireStaff("work_jobs");
    const parsed = z
      .object({ jobId: z.string().min(1), internalNotes: z.string().trim().max(4000) })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid request" };
    const updated = await db()
      .update(schema.jobs)
      .set({ internalNotes: parsed.data.internalNotes || null, updatedAt: new Date() })
      .where(eq(schema.jobs.id, parsed.data.jobId))
      .returning({ id: schema.jobs.id });
    if (!updated[0]) return { ok: false, error: "Job not found" };
    revalidatePath(`/admin/jobs/${parsed.data.jobId}`);
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("updateJobNotesAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}

/* ------------------------------------------------------------------ */
/* Separate public gallery consent                                    */
/* ------------------------------------------------------------------ */

export async function setPhotoPublicConsentAction(raw: unknown): Promise<ActionResult> {
  try {
    const staff = await requireStaff("work_jobs", "manage_customers");
    const parsed = z.object({ fileId: z.string().min(1), consent: z.boolean() }).safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Invalid request" };

    const result = await db().transaction(async (tx): Promise<ActionResult<{ jobId?: string }>> => {
      const [file] = await tx
        .select()
        .from(schema.files)
        .where(eq(schema.files.id, parsed.data.fileId))
        .for("update");
      if (!file || !["job", "inspection"].includes(file.entityType)) {
        return { ok: false, error: "Photo not found" };
      }
      const jobId = file.entityType === "job"
        ? file.entityId
        : (await tx.select({ jobId: schema.inspections.jobId }).from(schema.inspections)
            .where(eq(schema.inspections.id, file.entityId)).limit(1))[0]?.jobId;
      await tx
        .update(schema.files)
        .set({
          publicConsentAt: parsed.data.consent ? new Date() : null,
          publicConsentRecordedBy: parsed.data.consent ? staff.id : null,
        })
        .where(eq(schema.files.id, file.id));
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: parsed.data.consent ? "file.public_consent_recorded" : "file.public_consent_revoked",
        entityType: "file",
        entityId: file.id,
        before: { publicConsentAt: file.publicConsentAt },
        after: { publicConsent: parsed.data.consent },
      });
      return { ok: true, jobId };
    });
    if (result.ok && result.jobId) revalidatePath(`/admin/jobs/${result.jobId}`);
    revalidatePath("/gallery");
    return result.ok ? { ok: true } : result;
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    console.error("setPhotoPublicConsentAction failed", err);
    return { ok: false, error: "Something went wrong" };
  }
}
