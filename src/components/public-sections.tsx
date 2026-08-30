import Image from "next/image";
import type { BusinessSettings } from "@/lib/settings";
import { servicePresentation, VERIFIED_GOOGLE_REVIEWS } from "@/lib/public-content";

function GoogleWordmark() {
  return (
    <span aria-label="Google" className="inline-flex font-sans text-base font-bold tracking-[-0.04em]">
      <span className="text-[#4285F4]">G</span>
      <span className="text-[#EA4335]">o</span>
      <span className="text-[#FBBC05]">o</span>
      <span className="text-[#4285F4]">g</span>
      <span className="text-[#34A853]">l</span>
      <span className="text-[#EA4335]">e</span>
    </span>
  );
}

function Stars({ label }: { label: string }) {
  return (
    <span aria-label={label} className="whitespace-nowrap text-[0.88rem] tracking-[0.1em] text-accent-400">
      ★★★★★
    </span>
  );
}

export function GoogleReviewStrip({
  settings,
  tone = "light",
  className = "",
}: {
  settings: BusinessSettings;
  tone?: "light" | "dark";
  className?: string;
}) {
  const dark = tone === "dark";
  const countText = settings.googleReviewCount > 0
    ? `${settings.googleReviewCount} Google reviews`
    : "Google customer reviews";

  return (
    <a
      href={settings.googleReviewUrl}
      target="_blank"
      rel="noreferrer"
      className={`group flex flex-col gap-3 rounded-2xl border px-5 py-4 transition sm:flex-row sm:items-center sm:justify-between ${
        dark
          ? "border-white/12 bg-white/[0.055] text-white hover:border-accent-400/55"
          : "border-[#DED8CE] bg-[#FFFEFB] text-[#1C2026] shadow-[0_12px_34px_rgba(11,42,74,0.07)] hover:border-accent-500/55"
      } ${className}`}
    >
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <GoogleWordmark />
        <Stars label={`${settings.googleReviewRating.toFixed(1)} out of 5 on Google`} />
        <strong className="text-sm">{settings.googleReviewRating.toFixed(1)}</strong>
        <span className={`text-sm ${dark ? "text-ink-300" : "text-slate-600"}`}>Based on {countText}</span>
      </span>
      <span className="text-sm font-semibold text-accent-500 transition group-hover:text-accent-400">
        Read our reviews <span aria-hidden="true">↗</span>
      </span>
    </a>
  );
}

export function GoogleReviewCarousel({ settings }: { settings: BusinessSettings }) {
  const reviews = [...VERIFIED_GOOGLE_REVIEWS, ...VERIFIED_GOOGLE_REVIEWS];
  return (
    <section aria-labelledby="reviews-heading" className="overflow-hidden bg-[#FFFEFB] py-16 text-[#1C2026] sm:py-20">
      <div className="mx-auto mb-9 flex w-full max-w-7xl flex-col gap-5 px-5 sm:px-8 lg:flex-row lg:items-end lg:justify-between lg:px-10">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-600">Customer feedback</p>
          <h2 id="reviews-heading" className="mt-3 font-display text-[2.75rem] leading-[1.02] tracking-[-0.025em] sm:text-[3.5rem]">
            Trusted across Hamilton.
          </h2>
        </div>
        <a href={settings.googleReviewUrl} target="_blank" rel="noreferrer" className="text-sm font-semibold text-ink-900 hover:text-accent-600">
          View all on Google <span aria-hidden="true">↗</span>
        </a>
      </div>

      <div className="review-marquee" aria-label="Selected verified Google review excerpts">
        <div className="review-marquee-track">
          {reviews.map((review, index) => (
            <article
              key={`${review.name}-${index}`}
              aria-hidden={index >= VERIFIED_GOOGLE_REVIEWS.length}
              className="w-[min(22rem,82vw)] shrink-0 rounded-[1.25rem] border border-[#DED8CE] bg-[#F8F5EE] p-6 shadow-[0_16px_42px_rgba(11,42,74,0.065)]"
            >
              <div className="flex items-center justify-between gap-4">
                <Stars label={`${review.rating} out of 5 stars`} />
                <GoogleWordmark />
              </div>
              <blockquote className="mt-5 text-[1.05rem] leading-7 text-slate-700">“{review.quote}”</blockquote>
              <p className="mt-5 border-t border-[#DED8CE] pt-4 text-sm font-semibold text-ink-900">{review.name}</p>
            </article>
          ))}
        </div>
      </div>

      <div className="mx-auto mt-8 w-full max-w-7xl px-5 sm:px-8 lg:px-10">
        <GoogleReviewStrip settings={settings} />
      </div>
    </section>
  );
}

export function ServiceImage({
  slug,
  name,
  priority = false,
  className = "",
}: {
  slug: string;
  name: string;
  priority?: boolean;
  className?: string;
}) {
  const presentation = servicePresentation(slug);
  return (
    <div className={`relative overflow-hidden bg-ink-900 ${className}`}>
      <Image
        src={presentation.image}
        alt={presentation.imageAlt || `${name} service in progress`}
        fill
        priority={priority}
        sizes="(min-width: 1024px) 50vw, 100vw"
        className="object-cover transition duration-700 group-hover:scale-[1.025]"
      />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,transparent_45%,rgba(6,26,44,0.76)_100%)]" />
    </div>
  );
}

export function CheckList({ items, tone = "dark" }: { items: readonly string[]; tone?: "dark" | "light" }) {
  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <li key={item} className={`flex gap-3 text-sm leading-6 ${tone === "dark" ? "text-ink-200" : "text-slate-700"}`}>
          <span aria-hidden="true" className="mt-[0.38rem] grid size-4 shrink-0 place-items-center rounded-full bg-accent-400 text-[0.62rem] font-black text-ink-950">✓</span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}
