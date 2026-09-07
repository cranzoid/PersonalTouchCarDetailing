import Link from "next/link";
import { desc } from "drizzle-orm";
import { StatusBadge } from "@/components/admin";
import { db, schema } from "@/db";
import { requirePageStaff } from "@/lib/auth/page";

export const dynamic = "force-dynamic";

export default async function BlogAdminPage() {
  await requirePageStaff("manage_marketing");
  const posts = await db().select().from(schema.blogPosts).orderBy(desc(schema.blogPosts.updatedAt));
  return (
    <div className="max-w-6xl">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div><p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#8A681F]">SEO content</p><h1 className="mt-1 text-2xl font-bold text-[#0B2A4A]">Blog</h1><p className="mt-1 max-w-2xl text-sm text-[#687B8E]">Write, review and publish useful articles for local drivers. Drafts stay private until you publish them.</p></div>
        <Link href="/admin/blog/new" className="inline-flex min-h-11 items-center rounded-xl bg-[#0B2A4A] px-4 text-sm font-bold text-white shadow-sm">New article</Link>
      </header>
      <section className="mt-6 rounded-2xl border border-[#DDE4EC] bg-white p-5 shadow-sm">
        {posts.length === 0 ? (
          <div className="rounded-xl bg-[#F5F7FA] px-5 py-12 text-center"><h2 className="font-bold text-[#0B2A4A]">No articles yet</h2><p className="mt-2 text-sm text-[#687B8E]">Create your first draft, then publish it when the copy and search preview are ready.</p></div>
        ) : (
          <div className="overflow-x-auto"><table className="w-full min-w-[44rem] text-left text-sm"><thead className="text-[11px] uppercase tracking-wide text-[#8494A5]"><tr><th className="py-2 pr-4">Article</th><th className="py-2 pr-4">Status</th><th className="py-2 pr-4">Published</th><th className="py-2">Updated</th></tr></thead><tbody className="divide-y divide-[#EBF0F5]">{posts.map((post) => <tr key={post.id}><td className="py-4 pr-4"><Link href={`/admin/blog/${post.id}`} className="font-bold text-[#0B2A4A] hover:underline">{post.title}</Link><p className="mt-1 max-w-xl truncate text-xs text-[#75869A]">/blog/{post.slug} · {post.excerpt || "Excerpt not added"}</p></td><td className="py-4 pr-4"><StatusBadge status={post.status} /></td><td className="py-4 pr-4 text-[#75869A]">{post.publishedAt ? post.publishedAt.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" }) : "—"}</td><td className="py-4 text-[#75869A]">{post.updatedAt.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" })}</td></tr>)}</tbody></table></div>
        )}
      </section>
    </div>
  );
}
