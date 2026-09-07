import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { Container } from "@/components/ui";
import { db, schema } from "@/db";
import { pageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";
export const metadata = pageMetadata({
  title: "Car Detailing Advice & Guides | Personal Touch Hamilton",
  description: "Practical car detailing, interior care, paint correction and ceramic coating guidance from Personal Touch Car Detailing in Hamilton, Ontario.",
  path: "/blog",
  h1: "Car care advice from Personal Touch",
});

export default async function BlogPage() {
  const posts = await db()
    .select()
    .from(schema.blogPosts)
    .where(eq(schema.blogPosts.status, "published"))
    .orderBy(desc(schema.blogPosts.publishedAt));
  return (
    <>
      <section className="relative overflow-hidden border-b border-white/10 bg-ink-950 py-20 sm:py-28">
        <div className="pointer-events-none absolute -right-36 -top-36 size-[30rem] rounded-full border border-accent-400/15" />
        <Container className="relative">
          <p className="text-xs font-bold uppercase tracking-[0.24em] text-accent-300">From the detailing bay</p>
          <h1 className="mt-5 max-w-4xl font-display text-5xl leading-[1.02] tracking-[-0.03em] text-white sm:text-6xl">Clear advice for keeping your vehicle at its best.</h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-ink-200">Practical guides on interior care, paint protection, ceramic coating and choosing the right detailing service for your vehicle.</p>
        </Container>
      </section>
      <section className="surface-light py-20 text-ink-900 sm:py-28">
        <Container>
          {posts.length === 0 ? (
            <div className="mx-auto max-w-2xl rounded-[1.5rem] border border-[#DED8CE] bg-white px-7 py-16 text-center shadow-sm"><p className="text-xs font-bold uppercase tracking-[0.2em] text-accent-600">The first guide is being prepared</p><h2 className="mt-4 font-display text-3xl">Useful car-care advice is coming soon.</h2><p className="mt-3 text-base leading-7 text-slate-600">In the meantime, explore our service pages or ask us a question about your vehicle.</p><div className="mt-7 flex flex-wrap justify-center gap-4"><Link href="/services" className="font-bold text-[#0B2A4A] underline underline-offset-4">Explore services</Link><Link href="/contact" className="font-bold text-[#0B2A4A] underline underline-offset-4">Ask a question</Link></div></div>
          ) : (
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {posts.map((post, index) => (
                <article key={post.id} className={`group flex flex-col overflow-hidden rounded-[1.5rem] border border-[#DED8CE] bg-white shadow-[0_18px_50px_rgba(11,42,74,0.07)] ${index === 0 ? "md:col-span-2 lg:grid lg:grid-cols-[0.72fr_1.28fr]" : ""}`}>
                  <div className="relative min-h-44 overflow-hidden bg-[#0B2A4A] p-7 text-white">
                    <div className="absolute -bottom-20 -right-20 size-52 rounded-full border border-accent-400/30" />
                    <div className="absolute -bottom-10 -right-10 size-32 rounded-full border border-accent-400/25" />
                    <span className="relative text-xs font-bold uppercase tracking-[0.18em] text-accent-300">Car care guide</span>
                    <span className="relative mt-12 block font-display text-5xl text-white/10" aria-hidden="true">PT</span>
                  </div>
                  <div className="flex flex-1 flex-col p-6 sm:p-8">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">{formatDate(post.publishedAt ?? post.updatedAt)} · {readingMinutes(post.content)} min read</p>
                    <h2 className="mt-3 font-display text-3xl leading-tight text-[#0B2A4A]"><Link href={`/blog/${post.slug}`} className="transition hover:text-accent-600">{post.title}</Link></h2>
                    <p className="mt-4 line-clamp-4 text-base leading-7 text-slate-600">{post.excerpt}</p>
                    <Link href={`/blog/${post.slug}`} className="mt-auto inline-flex pt-7 text-sm font-bold text-[#0B2A4A] transition group-hover:text-accent-600">Read the guide →</Link>
                  </div>
                </article>
              ))}
            </div>
          )}
        </Container>
      </section>
    </>
  );
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric", timeZone: "America/Toronto" });
}

function readingMinutes(content: string): number {
  return Math.max(1, Math.ceil(content.trim().split(/\s+/).length / 220));
}
