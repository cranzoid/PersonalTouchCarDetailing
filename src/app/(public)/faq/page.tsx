import Link from "next/link";
import { Container, SectionHeading } from "@/components/ui";

export const metadata = { title: "FAQ" };

const FAQS: [string, string][] = [
  [
    "How long does a detail take?",
    "An express detail takes about an hour; full details typically run 4–6 hours depending on vehicle size and condition. Paint correction and coating work can take one or more full days — we'll confirm timing when we book you in.",
  ],
  [
    "How should I prepare my vehicle?",
    "Please remove personal belongings and anything valuable. If you're coming in for interior work, removing child seats ahead of time helps us reach every surface (we cannot reinstall child seats for liability reasons).",
  ],
  [
    "Why do some services require a quote first?",
    "Services like paint correction, ceramic coating, tinting and odour removal depend heavily on your vehicle's condition. A few photos let us quote accurately instead of guessing — and you avoid surprises at drop-off.",
  ],
  [
    "Do prices vary by vehicle size?",
    "Yes. Listed prices are for a standard coupe or sedan; SUVs, trucks and vans include a size adjustment that's shown transparently during online booking before you confirm.",
  ],
  [
    "What if you find something extra once you start?",
    "We'll contact you with a description, price and photos, and we only proceed with your approval. Nothing is added to your invoice without your say-so.",
  ],
  [
    "What payment methods do you accept?",
    "We accept major payment methods; details are confirmed with your booking. Some condition-dependent services may require a deposit to reserve the time.",
  ],
  [
    "What is your cancellation policy?",
    "Plans change — we get it. Please give us as much notice as you can; our current cancellation terms are on the Cancellation Policy page.",
  ],
  [
    "Are my photos and information private?",
    "Yes. Photos of your vehicle are used only for your quote, inspection record and job documentation. We never publish customer vehicle photos without your explicit consent.",
  ],
];

export default function FaqPage() {
  return (
    <Container className="py-20 sm:py-28">
      <SectionHeading
        eyebrow="Questions, answered"
        title="Everything to know before your visit"
        subtitle="Clear answers about timing, pricing, approvals and how we care for your vehicle."
      />
      <div className="grid max-w-4xl gap-3">
        {FAQS.map(([q, a]) => (
          <details key={q} className="group rounded-2xl border border-white/10 bg-white/[0.035] open:border-accent-400/35 open:bg-white/[0.055]">
            <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-5 rounded-2xl px-5 py-4 text-base font-semibold text-white transition-colors hover:text-accent-300 sm:px-6">
              <span>{q}</span>
              <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full border border-white/15 text-accent-300 transition-transform group-open:rotate-45">+</span>
            </summary>
            <p className="px-5 pb-5 pr-16 text-sm leading-7 text-ink-300 sm:px-6 sm:pb-6 sm:pr-20">{a}</p>
          </details>
        ))}
      </div>
      <div className="mt-12 border-l border-accent-400/60 pl-5 text-sm leading-6 text-ink-300">
        Still unsure which service fits? <Link href="/contact" className="font-semibold text-accent-300 hover:text-accent-400">Talk with our team</Link> and we&apos;ll point you in the right direction.
      </div>
    </Container>
  );
}
