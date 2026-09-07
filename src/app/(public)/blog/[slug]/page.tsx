import Link from "next/link";
import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { ButtonLink, Container } from "@/components/ui";
import { StructuredData } from "@/components/structured-data";
import { db, schema } from "@/db";
import { absoluteUrl, BUSINESS_ENTITY_ID, pageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const [post] = await db()
    .select()
    .from(schema.blogPosts)
    .where(eq(schema.blogPosts.slug, slug))
    .limit(1);
  if (!post || post.status !== "published") return pageMetadata({ title: "Article not found | Personal Touch", description: "This article is not available.", path: `/blog/${slug}`, h1: "Article not found", noIndex: true });
  return pageMetadata({
    title: post.seoTitle || `${post.title} | Personal Touch Hamilton`,
    description: post.seoDescription || post.excerpt,
    path: `/blog/${post.slug}`,
    h1: post.title,
  });
}

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [post] = await db().select().from(schema.blogPosts).where(eq(schema.blogPosts.slug, slug)).limit(1);
  if (!post || post.status !== "published") notFound();
  const published = post.publishedAt ?? post.updatedAt;
  const articleSchema = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: post.title,
    description: post.seoDescription || post.excerpt,
    datePublished: published.toISOString(),
    dateModified: post.updatedAt.toISOString(),
    mainEntityOfPage: absoluteUrl(`/blog/${post.slug}`),
    author: { "@id": BUSINESS_ENTITY_ID },
    publisher: { "@id": BUSINESS_ENTITY_ID },
  };
  return (
    <>
      <StructuredData data={articleSchema} />
      <article>
        <header className="relative overflow-hidden border-b border-white/10 bg-ink-950 py-16 sm:py-24">
          <div className="pointer-events-none absolute -right-40 -top-40 size-[34rem] rounded-full border border-accent-400/15" />
          <Container className="relative max-w-5xl">
            <nav aria-label="Breadcrumb" className="text-sm text-ink-400"><Link href="/">Home</Link> <span aria-hidden="true">/</span> <Link href="/blog">Blog</Link> <span aria-hidden="true">/</span> <span className="text-ink-200">{post.title}</span></nav>
            <p className="mt-12 text-xs font-bold uppercase tracking-[0.2em] text-accent-300">Car care guide · {formatDate(published)} · {readingMinutes(post.content)} min read</p>
            <h1 className="mt-5 max-w-4xl font-display text-5xl leading-[1.02] tracking-[-0.03em] text-white sm:text-6xl">{post.title}</h1>
            <p className="mt-6 max-w-3xl text-lg leading-8 text-ink-200">{post.excerpt}</p>
          </Container>
        </header>
        <section className="surface-light py-16 text-ink-900 sm:py-24">
          <Container className="max-w-5xl">
            <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_16rem] lg:items-start">
              <div className="min-w-0">{renderArticle(post.content)}</div>
              <aside className="rounded-[1.5rem] border border-[#DED8CE] bg-[#F6F2EA] p-6 lg:sticky lg:top-28"><p className="text-xs font-bold uppercase tracking-[0.18em] text-accent-600">Need help choosing?</p><h2 className="mt-3 font-display text-2xl text-[#0B2A4A]">Tell us what your vehicle needs.</h2><p className="mt-3 text-sm leading-6 text-slate-600">We can recommend a listed service or provide a condition-based estimate.</p><div className="mt-5 grid gap-2"><ButtonLink href="/book">Book online</ButtonLink><ButtonLink href="/quote" variant="outline" className="!border-[#0B2A4A]/20 !text-[#0B2A4A]">Request a quote</ButtonLink></div></aside>
            </div>
            <div className="mt-16 border-t border-[#DED8CE] pt-8"><Link href="/blog" className="font-bold text-[#0B2A4A] hover:text-accent-600">← Back to all guides</Link></div>
          </Container>
        </section>
      </article>
    </>
  );
}

function renderArticle(content: string) {
  const blocks = content.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  return <div className="space-y-6">{blocks.map((block, index) => {
    if (block.startsWith("### ")) return <h3 key={index} className="pt-4 font-display text-2xl text-[#0B2A4A]">{block.slice(4)}</h3>;
    if (block.startsWith("## ")) return <h2 key={index} className="pt-6 font-display text-3xl text-[#0B2A4A] sm:text-4xl">{block.slice(3)}</h2>;
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length > 0 && lines.every((line) => line.startsWith("- "))) {
      return <ul key={index} className="space-y-3 pl-1 text-[1.05rem] leading-8 text-slate-700">{lines.map((line, lineIndex) => <li key={lineIndex} className="flex gap-3"><span className="mt-3 size-1.5 shrink-0 rounded-full bg-accent-500" aria-hidden="true" /><span>{line.slice(2)}</span></li>)}</ul>;
    }
    return <p key={index} className="whitespace-pre-line text-[1.05rem] leading-8 text-slate-700">{block}</p>;
  })}</div>;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric", timeZone: "America/Toronto" });
}

function readingMinutes(content: string): number {
  return Math.max(1, Math.ceil(content.trim().split(/\s+/).length / 220));
}
