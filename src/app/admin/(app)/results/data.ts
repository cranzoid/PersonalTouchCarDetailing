import "server-only";

import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "@/db";

export async function getEditorOptions() {
  const [services, photos] = await Promise.all([
    db()
      .select({ id: schema.services.id, name: schema.services.name })
      .from(schema.services)
      .where(eq(schema.services.active, true))
      .orderBy(asc(schema.services.sort)),
    db()
      .select({
        id: schema.files.id,
        kind: schema.files.kind,
        contentType: schema.files.contentType,
        createdAt: schema.files.createdAt,
      })
      .from(schema.files)
      .where(isNotNull(schema.files.publicConsentAt))
      .orderBy(desc(schema.files.createdAt))
      .limit(100),
  ]);

  return {
    services,
    photos: photos
      .filter((photo) => ["image/jpeg", "image/png", "image/webp"].includes(photo.contentType))
      .map((photo) => ({ ...photo, createdAt: photo.createdAt.toISOString() })),
  };
}

export async function getCaseStudyEditorData(caseStudyId: string) {
  const [story] = await db()
    .select()
    .from(schema.caseStudies)
    .where(eq(schema.caseStudies.id, caseStudyId))
    .limit(1);
  if (!story) return null;

  const media = await db()
    .select({
      fileId: schema.caseStudyMedia.fileId,
      role: schema.caseStudyMedia.role,
      caption: schema.caseStudyMedia.caption,
      altText: schema.caseStudyMedia.altText,
      sort: schema.caseStudyMedia.sort,
    })
    .from(schema.caseStudyMedia)
    .innerJoin(schema.files, eq(schema.files.id, schema.caseStudyMedia.fileId))
    .where(and(eq(schema.caseStudyMedia.caseStudyId, caseStudyId), isNotNull(schema.files.publicConsentAt)))
    .orderBy(asc(schema.caseStudyMedia.sort));

  return {
    id: story.id,
    slug: story.slug,
    title: story.title,
    summary: story.summary,
    challenge: story.challenge,
    process: story.process,
    outcome: story.outcome,
    primaryServiceId: story.primaryServiceId,
    relatedServiceIds: story.relatedServiceIds,
    media: media.map((item) => ({ ...item, role: item.role as "before" | "after" | "result" })),
    consentConfirmed: Boolean(story.consentConfirmedAt),
    privacyChecked: Boolean(story.privacyCheckedAt),
    status: story.status as "draft" | "published",
  };
}

export async function getConsentedCaseMedia(caseStudyId: string) {
  return db()
    .select({
      id: schema.caseStudyMedia.id,
      fileId: schema.caseStudyMedia.fileId,
      role: schema.caseStudyMedia.role,
      caption: schema.caseStudyMedia.caption,
      altText: schema.caseStudyMedia.altText,
      sort: schema.caseStudyMedia.sort,
      contentType: schema.files.contentType,
      kind: schema.files.kind,
    })
    .from(schema.caseStudyMedia)
    .innerJoin(schema.files, eq(schema.files.id, schema.caseStudyMedia.fileId))
    .where(and(
      eq(schema.caseStudyMedia.caseStudyId, caseStudyId),
      isNotNull(schema.files.publicConsentAt),
    ))
    .orderBy(asc(schema.caseStudyMedia.sort));
}
