"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import type { CaseStudyMediaRole } from "@/lib/case-studies";
import {
  publishCaseStudyAction,
  saveCaseStudyAction,
  unpublishCaseStudyAction,
} from "./actions";

type ServiceOption = { id: string; name: string };
type PhotoOption = {
  id: string;
  kind: string;
  contentType: string;
  createdAt: string;
};
type MediaDraft = {
  fileId: string;
  role: CaseStudyMediaRole;
  caption: string;
  altText: string;
  sort: number;
};
type StoryDraft = {
  id?: string;
  slug: string;
  title: string;
  summary: string;
  challenge: string;
  process: string;
  outcome: string;
  primaryServiceId: string;
  relatedServiceIds: string[];
  media: MediaDraft[];
  consentConfirmed: boolean;
  privacyChecked: boolean;
  status: "draft" | "published";
};

const field = "mt-1.5 w-full rounded-xl border border-[#D8E0E9] bg-white px-3.5 py-2.5 text-sm text-[#172C40] outline-none transition focus:border-[#0B2A4A] focus:ring-2 focus:ring-[#E0A93B]/35";
const label = "text-xs font-bold uppercase tracking-[0.1em] text-[#53687C]";

export function CaseStudyEditor({
  initial,
  services,
  photos,
}: {
  initial: StoryDraft;
  services: ServiceOption[];
  photos: PhotoOption[];
}) {
  const router = useRouter();
  const [story, setStory] = useState(initial);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const selectedIds = useMemo(() => new Set(story.media.map((item) => item.fileId)), [story.media]);

  function update<K extends keyof StoryDraft>(key: K, value: StoryDraft[K]) {
    setStory((current) => ({ ...current, [key]: value }));
  }

  function togglePhoto(photo: PhotoOption) {
    if (selectedIds.has(photo.id)) {
      update("media", story.media.filter((item) => item.fileId !== photo.id));
      return;
    }
    update("media", [...story.media, {
      fileId: photo.id,
      role: photo.kind === "before" ? "before" : photo.kind === "after" ? "after" : "result",
      caption: "",
      altText: `Customer-approved ${photo.kind.replaceAll("_", " ")} view from this Hamilton detailing project`,
      sort: story.media.length,
    }]);
  }

  function updateMedia(fileId: string, patch: Partial<MediaDraft>) {
    update("media", story.media.map((item) => item.fileId === fileId ? { ...item, ...patch } : item));
  }

  function save() {
    setMessage(null);
    startTransition(async () => {
      const result = await saveCaseStudyAction({ ...story, media: story.media.map((item, index) => ({ ...item, sort: index })) });
      if (!result.ok) {
        setMessage({ tone: "error", text: result.error });
        return;
      }
      setStory((current) => ({ ...current, id: result.id }));
      setMessage({ tone: "ok", text: result.message ?? "Saved." });
      if (!initial.id) router.replace(`/admin/results/${result.id}`);
      router.refresh();
    });
  }

  function changePublication(action: "publish" | "unpublish") {
    if (!story.id) {
      setMessage({ tone: "error", text: "Save the draft before publishing." });
      return;
    }
    setMessage(null);
    startTransition(async () => {
      const result = action === "publish"
        ? await publishCaseStudyAction(story.id!)
        : await unpublishCaseStudyAction(story.id!);
      if (!result.ok) {
        setMessage({ tone: "error", text: result.error });
        return;
      }
      setStory((current) => ({ ...current, status: action === "publish" ? "published" : "draft" }));
      setMessage({ tone: "ok", text: result.message ?? "Updated." });
      router.refresh();
    });
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_25rem]">
      <div className="space-y-6">
        <section className="rounded-2xl border border-[#DDE4EC] bg-white p-5 shadow-sm sm:p-6">
          <div className="grid gap-5 sm:grid-cols-2">
            <label className="sm:col-span-2">
              <span className={label}>Case-study title</span>
              <input className={field} value={story.title} onChange={(event) => update("title", event.target.value)} placeholder="Winter interior reset for a daily driver" />
            </label>
            <label>
              <span className={label}>URL slug</span>
              <input className={field} value={story.slug} onChange={(event) => update("slug", slugify(event.target.value))} placeholder="winter-interior-reset" />
            </label>
            <label>
              <span className={label}>Primary service</span>
              <select className={field} value={story.primaryServiceId} onChange={(event) => update("primaryServiceId", event.target.value)}>
                <option value="">Choose a service</option>
                {services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}
              </select>
            </label>
            <label className="sm:col-span-2">
              <span className={label}>Summary</span>
              <textarea className={field} rows={3} value={story.summary} onChange={(event) => update("summary", event.target.value)} placeholder="A concise, factual overview for result cards and search snippets." />
            </label>
            <StorySection title="Starting condition and challenge" value={story.challenge} onChange={(value) => update("challenge", value)} placeholder="What condition was the vehicle in, and what did the owner want addressed?" />
            <StorySection title="Work performed" value={story.process} onChange={(value) => update("process", value)} placeholder="Describe the verified process, products where appropriate, and condition-dependent decisions." />
            <StorySection title="Outcome and maintenance guidance" value={story.outcome} onChange={(value) => update("outcome", value)} placeholder="Describe the realistic result, limitations and practical aftercare." />
          </div>
        </section>

        <section className="rounded-2xl border border-[#DDE4EC] bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-lg font-bold text-[#0B2A4A]">Related services</h2>
          <p className="mt-1 text-sm text-[#687B8E]">These become contextual links on the public story.</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {services.filter((service) => service.id !== story.primaryServiceId).map((service) => (
              <label key={service.id} className="flex items-center gap-3 rounded-xl border border-[#E2E8EF] px-3 py-2.5 text-sm text-[#42566A]">
                <input type="checkbox" checked={story.relatedServiceIds.includes(service.id)} onChange={(event) => update("relatedServiceIds", event.target.checked ? [...story.relatedServiceIds, service.id] : story.relatedServiceIds.filter((id) => id !== service.id))} />
                {service.name}
              </label>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-[#DDE4EC] bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-lg font-bold text-[#0B2A4A]">Customer-approved media</h2>
          <p className="mt-1 text-sm text-[#687B8E]">Only currently consented JPEG, PNG and WebP job images appear here. Revoking consent removes the public image immediately.</p>
          {photos.length === 0 ? (
            <p className="mt-4 rounded-xl bg-[#F5F7FA] p-5 text-sm text-[#63778B]">No browser-ready photos currently have public consent.</p>
          ) : (
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              {photos.map((photo) => {
                const selected = story.media.find((item) => item.fileId === photo.id);
                return (
                  <div key={photo.id} className={`rounded-2xl border p-3 ${selected ? "border-[#E0A93B] bg-[#FFF9EC]" : "border-[#E0E6ED]"}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={mediaUrl(photo)} alt="" className="aspect-[4/3] w-full rounded-xl bg-[#EDF1F5] object-cover" />
                    <label className="mt-3 flex items-center gap-2 text-sm font-semibold text-[#263E54]">
                      <input type="checkbox" checked={Boolean(selected)} onChange={() => togglePhoto(photo)} />
                      Include this {photo.kind.replaceAll("_", " ")} image
                    </label>
                    {selected && (
                      <div className="mt-3 space-y-3 border-t border-[#E8D6A9] pt-3">
                        <label className="block">
                          <span className={label}>Role</span>
                          <select className={field} value={selected.role} onChange={(event) => updateMedia(photo.id, { role: event.target.value as CaseStudyMediaRole })}>
                            <option value="before">Before</option><option value="after">After</option><option value="result">Result</option>
                          </select>
                        </label>
                        <label className="block"><span className={label}>Accurate alt text</span><textarea className={field} rows={2} value={selected.altText} onChange={(event) => updateMedia(photo.id, { altText: event.target.value })} /></label>
                        <label className="block"><span className={label}>Visible caption</span><textarea className={field} rows={2} value={selected.caption} onChange={(event) => updateMedia(photo.id, { caption: event.target.value })} /></label>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <aside className="space-y-5 xl:sticky xl:top-24 xl:self-start">
        <section className="rounded-2xl border border-[#DDE4EC] bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-bold text-[#0B2A4A]">Publish checklist</h2>
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase ${story.status === "published" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>{story.status}</span>
          </div>
          <label className="mt-5 flex items-start gap-3 text-sm leading-5 text-[#42566A]">
            <input className="mt-1" type="checkbox" checked={story.consentConfirmed} onChange={(event) => update("consentConfirmed", event.target.checked)} />
            <span>I verified that the customer granted separate marketing consent for every selected image.</span>
          </label>
          <label className="mt-4 flex items-start gap-3 text-sm leading-5 text-[#42566A]">
            <input className="mt-1" type="checkbox" checked={story.privacyChecked} onChange={(event) => update("privacyChecked", event.target.checked)} />
            <span>I checked that plates, VINs, names, addresses and other identifying details are absent.</span>
          </label>
          <div className="mt-5 grid gap-2">
            <button disabled={pending} onClick={save} className="min-h-11 rounded-xl bg-[#0B2A4A] px-4 text-sm font-bold text-white disabled:opacity-50">{pending ? "Working…" : "Save draft"}</button>
            {story.status === "published" ? (
              <button disabled={pending} onClick={() => changePublication("unpublish")} className="min-h-11 rounded-xl border border-[#C8D3DE] px-4 text-sm font-bold text-[#7A3140] disabled:opacity-50">Unpublish</button>
            ) : (
              <button disabled={pending || !story.id} onClick={() => changePublication("publish")} className="min-h-11 rounded-xl bg-[#E0A93B] px-4 text-sm font-bold text-[#0B2A4A] disabled:opacity-50">Publish</button>
            )}
          </div>
          {message && <p role="status" className={`mt-4 rounded-xl px-3 py-2.5 text-sm ${message.tone === "ok" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{message.text}</p>}
          {story.id && (
            <div className="mt-4 flex flex-wrap gap-3 text-xs font-semibold">
              <Link href={`/admin/results/${story.id}/preview`} target="_blank" className="text-[#0B2A4A] hover:underline">Preview draft ↗</Link>
              {story.status === "published" && <Link href={`/results/${story.slug}`} target="_blank" className="text-[#0B2A4A] hover:underline">View live ↗</Link>}
            </div>
          )}
        </section>
        <section className="rounded-2xl border border-[#E5D19D] bg-[#FFF9EC] p-5 text-sm leading-6 text-[#65512A]">
          <strong className="block text-[#403316]">Before publishing</strong>
          Keep claims factual and specific to the documented job. Do not identify the customer or promise the same result for every vehicle.
        </section>
      </aside>
    </div>
  );
}

function StorySection({ title, value, onChange, placeholder }: { title: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label className="sm:col-span-2"><span className={label}>{title}</span><textarea className={field} rows={6} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>;
}

function slugify(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function mediaUrl(photo: Pick<PhotoOption, "id" | "kind" | "contentType">): string {
  const extension = photo.contentType === "image/png" ? "png" : photo.contentType === "image/webp" ? "webp" : "jpg";
  return `/media/results/${photo.id}/hamilton-car-detailing-${slugify(photo.kind)}-${photo.id}.${extension}`;
}
