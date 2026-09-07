import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db, schema } from "@/db";
import { requirePageStaff } from "@/lib/auth/page";
import { BlogEditor } from "../blog-editor";

export const dynamic = "force-dynamic";

export default async function EditBlogPostPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageStaff("manage_marketing");
  const { id } = await params;
  const [post] = await db().select().from(schema.blogPosts).where(eq(schema.blogPosts.id, id)).limit(1);
  if (!post) notFound();
  return <div className="max-w-[92rem]"><header className="mb-6"><p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#8A681F]">Blog</p><h1 className="mt-1 text-2xl font-bold text-[#0B2A4A]">Edit article</h1></header><BlogEditor initial={{ id: post.id, slug: post.slug, title: post.title, excerpt: post.excerpt, content: post.content, seoTitle: post.seoTitle ?? "", seoDescription: post.seoDescription ?? "", status: post.status as "draft" | "published" }} /></div>;
}
