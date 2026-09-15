/**
 * The detailing packages the public pages lead with, in the order they appear.
 *
 * Ceramic is deliberately absent: it is presented as its own group of two
 * products by `resolveCeramicMenu`, on the home page and on `/services` alike
 * (DECISIONS.md #28), so a coating package listed here would appear twice and
 * under the wrong name.
 */
export const POPULAR_SERVICE_SLUGS = [
  "complete-detail-engine",
  "the-works",
  "interior-detail",
] as const;

/**
 * The interior checklist, shared verbatim by all three detailing packages.
 *
 * It is one constant rather than three copies because the three lists ARE the
 * same promise — Ultimate and Signature add exterior work on top of an Interior
 * Detail, they do not do different interior work. Owner-set on 2026-09-16, when
 * seat shampoo left these packages and became a paid add-on: nothing here
 * claims a shampoo or a deep clean, because that is now what the extra buys.
 */
const INTERIOR_CHECKLIST = [
  "Detailed clean of seats, carpets and mats",
  "Clean, buff and polish interior surfaces",
  "Clean interior glass",
  "Disinfect air vents",
  "Vacuum trunk and refresh the cabin scent",
] as const;

export type ServicePresentation = {
  publicName: string;
  image: string;
  imageAlt: string;
  highlights: readonly string[];
  interior?: readonly string[];
  exterior?: readonly string[];
};

/**
 * Editorial presentation for the four services customers ask about most.
 * Prices, durations, booking modes and vehicle adjustments remain database-
 * driven; this map only holds customer-facing hierarchy and image choices.
 */
export const SERVICE_PRESENTATION: Record<string, ServicePresentation> = {
  "complete-detail-engine": {
    publicName: "Ultimate Detail",
    image: "/images/services/hand-wash.png",
    imageAlt: "A vehicle being carefully washed by hand inside a professional detailing bay",
    highlights: ["Complete inside-and-out reset", "Seats, carpets and mats detailed", "Engine bay fine detail"],
    interior: INTERIOR_CHECKLIST,
    exterior: [
      "Brush-free hand wash and dry",
      "Rims cleaned and tires dressed",
      "Engine bay fine detail",
    ],
  },
  "the-works": {
    publicName: "Signature Detail",
    image: "/images/detailing-studio-hero.png",
    imageAlt: "A dark blue vehicle receiving a careful professional detail",
    highlights: ["Full interior detail", "Hand-washed exterior", "Rims and tires finished"],
    interior: INTERIOR_CHECKLIST,
    exterior: [
      "Brush-free hand wash and dry",
      "Rims cleaned and tires dressed",
    ],
  },
  "interior-detail": {
    publicName: "Interior Detail",
    image: "/images/services/interior-detail.png",
    imageAlt: "A detailer deep-cleaning a vehicle seat and centre console without showing their face",
    highlights: ["Seats, carpets and mats detailed", "Surfaces cleaned and polished", "Air vents disinfected"],
    interior: INTERIOR_CHECKLIST,
    exterior: [],
  },
  "ceramic-coating-crystal": {
    publicName: "Ceramic Coating",
    image: "/images/services/ceramic-coating.png",
    imageAlt: "Gloved hands applying ceramic coating to prepared dark blue paint",
    highlights: ["Paint prepared before application", "Applied by hand, panel by panel", "Crystal, Pro and Max options"],
  },
};

export function servicePresentation(slug: string): ServicePresentation {
  if (SERVICE_PRESENTATION[slug]) return SERVICE_PRESENTATION[slug];

  if (slug.includes("ceramic") || slug.includes("paint") || slug.includes("wax")) {
    return {
      publicName: "Paint care service",
      image: "/images/services/ceramic-coating.png",
      imageAlt: "Gloved hands carrying out precise paint protection work",
      highlights: ["Vehicle-specific assessment", "Careful surface preparation", "Clear aftercare guidance"],
    };
  }

  if (slug.includes("interior") || slug.includes("rideshare")) {
    return {
      publicName: "Interior care service",
      image: "/images/services/interior-detail.png",
      imageAlt: "A detailer deep-cleaning a vehicle interior without showing their face",
      highlights: ["Condition-led cleaning", "Detailed cabin care", "Quality checked before pickup"],
    };
  }

  return {
    publicName: "Vehicle care service",
    image: "/images/services/hand-wash.png",
    imageAlt: "A dark blue vehicle being carefully washed by hand",
    highlights: ["Carefully scoped work", "Clear communication", "Quality checked before pickup"],
  };
}

/**
 * Short excerpts from the business's public Google listing, verified on
 * 2026-08-30. Keeping the excerpts local avoids inventing testimonials or
 * exposing a third-party API key in the browser.
 */
export const VERIFIED_GOOGLE_REVIEWS = [
  {
    name: "C D",
    rating: 5,
    quote: "They assured me they could remove the scratches as most were paint transfer.",
  },
  {
    name: "Nyjo C.",
    rating: 5,
    quote: "Now the Nissan Rogue looks like new.",
  },
  {
    name: "Dani O.",
    rating: 5,
    quote: "Highly recommended. I am so happy—thanks for the amazing job.",
  },
] as const;

