"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray, isNotNull, like, ne, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { AuthError, requireStaff } from "@/lib/auth/session";
import {
  caseStudyEditorInput,
  normalizeCaseStudySlug,
  publicationErrors,
  type CaseStudyEditorInput,
} from "@/lib/case-studies";
import { newId } from "@/lib/id";

export type CaseStudyActionResult =
  | { ok: true; id: string; message?: string }
  | { ok: false; error: string };

async function slugIsAvailable(slug: string, exceptId?: string): Promise<boolean> {
  const conditions = exceptId
    ? and(eq(schema.caseStudies.slug, slug), ne(schema.caseStudies.id, exceptId))
    : eq(schema.caseStudies.slug, slug);
  const existing = await db()
    .select({ id: schema.caseStudies.id })
    .from(schema.caseStudies)
    .where(conditions)
    .limit(1);
  return existing.length === 0;
}

export async function saveCaseStudyAction(raw: unknown): Promise<CaseStudyActionResult> {
  try {
    const staff = await requireStaff("manage_marketing");
    const parsed = caseStudyEditorInput.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the story fields." };
    }
    const input = parsed.data;
    const [existingStory] = input.id
      ? await db().select().from(schema.caseStudies).where(eq(schema.caseStudies.id, input.id)).limit(1)
      : [];
    if (input.id && !existingStory) return { ok: false, error: "Case study not found." };
    const slug = normalizeCaseStudySlug(input.slug, input.title);
    if (!slug) return { ok: false, error: "Add a title or URL slug." };
    if (!(await slugIsAvailable(slug, input.id))) {
      return { ok: false, error: "That URL slug is already in use." };
    }
    if (new Set(input.media.map((item) => item.fileId)).size !== input.media.length) {
      return { ok: false, error: "Each image can be linked only once." };
    }

    const serviceIds = [...new Set([input.primaryServiceId, ...input.relatedServiceIds])];
    const existingServices = await db()
      .select({ id: schema.services.id })
      .from(schema.services)
      .where(inArray(schema.services.id, serviceIds));
    if (existingServices.length !== serviceIds.length) {
      return { ok: false, error: "One or more linked services no longer exist." };
    }

    if (input.media.length > 0) {
      const approvedFiles = await db()
        .select({ id: schema.files.id })
        .from(schema.files)
        .where(and(
          inArray(schema.files.id, input.media.map((item) => item.fileId)),
          isNotNull(schema.files.publicConsentAt),
          like(schema.files.contentType, "image/%"),
        ));
      if (approvedFiles.length !== input.media.length) {
        return { ok: false, error: "One or more selected images no longer has public consent." };
      }
    }

    if (existingStory?.status === "published") {
      const liveErrors = publicationErrors({
        ...input,
        slug,
        consentConfirmedAt: input.consentConfirmed ? (existingStory.consentConfirmedAt ?? new Date()) : null,
        privacyCheckedAt: input.privacyChecked ? (existingStory.privacyCheckedAt ?? new Date()) : null,
        approvedMediaCount: input.media.length,
      });
      if (liveErrors.length > 0) {
        return { ok: false, error: `Unpublish this story before removing required content. ${liveErrors.join(" ")}` };
      }
    }

    const now = new Date();
    const caseStudyId = input.id ?? newId("case");
    await db().transaction(async (tx) => {
      const [before] = input.id
        ? await tx.select().from(schema.caseStudies).where(eq(schema.caseStudies.id, input.id)).limit(1)
        : [];
      if (input.id && !before) throw new Error("Case study not found");

      const row = {
        slug,
        title: input.title,
        summary: input.summary,
        challenge: input.challenge,
        process: input.process,
        outcome: input.outcome,
        primaryServiceId: input.primaryServiceId,
        relatedServiceIds: input.relatedServiceIds.filter((id) => id !== input.primaryServiceId),
        consentConfirmedAt: input.consentConfirmed ? (before?.consentConfirmedAt ?? now) : null,
        consentConfirmedByStaffId: input.consentConfirmed ? (before?.consentConfirmedByStaffId ?? staff.id) : null,
        privacyCheckedAt: input.privacyChecked ? (before?.privacyCheckedAt ?? now) : null,
        privacyCheckedByStaffId: input.privacyChecked ? (before?.privacyCheckedByStaffId ?? staff.id) : null,
        updatedByStaffId: staff.id,
        updatedAt: now,
      };

      if (before) {
        await tx.update(schema.caseStudies).set(row).where(eq(schema.caseStudies.id, caseStudyId));
        await tx.delete(schema.caseStudyMedia).where(eq(schema.caseStudyMedia.caseStudyId, caseStudyId));
      } else {
        await tx.insert(schema.caseStudies).values({
          id: caseStudyId,
          ...row,
          status: "draft",
          createdByStaffId: staff.id,
        });
      }

      if (input.media.length > 0) {
        await tx.insert(schema.caseStudyMedia).values(input.media.map((media, index) => ({
          id: newId("csm"),
          caseStudyId,
          fileId: media.fileId,
          role: media.role,
          caption: media.caption,
          altText: media.altText,
          sort: index,
        })));
      }

      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: before ? "case_study.updated" : "case_study.created",
        entityType: "case_study",
        entityId: caseStudyId,
        before,
        after: { ...row, mediaCount: input.media.length },
      });
    });

    revalidatePath("/admin/results");
    revalidatePath(`/admin/results/${caseStudyId}`);
    revalidatePath("/results");
    revalidatePath(`/results/${slug}`);
    revalidatePath("/sitemap.xml");
    return { ok: true, id: caseStudyId, message: "Draft saved." };
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: error.message };
    console.error("saveCaseStudyAction failed", error);
    return { ok: false, error: error instanceof Error && error.message === "Case study not found" ? error.message : "Could not save the case study." };
  }
}

export async function publishCaseStudyAction(caseStudyId: string): Promise<CaseStudyActionResult> {
  try {
    const staff = await requireStaff("manage_marketing");
    const [story] = await db()
      .select()
      .from(schema.caseStudies)
      .where(eq(schema.caseStudies.id, caseStudyId))
      .limit(1);
    if (!story) return { ok: false, error: "Case study not found." };

    const [primaryService] = await db()
      .select({ id: schema.services.id, active: schema.services.active })
      .from(schema.services)
      .where(eq(schema.services.id, story.primaryServiceId))
      .limit(1);
    if (!primaryService?.active) {
      return { ok: false, error: "The primary service must be active before this story can be published." };
    }

    const [duplicateMetadata] = await db()
      .select({ id: schema.caseStudies.id })
      .from(schema.caseStudies)
      .where(and(
        eq(schema.caseStudies.status, "published"),
        ne(schema.caseStudies.id, caseStudyId),
        or(eq(schema.caseStudies.title, story.title), eq(schema.caseStudies.summary, story.summary)),
      ))
      .limit(1);
    if (duplicateMetadata) {
      return { ok: false, error: "Published case studies need a unique title and summary." };
    }

    const approvedMedia = await db()
      .select({
        id: schema.caseStudyMedia.id,
        caption: schema.caseStudyMedia.caption,
        altText: schema.caseStudyMedia.altText,
      })
      .from(schema.caseStudyMedia)
      .innerJoin(schema.files, and(
        eq(schema.files.id, schema.caseStudyMedia.fileId),
        isNotNull(schema.files.publicConsentAt),
        like(schema.files.contentType, "image/%"),
      ))
      .where(eq(schema.caseStudyMedia.caseStudyId, caseStudyId));
    const errors = publicationErrors({ ...story, approvedMediaCount: approvedMedia.length });
    if (approvedMedia.some((media) => media.caption.trim().length < 8)) {
      errors.push("Add a useful visible caption to every selected image.");
    }
    if (approvedMedia.some((media) => media.altText.trim().length < 8)) {
      errors.push("Add accurate alt text to every selected image.");
    }
    if (errors.length > 0) return { ok: false, error: errors.join(" ") };

    const now = new Date();
    await db().transaction(async (tx) => {
      await tx.update(schema.caseStudies).set({
        status: "published",
        publishedAt: story.publishedAt ?? now,
        updatedAt: now,
        updatedByStaffId: staff.id,
      }).where(eq(schema.caseStudies.id, caseStudyId));
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "case_study.published",
        entityType: "case_study",
        entityId: caseStudyId,
        before: { status: story.status },
        after: { status: "published", publishedAt: story.publishedAt ?? now },
      });
    });

    revalidatePath("/admin/results");
    revalidatePath(`/admin/results/${caseStudyId}`);
    revalidatePath("/results");
    revalidatePath(`/results/${story.slug}`);
    revalidatePath("/sitemap.xml");
    return { ok: true, id: caseStudyId, message: "Case study published." };
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: error.message };
    console.error("publishCaseStudyAction failed", error);
    return { ok: false, error: "Could not publish the case study." };
  }
}

export async function unpublishCaseStudyAction(caseStudyId: string): Promise<CaseStudyActionResult> {
  try {
    const staff = await requireStaff("manage_marketing");
    const [story] = await db().select().from(schema.caseStudies).where(eq(schema.caseStudies.id, caseStudyId)).limit(1);
    if (!story) return { ok: false, error: "Case study not found." };

    await db().transaction(async (tx) => {
      await tx.update(schema.caseStudies).set({
        status: "draft",
        updatedAt: new Date(),
        updatedByStaffId: staff.id,
      }).where(eq(schema.caseStudies.id, caseStudyId));
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "case_study.unpublished",
        entityType: "case_study",
        entityId: caseStudyId,
        before: { status: story.status },
        after: { status: "draft" },
      });
    });

    revalidatePath("/admin/results");
    revalidatePath(`/admin/results/${caseStudyId}`);
    revalidatePath("/results");
    revalidatePath(`/results/${story.slug}`);
    revalidatePath("/sitemap.xml");
    return { ok: true, id: caseStudyId, message: "Case study returned to draft." };
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: error.message };
    console.error("unpublishCaseStudyAction failed", error);
    return { ok: false, error: "Could not unpublish the case study." };
  }
}
