"use server";

import { revalidatePath } from "next/cache";
import { and, eq, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "@/lib/audit";
import { AuthError, requireStaff } from "@/lib/auth/session";
import {
  blogPostEditorInput,
  blogPublicationErrors,
  normalizeBlogSlug,
} from "@/lib/blog";
import { newId } from "@/lib/id";

export type BlogActionResult =
  | { ok: true; id: string; message: string }
  | { ok: false; error: string };

async function slugAvailable(slug: string, exceptId?: string): Promise<boolean> {
  const condition = exceptId
    ? and(eq(schema.blogPosts.slug, slug), ne(schema.blogPosts.id, exceptId))
    : eq(schema.blogPosts.slug, slug);
  const existing = await db().select({ id: schema.blogPosts.id }).from(schema.blogPosts).where(condition).limit(1);
  return existing.length === 0;
}

function revalidateBlog(id: string, slug: string) {
  revalidatePath("/admin/blog");
  revalidatePath(`/admin/blog/${id}`);
  revalidatePath("/blog");
  revalidatePath(`/blog/${slug}`);
  revalidatePath("/");
  revalidatePath("/sitemap.xml");
}

export async function saveBlogPostAction(raw: unknown): Promise<BlogActionResult> {
  try {
    const staff = await requireStaff("manage_marketing");
    const parsed = blogPostEditorInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the article fields." };
    const input = parsed.data;
    const slug = normalizeBlogSlug(input.slug, input.title);
    if (!slug) return { ok: false, error: "Add a title or URL slug." };
    if (!(await slugAvailable(slug, input.id))) return { ok: false, error: "That URL slug is already in use." };

    const [existing] = input.id
      ? await db().select().from(schema.blogPosts).where(eq(schema.blogPosts.id, input.id)).limit(1)
      : [];
    if (input.id && !existing) return { ok: false, error: "Article not found." };
    if (existing?.status === "published") {
      const errors = blogPublicationErrors(input);
      if (errors.length > 0) return { ok: false, error: `Unpublish this article before removing required content. ${errors.join(" ")}` };
    }

    const id = input.id ?? newId("blg");
    const now = new Date();
    const row = {
      slug,
      title: input.title,
      excerpt: input.excerpt,
      content: input.content,
      seoTitle: input.seoTitle || null,
      seoDescription: input.seoDescription || null,
      updatedByStaffId: staff.id,
      updatedAt: now,
    };
    await db().transaction(async (tx) => {
      const [before] = existing
        ? await tx.select().from(schema.blogPosts).where(eq(schema.blogPosts.id, id)).for("update")
        : [];
      if (existing && !before) throw new Error("Article not found");
      if (before) await tx.update(schema.blogPosts).set(row).where(eq(schema.blogPosts.id, id));
      else await tx.insert(schema.blogPosts).values({
        id,
        ...row,
        status: "draft",
        createdByStaffId: staff.id,
      });
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: before ? "blog_post.updated" : "blog_post.created",
        entityType: "blog_post",
        entityId: id,
        before,
        after: row,
      });
    });
    revalidateBlog(id, slug);
    return { ok: true, id, message: existing?.status === "published" ? "Published article updated." : "Draft saved." };
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: error.message };
    console.error("saveBlogPostAction failed", error);
    return { ok: false, error: "Could not save the article." };
  }
}

export async function publishBlogPostAction(id: string): Promise<BlogActionResult> {
  try {
    const staff = await requireStaff("manage_marketing");
    const [post] = await db().select().from(schema.blogPosts).where(eq(schema.blogPosts.id, id)).limit(1);
    if (!post) return { ok: false, error: "Article not found." };
    const errors = blogPublicationErrors(post);
    if (errors.length > 0) return { ok: false, error: errors.join(" ") };
    const now = new Date();
    await db().transaction(async (tx) => {
      await tx.update(schema.blogPosts).set({
        status: "published",
        publishedAt: post.publishedAt ?? now,
        updatedByStaffId: staff.id,
        updatedAt: now,
      }).where(eq(schema.blogPosts.id, id));
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "blog_post.published",
        entityType: "blog_post",
        entityId: id,
        before: { status: post.status },
        after: { status: "published", publishedAt: post.publishedAt ?? now },
      });
    });
    revalidateBlog(id, post.slug);
    return { ok: true, id, message: "Article published." };
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: error.message };
    console.error("publishBlogPostAction failed", error);
    return { ok: false, error: "Could not publish the article." };
  }
}

export async function unpublishBlogPostAction(id: string): Promise<BlogActionResult> {
  try {
    const staff = await requireStaff("manage_marketing");
    const [post] = await db().select().from(schema.blogPosts).where(eq(schema.blogPosts.id, id)).limit(1);
    if (!post) return { ok: false, error: "Article not found." };
    await db().transaction(async (tx) => {
      await tx.update(schema.blogPosts).set({
        status: "draft",
        updatedByStaffId: staff.id,
        updatedAt: new Date(),
      }).where(eq(schema.blogPosts.id, id));
      await audit(tx, {
        actorType: "staff",
        actorId: staff.id,
        action: "blog_post.unpublished",
        entityType: "blog_post",
        entityId: id,
        before: { status: post.status },
        after: { status: "draft" },
      });
    });
    revalidateBlog(id, post.slug);
    return { ok: true, id, message: "Article returned to draft." };
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: error.message };
    console.error("unpublishBlogPostAction failed", error);
    return { ok: false, error: "Could not unpublish the article." };
  }
}
