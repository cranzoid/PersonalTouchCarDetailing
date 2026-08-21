import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNotNull, sql } from "drizzle-orm";

const staff = vi.hoisted(() => ({
  id: "usr_case_study_manager",
  name: "Case Study Manager",
  email: "case-studies@example.com",
  role: "manager" as const,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  requireStaff: vi.fn(async () => staff),
  AuthError: class AuthError extends Error {},
}));

import { db, getPool, schema } from "../src/db";
import { newId } from "../src/lib/id";
import {
  publishCaseStudyAction,
  saveCaseStudyAction,
} from "../src/app/admin/(app)/results/actions";

let serviceId: string;
let fileId: string;

beforeEach(async () => {
  await db().execute(sql`
    TRUNCATE case_study_media, case_studies, files, services, service_categories,
             staff_users, audit_log CASCADE
  `);
  await db().insert(schema.staffUsers).values({
    id: staff.id,
    name: staff.name,
    email: staff.email,
    passwordHash: "not-used-in-tests",
    role: staff.role,
  });
  const categoryId = newId("cat");
  serviceId = newId("svc");
  fileId = newId("file");
  await db().insert(schema.serviceCategories).values({ id: categoryId, name: "Interior", slug: "interior" });
  await db().insert(schema.services).values({ id: serviceId, categoryId, name: "Interior Detail", slug: "interior-detail", active: true });
  await db().insert(schema.files).values({
    id: fileId,
    entityType: "job",
    entityId: "job_case_study_test",
    kind: "after",
    storageKey: "tests/case-study-after.jpg",
    contentType: "image/jpeg",
    sizeBytes: 1_024,
    uploadedByType: "staff",
    uploadedById: staff.id,
    publicConsentAt: new Date(),
    publicConsentRecordedBy: staff.id,
  });
});

afterAll(async () => {
  await getPool().end();
});

const completeStory = () => ({
  slug: "salt-stained-interior-reset",
  title: "Salt-stained interior reset for a Hamilton daily driver",
  summary: "A customer-approved look at a condition-aware interior reset after a difficult Hamilton winter.",
  challenge: "Salt residue, embedded debris and older marks were visible across the footwells and seating areas when the vehicle arrived for inspection.",
  process: "The interior was inspected, loose debris was removed, and carpets, seats, mats, trim and glass were cleaned with material-appropriate methods.",
  outcome: "The cabin was substantially cleaner and more consistent. One permanent material mark remained and was documented rather than described as removed.",
  primaryServiceId: serviceId,
  relatedServiceIds: [],
  media: [{ fileId, role: "after" as const, caption: "Interior after the documented reset.", altText: "Clean front cabin after interior detailing in Hamilton", sort: 0 }],
  consentConfirmed: true,
  privacyChecked: true,
});

describe("case-study publishing", () => {
  it("publishes only a complete story with a currently consented image and audits both writes", async () => {
    const saved = await saveCaseStudyAction(completeStory());
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const published = await publishCaseStudyAction(saved.id);
    expect(published).toMatchObject({ ok: true, id: saved.id });
    const [story] = await db().select().from(schema.caseStudies).where(eq(schema.caseStudies.id, saved.id));
    expect(story.status).toBe("published");
    expect(story.publishedAt).toBeInstanceOf(Date);

    const audits = await db().select().from(schema.auditLog).where(eq(schema.auditLog.entityId, saved.id));
    expect(audits.map((entry) => entry.action)).toEqual(["case_study.created", "case_study.published"]);
  });

  it("immediately removes a revoked image from consent-safe public selection", async () => {
    const saved = await saveCaseStudyAction(completeStory());
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect((await publishCaseStudyAction(saved.id)).ok).toBe(true);

    await db().update(schema.files).set({ publicConsentAt: null, publicConsentRecordedBy: null }).where(eq(schema.files.id, fileId));
    const visibleMedia = await db()
      .select({ id: schema.caseStudyMedia.id })
      .from(schema.caseStudyMedia)
      .innerJoin(schema.files, and(eq(schema.files.id, schema.caseStudyMedia.fileId), isNotNull(schema.files.publicConsentAt)))
      .where(eq(schema.caseStudyMedia.caseStudyId, saved.id));
    expect(visibleMedia).toEqual([]);
  });

  it("refuses to save a story that attempts to link media without public consent", async () => {
    await db().update(schema.files).set({ publicConsentAt: null }).where(eq(schema.files.id, fileId));
    const result = await saveCaseStudyAction(completeStory());
    expect(result).toEqual({ ok: false, error: "One or more selected images no longer has public consent." });
    expect(await db().select().from(schema.caseStudies)).toEqual([]);
  });
});
