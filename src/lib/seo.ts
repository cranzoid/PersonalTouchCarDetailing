import type { Metadata } from "next";

export const PUBLIC_SITE_URL = (
  process.env.PUBLIC_SITE_URL ?? "https://www.personaltouchcardetailing.ca"
).replace(/\/$/, "");

export const BUSINESS_ENTITY_ID = `${PUBLIC_SITE_URL}/#business`;
export const WEBSITE_ENTITY_ID = `${PUBLIC_SITE_URL}/#website`;

export type SeoPageDefinition = {
  title: string;
  description: string;
  path: `/${string}` | "/";
  h1: string;
  image?: string;
  noIndex?: boolean;
};

export const SEO_PAGES = {
  home: {
    title: "Car Detailing Hamilton, ON | Personal Touch Car Detailing",
    description:
      "Professional car detailing in Hamilton, Ontario, including interior detailing, paint correction, ceramic coating, PPF and tint removal or replacement. Book online or request a quote.",
    path: "/",
    h1: "Hamilton car detailing, finished with precision",
  },
  services: {
    title: "Car Detailing Services Hamilton, ON | Personal Touch",
    description:
      "Compare car detailing packages, interior cleaning, paint correction, ceramic coating, PPF, tint removal and vehicle styling services in Hamilton.",
    path: "/services",
    h1: "Car detailing services in Hamilton",
  },
  about: {
    title: "About Our Hamilton Detailing Studio | Personal Touch",
    description:
      "Learn how Personal Touch Car Detailing approaches vehicle care, transparent approvals and quality control at our Upper James Street studio in Hamilton.",
    path: "/about",
    h1: "A Hamilton detailing studio built around careful work",
  },
  gallery: {
    title: "Car Detailing Results in Hamilton | Personal Touch",
    description:
      "See customer-approved photos of real detailing, correction and vehicle-care results completed by Personal Touch Car Detailing in Hamilton.",
    path: "/gallery",
    h1: "Real car detailing results from Hamilton vehicles",
  },
  reviews: {
    title: "Customer Reviews | Personal Touch Car Detailing Hamilton",
    description:
      "Read and leave verified feedback for Personal Touch Car Detailing in Hamilton, Ontario, and learn about our transparent customer-care process.",
    path: "/reviews",
    h1: "Customer feedback from our Hamilton detailing studio",
  },
  faq: {
    title: "Car Detailing FAQ | Personal Touch Hamilton",
    description:
      "Answers about car detailing time, pricing, vehicle preparation, paint correction, coatings, tint removal, approvals and privacy in Hamilton.",
    path: "/faq",
    h1: "Car detailing questions, answered",
  },
  fleet: {
    title: "Fleet Vehicle Detailing Hamilton, ON | Personal Touch",
    description:
      "Recurring fleet and commercial vehicle detailing in Hamilton with priority scheduling, service records and consolidated invoicing.",
    path: "/fleet",
    h1: "Fleet and commercial vehicle detailing in Hamilton",
  },
  contact: {
    title: "Contact Personal Touch Car Detailing | Hamilton, ON",
    description:
      "Contact or visit Personal Touch Car Detailing at 2481 Upper James Street in Hamilton for detailing, coating, PPF, tint removal or fleet-service questions.",
    path: "/contact",
    h1: "Contact our Hamilton car detailing studio",
  },
  book: {
    title: "Book Car Detailing in Hamilton | Personal Touch",
    description:
      "Book a car detailing appointment in Hamilton online. Choose your service and vehicle, see clear pricing and select an available appointment time.",
    path: "/book",
    h1: "Book car detailing in Hamilton",
  },
  quote: {
    title: "Request a Car Detailing Quote in Hamilton | Personal Touch",
    description:
      "Request a Hamilton quote for ceramic coating, paint correction, PPF, tint removal, wraps or condition-dependent car detailing work.",
    path: "/quote",
    h1: "Request a car detailing quote in Hamilton",
  },
  results: {
    title: "Car Detailing Case Studies Hamilton | Personal Touch",
    description:
      "Explore real, customer-approved car detailing results from Hamilton, including the vehicle condition, work completed and aftercare guidance.",
    path: "/results",
    h1: "Car detailing case studies from Hamilton",
  },
  privacy: {
    title: "Privacy Policy | Personal Touch Car Detailing",
    description:
      "How Personal Touch Car Detailing collects, uses, protects and deletes customer information and vehicle photos.",
    path: "/policies/privacy",
    h1: "Privacy Policy",
  },
  cancellation: {
    title: "Cancellation Policy | Personal Touch Car Detailing",
    description:
      "Appointment cancellation and rescheduling terms for Personal Touch Car Detailing in Hamilton, Ontario.",
    path: "/policies/cancellation",
    h1: "Cancellation Policy",
  },
  terms: {
    title: "Service Terms | Personal Touch Car Detailing",
    description:
      "Service, estimate, vehicle-condition and payment terms for Personal Touch Car Detailing in Hamilton, Ontario.",
    path: "/policies/terms",
    h1: "Service Terms",
  },
  connect: {
    title: "Connect | Personal Touch Car Detailing",
    description:
      "Booking, services, results, directions and contact links for Personal Touch Car Detailing in Hamilton.",
    path: "/connect",
    h1: "Connect with Personal Touch Car Detailing",
    noIndex: true,
  },
} as const satisfies Record<string, SeoPageDefinition>;

export function absoluteUrl(path: string): string {
  return new URL(path, `${PUBLIC_SITE_URL}/`).toString();
}

export function pageMetadata(definition: SeoPageDefinition): Metadata {
  const image = definition.image ?? "/og.png";
  return {
    title: { absolute: definition.title },
    description: definition.description,
    alternates: { canonical: definition.path },
    robots: definition.noIndex
      ? { index: false, follow: true, nocache: true }
      : { index: true, follow: true },
    openGraph: {
      type: "website",
      locale: "en_CA",
      siteName: "Personal Touch Car Detailing",
      title: definition.title,
      description: definition.description,
      url: definition.path,
      images: [
        {
          url: image,
          width: 1200,
          height: 628,
          alt: `${definition.h1} — Personal Touch Car Detailing`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: definition.title,
      description: definition.description,
      images: [image],
    },
  };
}

export function isSeoIndexable(): boolean {
  return process.env.SEO_INDEXABLE === "true";
}

export function slugifySeoText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
