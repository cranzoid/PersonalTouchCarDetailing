import { z } from "zod";

export const blogPostEditorInput = z.object({
  id: z.string().min(1).optional(),
  title: z.string().trim().min(3, "Add a descriptive title.").max(140),
  slug: z.string().trim().max(90),
  excerpt: z.string().trim().max(320),
  content: z.string().trim().max(60_000),
  seoTitle: z.string().trim().max(70),
  seoDescription: z.string().trim().max(170),
});

export type BlogPostEditorInput = z.infer<typeof blogPostEditorInput>;

export function normalizeBlogSlug(slug: string, title = ""): string {
  return (slug || title)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

export function blogPublicationErrors(post: {
  title: string;
  excerpt: string;
  content: string;
  seoTitle?: string | null;
  seoDescription?: string | null;
}): string[] {
  const errors: string[] = [];
  if (post.title.trim().length < 3) errors.push("Add a descriptive title.");
  if (post.excerpt.trim().length < 40) errors.push("Add an excerpt of at least 40 characters.");
  if (post.content.trim().length < 200) errors.push("Add at least 200 characters of useful article content.");
  if ((post.seoTitle ?? "").trim().length > 70) errors.push("Keep the SEO title at 70 characters or fewer.");
  if ((post.seoDescription ?? "").trim().length > 170) errors.push("Keep the SEO description at 170 characters or fewer.");
  return errors;
}
