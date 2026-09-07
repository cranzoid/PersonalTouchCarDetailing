"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  publishBlogPostAction,
  saveBlogPostAction,
  unpublishBlogPostAction,
} from "./actions";

export type BlogDraft = {
  id?: string;
  slug: string;
  title: string;
  excerpt: string;
  content: string;
  seoTitle: string;
  seoDescription: string;
  status: "draft" | "published";
};

const field = "mt-1.5 w-full rounded-xl border border-[#D8E0E9] bg-white px-3.5 py-2.5 text-sm text-[#172C40] outline-none transition focus:border-[#0B2A4A] focus:ring-2 focus:ring-[#E0A93B]/35";
const label = "text-xs font-bold uppercase tracking-[0.1em] text-[#53687C]";

export function BlogEditor({ initial }: { initial: BlogDraft }) {
  const router = useRouter();
  const [post, setPost] = useState(initial);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function update<K extends keyof BlogDraft>(key: K, value: BlogDraft[K]) {
    setPost((current) => ({ ...current, [key]: value }));
  }

  function save() {
    setMessage(null);
    startTransition(async () => {
      const result = await saveBlogPostAction(post);
      if (!result.ok) return setMessage({ tone: "error", text: result.error });
      setPost((current) => ({ ...current, id: result.id }));
      setMessage({ tone: "ok", text: result.message });
      if (!initial.id) router.replace(`/admin/blog/${result.id}`);
      router.refresh();
    });
  }

  function changePublication(action: "publish" | "unpublish") {
    if (!post.id) return setMessage({ tone: "error", text: "Save the draft before publishing." });
    setMessage(null);
    startTransition(async () => {
      const result = action === "publish"
        ? await publishBlogPostAction(post.id!)
        : await unpublishBlogPostAction(post.id!);
      if (!result.ok) return setMessage({ tone: "error", text: result.error });
      setPost((current) => ({ ...current, status: action === "publish" ? "published" : "draft" }));
      setMessage({ tone: "ok", text: result.message });
      router.refresh();
    });
  }

  const titlePreview = post.seoTitle.trim() || post.title.trim() || "Article title";
  const descriptionPreview = post.seoDescription.trim() || post.excerpt.trim() || "Article description will appear here.";

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_25rem]">
      <div className="space-y-6">
        <section className="rounded-2xl border border-[#DDE4EC] bg-white p-5 shadow-sm sm:p-6">
          <div className="grid gap-5 sm:grid-cols-2">
            <label className="sm:col-span-2">
              <span className={label}>Article title</span>
              <input className={field} value={post.title} onChange={(event) => update("title", event.target.value)} placeholder="How to maintain a ceramic-coated vehicle" />
            </label>
            <label>
              <span className={label}>URL slug</span>
              <input className={field} value={post.slug} onChange={(event) => update("slug", slugify(event.target.value))} placeholder="maintain-ceramic-coated-vehicle" />
            </label>
            <div className="rounded-xl bg-[#F5F7FA] p-4 text-xs leading-5 text-[#687B8E]">
              Public URL<br /><span className="font-mono text-[#0B2A4A]">/blog/{post.slug || "article-slug"}</span>
            </div>
            <label className="sm:col-span-2">
              <span className={label}>Excerpt</span>
              <textarea className={field} rows={3} value={post.excerpt} onChange={(event) => update("excerpt", event.target.value)} placeholder="A clear summary for the blog listing and search results." />
              <span className="mt-1 block text-right text-xs text-[#8492A0]">{post.excerpt.length}/320</span>
            </label>
          </div>
        </section>

        <section className="rounded-2xl border border-[#DDE4EC] bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-lg font-bold text-[#0B2A4A]">Article body</h2>
          <p className="mt-1 text-sm leading-6 text-[#687B8E]">Use blank lines between paragraphs. Start a heading with <code>## </code> or <code>### </code>. Start each list item with <code>- </code>.</p>
          <textarea className={`${field} min-h-[34rem] font-mono leading-7`} value={post.content} onChange={(event) => update("content", event.target.value)} placeholder={"A ceramic coating makes routine care easier, but it still needs thoughtful washing.\n\n## Start with the right wash\n\n- Use a pH-neutral shampoo\n- Avoid automatic brush washes\n- Dry with a clean microfiber towel"} />
          <span className="mt-1 block text-right text-xs text-[#8492A0]">{post.content.length.toLocaleString()} characters</span>
        </section>

        <section className="rounded-2xl border border-[#DDE4EC] bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-lg font-bold text-[#0B2A4A]">Search appearance</h2>
          <div className="mt-4 grid gap-5">
            <label><span className={label}>SEO title (optional)</span><input className={field} value={post.seoTitle} onChange={(event) => update("seoTitle", event.target.value)} placeholder="Defaults to the article title" /><span className="mt-1 block text-right text-xs text-[#8492A0]">{post.seoTitle.length}/70</span></label>
            <label><span className={label}>Meta description (optional)</span><textarea className={field} rows={3} value={post.seoDescription} onChange={(event) => update("seoDescription", event.target.value)} placeholder="Defaults to the excerpt" /><span className="mt-1 block text-right text-xs text-[#8492A0]">{post.seoDescription.length}/170</span></label>
          </div>
        </section>
      </div>

      <aside className="space-y-5 xl:sticky xl:top-24 xl:self-start">
        <section className="rounded-2xl border border-[#DDE4EC] bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3"><h2 className="font-bold text-[#0B2A4A]">Publication</h2><span className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase ${post.status === "published" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>{post.status}</span></div>
          <p className="mt-4 text-sm leading-6 text-[#687B8E]">Save changes first, then publish when the article is complete. Published edits go live when saved.</p>
          <div className="mt-5 grid gap-2">
            <button type="button" disabled={pending} onClick={save} className="min-h-11 rounded-xl bg-[#0B2A4A] px-4 text-sm font-bold text-white disabled:opacity-50">{pending ? "Working…" : "Save"}</button>
            {post.status === "published"
              ? <button type="button" disabled={pending} onClick={() => changePublication("unpublish")} className="min-h-11 rounded-xl border border-[#C8D3DE] px-4 text-sm font-bold text-[#7A3140] disabled:opacity-50">Unpublish</button>
              : <button type="button" disabled={pending || !post.id} onClick={() => changePublication("publish")} className="min-h-11 rounded-xl bg-[#E0A93B] px-4 text-sm font-bold text-[#0B2A4A] disabled:opacity-50">Publish</button>}
          </div>
          {message && <p role="status" className={`mt-4 rounded-xl px-3 py-2.5 text-sm ${message.tone === "ok" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{message.text}</p>}
          {post.status === "published" && post.slug && <Link href={`/blog/${post.slug}`} target="_blank" className="mt-4 inline-flex text-xs font-bold text-[#0B2A4A] hover:underline">View live article ↗</Link>}
        </section>
        <section className="rounded-2xl border border-[#DDE4EC] bg-white p-5 shadow-sm">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#8492A0]">Search preview</p>
          <p className="mt-3 text-lg leading-6 text-[#174EA6]">{titlePreview}</p>
          <p className="mt-1 text-xs text-emerald-700">personaltouchcardetailing.com › blog › {post.slug || "article"}</p>
          <p className="mt-2 line-clamp-3 text-sm leading-5 text-[#4D5156]">{descriptionPreview}</p>
        </section>
        <section className="rounded-2xl border border-[#E5D19D] bg-[#FFF9EC] p-5 text-sm leading-6 text-[#65512A]"><strong className="block text-[#403316]">Write for drivers first</strong>Answer one real question clearly. Use accurate service claims, useful headings and original local expertise; search visibility follows.</section>
      </aside>
    </div>
  );
}

function slugify(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90);
}
