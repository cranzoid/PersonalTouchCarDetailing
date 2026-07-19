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
    <Container className="py-16">
      <SectionHeading eyebrow="FAQ" title="Frequently asked questions" />
      <div className="max-w-3xl divide-y divide-ink-800">
        {FAQS.map(([q, a]) => (
          <details key={q} className="group py-4">
            <summary className="cursor-pointer list-none text-lg font-medium text-white transition-colors hover:text-accent-300">
              {q}
            </summary>
            <p className="mt-2 text-ink-300">{a}</p>
          </details>
        ))}
      </div>
    </Container>
  );
}
