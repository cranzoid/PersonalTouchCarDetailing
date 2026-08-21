import { z } from "zod";
import { slugifySeoText } from "./seo";

export const CASE_STUDY_STATUSES = ["draft", "published"] as const;
export type CaseStudyStatus = (typeof CASE_STUDY_STATUSES)[number];

export const CASE_STUDY_MEDIA_ROLES = ["before", "after", "result"] as const;
export type CaseStudyMediaRole = (typeof CASE_STUDY_MEDIA_ROLES)[number];

export const caseStudyMediaInput = z.object({
  fileId: z.string().min(1),
  role: z.enum(CASE_STUDY_MEDIA_ROLES),
  caption: z.string().trim().max(500),
  altText: z.string().trim().min(8).max(300),
  sort: z.number().int().min(0).max(500),
});

export const caseStudyEditorInput = z.object({
  id: z.string().optional(),
  slug: z.string().trim().max(80).optional(),
  title: z.string().trim().min(5).max(100),
  summary: z.string().trim().max(180),
  challenge: z.string().trim().max(8_000),
  process: z.string().trim().max(12_000),
  outcome: z.string().trim().max(8_000),
  primaryServiceId: z.string().min(1),
  relatedServiceIds: z.array(z.string().min(1)).max(12),
  media: z.array(caseStudyMediaInput).max(30),
  consentConfirmed: z.boolean(),
  privacyChecked: z.boolean(),
});

export type CaseStudyEditorInput = z.infer<typeof caseStudyEditorInput>;

export function normalizeCaseStudySlug(input: string | undefined, title: string): string {
  return slugifySeoText(input?.trim() || title);
}

export type PublicationCandidate = Pick<
  CaseStudyEditorInput,
  "slug" | "title" | "summary" | "challenge" | "process" | "outcome" | "primaryServiceId"
> & {
  consentConfirmedAt: Date | null;
  privacyCheckedAt: Date | null;
  approvedMediaCount: number;
};

/** The same publication rules are used by the action and unit tests. */
export function publicationErrors(candidate: PublicationCandidate): string[] {
  const errors: string[] = [];
  if (!normalizeCaseStudySlug(candidate.slug, candidate.title)) errors.push("Add a unique URL slug.");
  if (candidate.title.trim().length < 5) errors.push("Add a complete title.");
  if (candidate.summary.trim().length < 40) errors.push("Add a useful summary of at least 40 characters.");
  if (candidate.challenge.trim().length < 80) errors.push("Describe the starting condition and challenge in more detail.");
  if (candidate.process.trim().length < 80) errors.push("Describe the work performed in more detail.");
  if (candidate.outcome.trim().length < 80) errors.push("Describe the result and realistic outcome in more detail.");
  if (!candidate.primaryServiceId) errors.push("Link a primary service.");
  if (!candidate.consentConfirmedAt) errors.push("Confirm that the customer approved the selected media for marketing.");
  if (!candidate.privacyCheckedAt) errors.push("Confirm that names, plates, VINs, addresses and other identifiers are absent.");
  if (candidate.approvedMediaCount < 1) errors.push("Link at least one image with current public consent.");
  return errors;
}
