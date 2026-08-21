import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageStaff } from "@/lib/auth/page";
import { getCaseStudyEditorData, getConsentedCaseMedia } from "../../data";

export const dynamic = "force-dynamic";

export default async function CaseStudyPreviewPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageStaff("manage_marketing");
  const { id } = await params;
  const [story, media] = await Promise.all([getCaseStudyEditorData(id), getConsentedCaseMedia(id)]);
  if (!story) notFound();
  return (
    <article className="mx-auto max-w-5xl rounded-3xl bg-[#102131] p-6 text-white shadow-xl sm:p-10">
      <div className="flex items-center justify-between gap-3"><span className="rounded-full bg-[#E0A93B] px-3 py-1 text-xs font-bold uppercase text-[#0B2A4A]">Private preview</span><Link href={`/admin/results/${id}`} className="text-sm text-white/70 hover:text-white">Back to editor</Link></div>
      <h1 className="mt-8 max-w-4xl font-serif text-5xl leading-tight">{story.title}</h1>
      <p className="mt-5 max-w-3xl text-lg leading-8 text-white/75">{story.summary || "No summary yet."}</p>
      {media.length > 0 && <div className="mt-10 grid gap-4 sm:grid-cols-2">{media.map((item) => <figure key={item.id}>{/* eslint-disable-next-line @next/next/no-img-element */}<img src={mediaUrl(item)} alt={item.altText} className="aspect-[4/3] w-full rounded-2xl object-cover" /><figcaption className="mt-2 text-sm text-white/55">{item.caption || item.role}</figcaption></figure>)}</div>}
      <div className="mt-12 grid gap-8"><StoryBlock title="The challenge" body={story.challenge} /><StoryBlock title="The work" body={story.process} /><StoryBlock title="The outcome" body={story.outcome} /></div>
    </article>
  );
}

function StoryBlock({ title, body }: { title: string; body: string }) { return <section><h2 className="font-serif text-3xl">{title}</h2><p className="mt-3 whitespace-pre-line leading-7 text-white/70">{body || "Not written yet."}</p></section>; }
function mediaUrl(item: { fileId: string; contentType: string; role: string }) { const ext = item.contentType === "image/png" ? "png" : item.contentType === "image/webp" ? "webp" : "jpg"; return `/media/results/${item.fileId}/hamilton-detailing-${item.role}-${item.fileId}.${ext}`; }
